/**
 * Identifier minting.
 *
 * Two flavours, both needed:
 *  - random ids for things that simply need to be distinct (a decision, an entry)
 *  - deterministic ids for things that must be idempotent across retries
 *    (an execution keyed by an idempotency key, a grant keyed by subject+offer)
 *
 * An `IdFactory` is injected rather than imported so tests can make the whole
 * platform deterministic, which is what lets us assert on audit hashes.
 */
import { hashValue, randomUUID } from "./hash.ts";

export interface IdFactory {
  /** A fresh identifier with the given prefix, e.g. `vx_9f2c...`. */
  next(prefix: string): string;
  /** A stable identifier derived from its inputs. Same inputs, same id. */
  derive(prefix: string, ...parts: unknown[]): string;
}

export function randomIdFactory(): IdFactory {
  return {
    next: (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    derive: (prefix, ...parts) => `${prefix}_${hashValue(parts).slice(0, 24)}`,
  };
}

/** Deterministic ids for tests: a counter per prefix. */
export function sequentialIdFactory(): IdFactory {
  const counters = new Map<string, number>();
  return {
    next: (prefix) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${String(n).padStart(6, "0")}`;
    },
    derive: (prefix, ...parts) => `${prefix}_${hashValue(parts).slice(0, 24)}`,
  };
}

/**
 * Uniform resource name for any platform object.
 * `urn:goip:<tenant>:<kind>:<id>` - used in audit records and cross-tenant refs.
 */
export function urn(tenant: string, kind: string, id: string): string {
  return `urn:goip:${tenant}:${kind}:${id}`;
}

export function parseUrn(value: string): { tenant: string; kind: string; id: string } | null {
  const parts = value.split(":");
  if (parts.length !== 5 || parts[0] !== "urn" || parts[1] !== "goip") return null;
  const [, , tenant, kind, id] = parts;
  if (!tenant || !kind || !id) return null;
  return { tenant, kind, id };
}
