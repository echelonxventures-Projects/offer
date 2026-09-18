/**
 * Account positions.
 *
 * Split out of `payout.ts` so the storage port can describe a ledger snapshot
 * without importing the payout engine.
 */

export interface AccountPosition {
  readonly accountId: string;
  readonly unit: string;
  /** Positive means a debit balance, negative a credit balance. */
  readonly netMinor: bigint;
  readonly entries: number;
}
