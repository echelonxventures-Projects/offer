/**
 * Audit records and the hash chain that links them.
 *
 * Append-only, hash-chained: each record carries the hash of the one before it,
 * so an edit or a deletion anywhere invalidates every hash after it and
 * `verify()` says exactly where.
 *
 * This is tamper *evidence*, not tamper proofing: anyone who can rewrite the
 * whole chain can still forge it. Pair it with periodic external anchoring of
 * the head hash - see docs/07-operations/03-security.md.
 *
 * Storage lives in the adapters. This module owns only the shape and the
 * hashing rule, so every adapter and every re-implementation in another
 * language produces byte-identical hashes for identical content.
 */
import type { Json } from "../kernel/types.ts";
import { GENESIS_HASH, chainHash } from "../kernel/hash.ts";

export const AUDIT_KINDS = [
  "value_exchange.created",
  "value_exchange.published",
  "value_exchange.transitioned",
  "grant.issued",
  "grant.activated",
  "grant.revoked",
  "decision.made",
  "execution.reserved",
  "execution.captured",
  "execution.released",
  "execution.reversed",
  "execution.reaped",
  "settlement.posted",
  "payout.requested",
  "governance.rejected",
  "registry.changed",
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditRecord {
  readonly seq: number;
  readonly tenant: string;
  readonly reality: string;
  readonly kind: AuditKind | string;
  /** What the record is about. */
  readonly subject: { readonly kind: string; readonly id: string };
  /** Who or what caused it. */
  readonly actor: string;
  readonly at: string;
  readonly correlationId?: string;
  /** The payload. Canonicalised before hashing, so key order cannot matter. */
  readonly payload: Json;
  /** Hash of the previous record in this tenant's chain. */
  readonly previousHash: string;
  /** chainHash(previousHash, everything above). */
  readonly hash: string;
}

export type AuditDraft = Omit<AuditRecord, "seq" | "previousHash" | "hash">;

/** Compute the hash for a record. Exported so any verifier can recompute it. */
export function computeHash(previousHash: string, record: Omit<AuditRecord, "hash">): string {
  return chainHash(previousHash, record);
}

/** Seal a draft into the chain at `seq`, following `previousHash`. */
export function sealRecord(draft: AuditDraft, seq: number, previousHash: string): AuditRecord {
  const withoutHash: Omit<AuditRecord, "hash"> = { ...draft, seq, previousHash };
  return { ...withoutHash, hash: computeHash(previousHash, withoutHash) };
}

/**
 * Verify an ordered run of records against a starting hash.
 * Returns the sequence number of the first broken record, or null if intact.
 */
export function findChainBreak(
  records: readonly AuditRecord[],
  startingHash: string = GENESIS_HASH,
): { seq: number; reason: "link" | "content"; expected: string; found: string } | null {
  let previousHash = startingHash;
  for (const record of records) {
    if (record.previousHash !== previousHash) {
      return { seq: record.seq, reason: "link", expected: previousHash, found: record.previousHash };
    }
    const { hash, ...rest } = record;
    const expected = computeHash(previousHash, rest);
    if (expected !== hash) {
      return { seq: record.seq, reason: "content", expected, found: hash };
    }
    previousHash = hash;
  }
  return null;
}

export { GENESIS_HASH };
