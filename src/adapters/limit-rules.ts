/**
 * Limit semantics, as pure functions.
 *
 * Every adapter calls these, so "which limit blocked this redemption" has one
 * answer regardless of where the counters are stored - and so a re-implementation
 * in another language has something exact to conform to.
 *
 * The functions decide; the adapter is responsible for calling them inside a
 * section that cannot interleave. Splitting it this way is what lets the
 * conformance vectors cover limit behaviour without covering storage.
 */
import type { Amount } from "../universal/economic/amount.ts";
import { fromDecimal } from "../universal/economic/amount.ts";
import type { LimitSpec } from "../model/limits.ts";
import type { CounterSnapshot } from "./store.ts";

export interface LimitBreach {
  /** Stable identifier, matching the eligibility check name. */
  readonly limit: string;
  readonly detail: string;
}

/**
 * Longest period any limit cares about, so an adapter knows how much history
 * to load and how aggressively it may prune.
 */
export function recentWindowFor(limits: LimitSpec): number | undefined {
  return limits.perSubjectPerPeriod?.windowSeconds;
}

/**
 * Which check is being run.
 *
 * The two differ only on the budget, and only because of when they happen:
 *
 *   "authoritative" runs at reserve, where the benefit value is known, and asks
 *     "would granting this take us over the budget?". An offer whose final
 *     redemption exactly exhausts the budget is allowed; the next is not.
 *
 *   "advisory" runs at eligibility, which happens *before* benefits are
 *     resolved, so the value is genuinely unknown. It can only ask "is there
 *     any headroom left at all?". Pretending it could do better would mean
 *     quoting a price the reservation then refuses.
 *
 * Every other limit is exact in both modes.
 */
export type LimitMode = "advisory" | "authoritative";

/** Would consuming one redemption breach a limit? Null means it would not. */
export function findBreach(
  snapshot: CounterSnapshot,
  limits: LimitSpec,
  subjectId: string | undefined,
  atSeconds: number,
  granted: readonly Amount[],
  mode: LimitMode = "authoritative",
): LimitBreach | null {
  if (limits.totalRedemptions !== undefined && snapshot.redemptions >= limits.totalRedemptions) {
    return {
      limit: "limit.total_redemptions",
      detail: `${snapshot.redemptions}/${limits.totalRedemptions}`,
    };
  }

  if (limits.perSubject !== undefined) {
    if (subjectId === undefined) {
      return {
        limit: "limit.per_subject",
        detail: "anonymous subject cannot be limited per subject",
      };
    }
    if (snapshot.subjectRedemptions >= limits.perSubject) {
      return {
        limit: "limit.per_subject",
        detail: `${snapshot.subjectRedemptions}/${limits.perSubject}`,
      };
    }
  }

  const period = limits.perSubjectPerPeriod;
  if (period && subjectId !== undefined) {
    const cutoff = atSeconds - period.windowSeconds;
    const inWindow = snapshot.subjectRecent.filter((seconds) => seconds > cutoff).length;
    if (inWindow >= period.max) {
      return {
        limit: "limit.per_subject_per_period",
        detail: `${inWindow}/${period.max} in the last ${period.windowSeconds}s`,
      };
    }
  }

  const budget = limits.totalBudget;
  if (budget) {
    const already = snapshot.grantedByUnit.get(budget.unit);
    const scale = already?.scale ?? granted.find((a) => a.unit === budget.unit)?.scale ?? 0;
    const cap = fromDecimal(budget.unit, budget.decimal, scale);
    const adding = granted
      .filter((a) => a.unit === budget.unit)
      .reduce((total, a) => total + a.minor, 0n);
    const consumed = already?.minor ?? 0n;

    if (mode === "advisory") {
      if (consumed >= cap.minor) {
        return {
          limit: "limit.total_budget",
          detail: `${consumed}/${cap.minor} minor units of ${budget.unit}`,
        };
      }
    } else {
      const after = consumed + adding;
      if (after > cap.minor) {
        return {
          limit: "limit.total_budget",
          detail: `${after}/${cap.minor} minor units of ${budget.unit}`,
        };
      }
    }
  }

  return null;
}

/** Would issuing one more grant breach `totalIssuance`? */
export function findIssuanceBreach(issued: number, cap: number | undefined): LimitBreach | null {
  if (cap === undefined || issued < cap) return null;
  return { limit: "limit.total_issuance", detail: `${issued}/${cap}` };
}

/**
 * Trim a subject's recent-redemption timestamps.
 *
 * Bounded twice over: by the window any limit actually uses, and by a hard cap
 * so a misconfigured window cannot grow the row without limit. The reference
 * adapter previously appended forever, which was a real leak.
 */
export const MAX_RECENT_RETAINED = 512;

export function pruneRecent(
  timestamps: readonly number[],
  atSeconds: number,
  windowSeconds: number | undefined,
): number[] {
  const cutoff = windowSeconds === undefined ? -Infinity : atSeconds - windowSeconds;
  const kept = timestamps.filter((seconds) => seconds > cutoff);
  return kept.length > MAX_RECENT_RETAINED ? kept.slice(kept.length - MAX_RECENT_RETAINED) : kept;
}
