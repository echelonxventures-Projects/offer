/**
 * Double-entry ledger.
 *
 * Every movement of value is two or more entries that sum to zero within each
 * unit. This is not bookkeeping ceremony: it is the only structure that makes
 * "where did this discount come from and who ended up paying for it" answerable
 * without re-deriving it from logs.
 *
 * Units never mix inside a transaction. A conversion is two transactions and an
 * explicit exchange record, so the rate used is always visible.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { JsonObject } from "../kernel/types.ts";
import type { Amount } from "../universal/economic/amount.ts";
import type { PartyRef } from "../model/funding.ts";

export const ACCOUNT_KINDS = [
  "funding_budget",
  "subject_wallet",
  "liability",
  "payable",
  "receivable",
  "revenue",
  "expense",
  "clearing",
] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export interface Account {
  readonly id: string;
  readonly tenant: string;
  readonly kind: AccountKind;
  readonly unit: string;
  readonly party?: PartyRef;
  readonly label: string;
}

export type Direction = "debit" | "credit";

export interface LedgerEntry {
  readonly id: string;
  readonly tenant: string;
  readonly reality: string;
  /** All entries of one movement share this. */
  readonly transactionId: string;
  readonly accountId: string;
  readonly direction: Direction;
  readonly amount: Amount;
  /** ISO-ish instant token; opaque to the ledger. */
  readonly at: string;
  /** What caused this: an execution, a settlement, a payout, a reversal. */
  readonly reference: { readonly kind: string; readonly id: string };
  readonly memo?: string;
  readonly metadata?: JsonObject;
}

/** Signed contribution of an entry to its account balance. */
export const signedMinor = (entry: LedgerEntry): bigint =>
  entry.direction === "debit" ? entry.amount.minor : -entry.amount.minor;

/**
 * A transaction balances when, for every unit, debits equal credits.
 * Rejecting an unbalanced transaction at the boundary is what stops a rounding
 * bug in a benefit handler from quietly becoming a hole in the books.
 */
export function assertBalanced(entries: readonly LedgerEntry[]): Result<true> {
  if (entries.length < 2) {
    return fail(ErrorCode.INVALID_REQUEST, "a ledger transaction needs at least two entries");
  }
  const perUnit = new Map<string, bigint>();
  for (const entry of entries) {
    if (entry.amount.minor < 0n) {
      return fail(ErrorCode.INVALID_REQUEST, "ledger amounts must be non-negative; use direction to express sign", {
        entry: entry.id,
      });
    }
    perUnit.set(entry.amount.unit, (perUnit.get(entry.amount.unit) ?? 0n) + signedMinor(entry));
  }
  for (const [unit, net] of perUnit) {
    if (net !== 0n) {
      return fail(ErrorCode.INVALID_REQUEST, `ledger transaction does not balance in ${unit}: net ${net}`, {
        unit,
        net: net.toString(),
      });
    }
  }
  return ok(true);
}

/** Net balance of an account, as a signed Amount in that account's unit. */
export function balanceOf(entries: readonly LedgerEntry[], unit: string, scale: number): Amount {
  let minor = 0n;
  for (const entry of entries) {
    if (entry.amount.unit !== unit) continue;
    minor += signedMinor(entry);
  }
  return { unit, scale, minor };
}
