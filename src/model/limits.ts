/**
 * Limits.
 *
 * Limits are the difference between a promotion and an unbounded liability.
 * They are checked before a benefit is granted and enforced again at capture,
 * because the gap between the two is exactly where over-redemption happens.
 */
import type { Amount } from "../universal/economic/amount.ts";

export interface PeriodLimit {
  readonly max: number;
  /** Rolling window length in frame seconds. */
  readonly windowSeconds: number;
}

export interface LimitSpec {
  /** Total grants that may ever be issued. */
  readonly totalIssuance?: number;
  /** Total successful redemptions across all subjects. */
  readonly totalRedemptions?: number;
  /** Redemptions by any one subject. */
  readonly perSubject?: number;
  /** Redemptions by any one subject inside a rolling window. */
  readonly perSubjectPerPeriod?: PeriodLimit;
  /** Cumulative benefit value that may be granted, across all redemptions. */
  readonly totalBudget?: { readonly unit: string; readonly decimal: string };
  /** Cap on the benefit value of a single redemption. */
  readonly maxPerRedemption?: { readonly unit: string; readonly decimal: string };
  /** Minimum interaction value before the exchange applies at all. */
  readonly minimumBase?: { readonly unit: string; readonly decimal: string };
}

/**
 * Counter shapes live with the storage port, not here.
 *
 * Phase 1 moved them: a counter is only meaningful alongside the atomic
 * operation that consumes it, and keeping the shape next to the model invited
 * the read-check-write pattern that `ConsumeLimitsRequest` exists to prevent.
 * See `src/adapters/store.ts`.
 */
