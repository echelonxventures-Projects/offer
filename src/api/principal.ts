/**
 * Who is calling.
 *
 * Until now every capability took an `actor` string out of the request body and
 * believed it. That is the largest gap this platform has had: anyone who could
 * reach `redeem` could grant themselves benefits and attribute them to somebody
 * else.
 *
 * A `Principal` is what an `Authenticator` produces from credentials. The
 * gateway then *overrides* `actor` and `tenant` from it, so the body can no
 * longer influence either.
 */
import type { RegistryEntry } from "../registry/registry.ts";

export interface Principal {
  /** Stable identifier. Becomes `actor` on every audit record. */
  readonly id: string;
  /** Human-readable, for consoles. Never used for authorisation. */
  readonly label?: string;
  /**
   * Tenants this principal may act for. A single-tenant key lists one.
   * `"*"` is permitted but should be rare and is called out in the audit trail.
   */
  readonly tenants: readonly string[];
  /** Role keys. Authorisation resolves these against the role registry. */
  readonly roles: readonly string[];
  /** How this principal was authenticated, for the audit record. */
  readonly method: string;
  /** Free-form, non-authoritative. Never consulted for access decisions. */
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * Credentials as they arrive, before any transport has interpreted them.
 *
 * Deliberately not "an HTTP request": the gateway must work under a queue
 * consumer, a gRPC service or a test harness without pretending to be HTTP.
 */
export interface Credentials {
  /** Scheme name, e.g. "apikey", "hmac", "bearer". */
  readonly scheme?: string;
  /** The credential material. Never logged. */
  readonly token?: string;
  /** Additional transport-supplied fields an authenticator may need. */
  readonly parameters?: Readonly<Record<string, string>>;
}

/**
 * A role: a named set of capabilities.
 *
 * Roles are a registry rather than an enum because who may do what is a
 * deployment's decision, and the shipped set is a starting point rather than a
 * policy.
 */
export interface Role extends RegistryEntry {
  /**
   * Capability keys this role may invoke. `"*"` grants all of them, which
   * should be rare - `platform.admin` exists so that it is explicit rather
   * than accidental.
   */
  readonly capabilities: readonly string[];
}

/** Principals that are not people. Useful for reasoning about blast radius. */
export const SYSTEM_PRINCIPAL: Principal = {
  id: "system",
  label: "Platform maintenance",
  tenants: ["*"],
  roles: ["platform.maintenance"],
  method: "internal",
};

/** Used only where a capability genuinely has no caller, e.g. a scheduled job. */
export const isSystem = (principal: Principal): boolean => principal.method === "internal";
