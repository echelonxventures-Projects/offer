/**
 * Authentication.
 *
 * A port and two reference implementations, both on `node:crypto` - no JWT
 * library, no OAuth client, no dependency. A deployment that wants OIDC writes
 * an adapter; the platform does not need to know.
 *
 * Two rules the reference implementations follow and any adapter must:
 *
 *   - Secrets are compared in constant time. A byte-by-byte comparison leaks
 *     the secret through timing, slowly but reliably.
 *   - Secrets are never stored in plaintext and never appear in an error,
 *     a log line or an audit record.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import { sha256 } from "../kernel/hash.ts";
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";
import type { Credentials, Principal } from "./principal.ts";

export interface Authenticator extends RegistryEntry {
  /** The scheme this handles, e.g. "apikey". */
  readonly scheme: string;
  authenticate(credentials: Credentials): Promise<Result<Principal>>;
}

/** Constant-time string comparison. Length differences are masked. */
export function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(sha256(a), "hex");
  const right = Buffer.from(sha256(b), "hex");
  return timingSafeEqual(left, right);
}

/* ------------------------------------------------------------------ *
 * API keys
 * ------------------------------------------------------------------ */

export interface ApiKeyRecord {
  /** Public identifier, safe to log. */
  readonly id: string;
  /** sha256 of the secret. The secret itself is never stored. */
  readonly secretHash: string;
  readonly label?: string;
  readonly tenants: readonly string[];
  readonly roles: readonly string[];
  /** Instant tick as a string; absent means it does not expire. */
  readonly expiresAt?: string;
  readonly revoked?: boolean;
}

export interface ApiKeyStore {
  find(id: string): Promise<ApiKeyRecord | undefined>;
}

/** In-memory key store. A real one reads from the database. */
export class MemoryApiKeyStore implements ApiKeyStore {
  readonly #keys = new Map<string, ApiKeyRecord>();

  async find(id: string): Promise<ApiKeyRecord | undefined> {
    return this.#keys.get(id);
  }

  /**
   * Issue a key. The secret is returned **once** and only the hash is kept, so
   * a compromised key store cannot be used to authenticate.
   */
  issue(record: Omit<ApiKeyRecord, "secretHash">): { record: ApiKeyRecord; secret: string } {
    const secret = randomBytes(32).toString("base64url");
    const stored: ApiKeyRecord = { ...record, secretHash: sha256(secret) };
    this.#keys.set(record.id, stored);
    return { record: stored, secret };
  }

  revoke(id: string): void {
    const existing = this.#keys.get(id);
    if (existing) this.#keys.set(id, { ...existing, revoked: true });
  }
}

export interface ApiKeyAuthenticatorOptions {
  readonly store: ApiKeyStore;
  /** Current instant tick, for expiry. Injected so tests are deterministic. */
  readonly now?: () => bigint;
}

/**
 * `apikey <id>.<secret>`
 *
 * The id travels in the clear so a failed lookup can be logged without leaking
 * anything; only the secret half is sensitive.
 */
export function apiKeyAuthenticator(options: ApiKeyAuthenticatorOptions): Authenticator {
  return {
    key: "apikey",
    label: "API key",
    scheme: "apikey",
    description: "An opaque key, stored hashed and compared in constant time.",
    async authenticate(credentials) {
      const token = credentials.token ?? "";
      const separator = token.indexOf(".");
      if (separator <= 0) {
        return fail(ErrorCode.FORBIDDEN, "malformed API key");
      }

      const id = token.slice(0, separator);
      const secret = token.slice(separator + 1);
      const record = await options.store.find(id);

      // A missing key and a wrong secret produce the same error, and the
      // comparison still runs, so the two are not distinguishable by timing.
      const expectedHash = record?.secretHash ?? sha256("never-matches");
      const matches = secureEquals(sha256(secret), expectedHash);

      if (!record || !matches || record.revoked) {
        return fail(ErrorCode.FORBIDDEN, "invalid API key", { keyId: id });
      }
      if (record.expiresAt !== undefined && options.now && BigInt(record.expiresAt) <= options.now()) {
        return fail(ErrorCode.FORBIDDEN, "API key has expired", { keyId: id });
      }

      return ok({
        id: record.id,
        ...(record.label === undefined ? {} : { label: record.label }),
        tenants: record.tenants,
        roles: record.roles,
        method: "apikey",
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * HMAC bearer tokens
 * ------------------------------------------------------------------ */

export interface HmacTokenOptions {
  readonly secret: string;
  readonly now?: () => bigint;
  /** Accepted clock skew when validating expiry, in milliseconds. */
  readonly skewMs?: number;
}

export interface HmacClaims {
  readonly sub: string;
  readonly tenants: readonly string[];
  readonly roles: readonly string[];
  /** Expiry as an instant tick string. */
  readonly exp?: string;
  readonly label?: string;
}

/**
 * Mint a signed token: `base64url(claims).base64url(hmac)`.
 *
 * Deliberately not JWT. JWT's algorithm agility is its most exploited feature -
 * `alg: none` and RS/HS confusion are both live attacks - and this needs one
 * algorithm, fixed. A deployment that must accept JWTs writes an adapter and
 * owns that decision explicitly.
 */
export function signHmacToken(claims: HmacClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function hmacAuthenticator(options: HmacTokenOptions): Authenticator {
  return {
    key: "hmac",
    label: "HMAC bearer token",
    scheme: "bearer",
    description: "A signed claims token. One algorithm, fixed: no algorithm negotiation.",
    async authenticate(credentials) {
      const token = credentials.token ?? "";
      const separator = token.lastIndexOf(".");
      if (separator <= 0) return fail(ErrorCode.FORBIDDEN, "malformed token");

      const body = token.slice(0, separator);
      const signature = token.slice(separator + 1);
      const expected = createHmac("sha256", options.secret).update(body).digest("base64url");

      if (!secureEquals(signature, expected)) {
        return fail(ErrorCode.FORBIDDEN, "token signature does not verify");
      }

      let claims: HmacClaims;
      try {
        claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as HmacClaims;
      } catch {
        return fail(ErrorCode.FORBIDDEN, "token claims are not readable");
      }

      if (claims.exp !== undefined && options.now) {
        const skew = BigInt(options.skewMs ?? 0);
        if (BigInt(claims.exp) + skew <= options.now()) {
          return fail(ErrorCode.FORBIDDEN, "token has expired");
        }
      }
      if (!claims.sub || !Array.isArray(claims.tenants) || !Array.isArray(claims.roles)) {
        return fail(ErrorCode.FORBIDDEN, "token is missing required claims");
      }

      return ok({
        id: claims.sub,
        ...(claims.label === undefined ? {} : { label: claims.label }),
        tenants: claims.tenants,
        roles: claims.roles,
        method: "hmac",
      });
    },
  };
}

export function authenticatorRegistry(): Registry<Authenticator> {
  return new Registry<Authenticator>("authenticator");
}
