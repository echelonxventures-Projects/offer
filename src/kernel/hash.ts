/**
 * Hashing for the audit chain and for deterministic identifiers.
 *
 * SHA-256 over canonical JSON. The audit log chains records so that removing or
 * editing any past decision invalidates every hash after it - the cheapest
 * possible tamper-evidence, with no external dependency.
 */
import { createHash, randomUUID } from "node:crypto";
import { canonicalize } from "./canonical.ts";

/**
 * Separator between the previous hash and the new record. The previous hash is
 * always exactly 64 hex characters, so the split point is unambiguous whatever
 * the separator is; it exists only to keep the two fields visually distinct.
 */
const CHAIN_SEPARATOR = "|";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Stable hash of any value; identical inputs always yield identical output. */
export function hashValue(value: unknown): string {
  return sha256(canonicalize(value));
}

/** Link a record into a hash chain: H(previousHash || canonical(record)). */
export function chainHash(previousHash: string, record: unknown): string {
  return sha256(`${previousHash}${CHAIN_SEPARATOR}${canonicalize(record)}`);
}

export const GENESIS_HASH = "0".repeat(64);

export { randomUUID };
