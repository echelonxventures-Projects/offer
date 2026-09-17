/**
 * Conflict Resolution and Stacking Engine.
 *
 * Given several eligible exchanges, decide which of them may apply together and
 * in what order, then compute the combined result.
 *
 * Two honest statements about this engine:
 *
 * 1. Choosing the best combination is a subset-selection problem and it is
 *    NP-hard in general. Below `EXHAUSTIVE_LIMIT` candidates we enumerate every
 *    compatible subset and the answer is genuinely optimal. Above it we fall
 *    back to a greedy pass and the result says so in `searchMode`, so nobody
 *    mistakes a heuristic for a guarantee. See docs/06-adr/0003.
 *
 * 2. Application order changes the answer whenever benefits stack sequentially.
 *    The order is priority-descending then id-ascending - fixed and documented,
 *    because an order that varies between runs makes a decision impossible to
 *    reproduce.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { ResolvedContext } from "../context/context.ts";
import type { ValueExchange } from "../model/value-exchange.ts";
import type { Amount } from "../universal/economic/amount.ts";
import { add, subtract, zero } from "../universal/economic/amount.ts";
import type { BenefitResolution } from "./benefit-resolution.ts";
import type { BenefitResolutionEngine } from "./benefit-resolution.ts";

/** Above this many eligible candidates, exhaustive search is abandoned. */
export const EXHAUSTIVE_LIMIT = 10;

export interface AppliedExchange {
  readonly valueExchangeId: string;
  readonly valueExchangeVersion: number;
  readonly profile: string;
  readonly name: string;
  /** Position in the application order, 0-based. */
  readonly order: number;
  /** Base this exchange computed against, after any earlier sequential ones. */
  readonly appliedTo: Amount;
  readonly resolution: BenefitResolution;
}

export interface Combination {
  readonly applied: readonly AppliedExchange[];
  readonly payableReduction: Amount;
  readonly granted: readonly Amount[];
  /** Subtotal left after every price-reducing benefit. Never negative. */
  readonly remainingPayable: Amount;
}

export interface ConflictNote {
  readonly valueExchangeId: string;
  readonly reason: string;
  readonly conflictsWith?: string;
}

export interface StackingOutcome {
  readonly best: Combination;
  readonly searchMode: "exhaustive" | "greedy";
  /** Compatible subsets considered. 1 when only the empty set was possible. */
  readonly combinationsConsidered: number;
  /** Exchanges that were eligible but did not make the winning combination. */
  readonly displaced: readonly ConflictNote[];
}

/** Would these two exchanges refuse to sit together? */
export function conflictBetween(a: ValueExchange, b: ValueExchange): string | null {
  if (a.stacking.exclusive) return `'${a.id}' is exclusive`;
  if (b.stacking.exclusive) return `'${b.id}' is exclusive`;
  if (a.stacking.excludes?.includes(b.id)) return `'${a.id}' excludes '${b.id}'`;
  if (b.stacking.excludes?.includes(a.id)) return `'${b.id}' excludes '${a.id}'`;

  const sharedGroup = (a.stacking.groups ?? []).find((g) => (b.stacking.groups ?? []).includes(g));
  if (sharedGroup !== undefined) {
    // A whitelist overrides the group rule; that is what it is for.
    const mutuallyAllowed =
      a.stacking.combinesWith?.includes(b.id) && b.stacking.combinesWith?.includes(a.id);
    if (!mutuallyAllowed) return `both are in stacking group '${sharedGroup}'`;
  }

  if (a.stacking.combinesWith && !a.stacking.combinesWith.includes(b.id)) {
    return `'${a.id}' only combines with a fixed list that excludes '${b.id}'`;
  }
  if (b.stacking.combinesWith && !b.stacking.combinesWith.includes(a.id)) {
    return `'${b.id}' only combines with a fixed list that excludes '${a.id}'`;
  }
  return null;
}

function isCompatibleSet(members: readonly ValueExchange[]): { ok: true } | { ok: false; note: ConflictNote } {
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i] as ValueExchange;
      const b = members[j] as ValueExchange;
      const conflict = conflictBetween(a, b);
      if (conflict) {
        return { ok: false, note: { valueExchangeId: b.id, reason: conflict, conflictsWith: a.id } };
      }
    }
  }
  return { ok: true };
}

/** Fixed, documented application order. */
export function applicationOrder(members: readonly ValueExchange[]): ValueExchange[] {
  return [...members].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

export class StackingEngine {
  readonly #benefits: BenefitResolutionEngine;

  constructor(benefits: BenefitResolutionEngine) {
    this.#benefits = benefits;
  }

  /**
   * Compute one combination: resolve every member in order, threading the
   * remaining base through the sequential ones.
   */
  applyCombination(members: readonly ValueExchange[], context: ResolvedContext): Result<Combination> {
    const unit = context.economic.unit;
    const scale = context.economic.scale;
    const originalBase = context.cart?.subtotal ?? zero(unit, scale);

    let remaining = originalBase;
    let payableReduction = zero(unit, scale);
    const grantedByUnit = new Map<string, Amount>();
    const applied: AppliedExchange[] = [];

    for (const [order, exchange] of applicationOrder(members).entries()) {
      const parallel = exchange.stacking.application === "parallel";
      const appliedTo = parallel ? originalBase : remaining;

      const resolution = this.#benefits.resolve({ exchange, context, baseOverride: appliedTo });
      if (!resolution.ok) return resolution;

      applied.push({
        valueExchangeId: exchange.id,
        valueExchangeVersion: exchange.version,
        profile: exchange.profile,
        name: exchange.name,
        order,
        appliedTo,
        resolution: resolution.value,
      });

      const reduction = resolution.value.payableReduction;
      const nextTotal = add(payableReduction, reduction);
      if (!nextTotal.ok) return nextTotal;
      payableReduction = nextTotal.value;

      if (!parallel) {
        const nextRemaining = subtract(remaining, reduction);
        if (!nextRemaining.ok) return nextRemaining;
        remaining = nextRemaining.value.minor < 0n ? zero(unit, scale) : nextRemaining.value;
      }

      for (const grant of resolution.value.granted) {
        const running = grantedByUnit.get(grant.unit);
        const next = running ? add(running, grant) : ok(grant);
        if (!next.ok) return next;
        grantedByUnit.set(grant.unit, next.value);
      }
    }

    // A combination may never reduce the payable below zero. If it does, the
    // last sequential benefit is over-applying and that is a bug worth failing
    // on rather than silently clamping into a ledger that will not balance.
    const finalRemaining = subtract(originalBase, payableReduction);
    if (!finalRemaining.ok) return finalRemaining;
    if (finalRemaining.value.minor < 0n) {
      return fail(
        ErrorCode.ILLEGAL_STATE,
        "combined benefits exceed the interaction base; check sequential vs parallel application",
        {
          base: originalBase.minor.toString(),
          reduction: payableReduction.minor.toString(),
          members: members.map((m) => m.id),
        },
      );
    }

    return ok({
      applied,
      payableReduction,
      granted: [...grantedByUnit.values()].sort((a, b) => a.unit.localeCompare(b.unit)),
      remainingPayable: finalRemaining.value,
    });
  }

  /**
   * Find the best compatible subset under the given scorer.
   * `score` returns a higher number for a better outcome.
   */
  select(
    candidates: readonly ValueExchange[],
    context: ResolvedContext,
    score: (combination: Combination) => bigint,
  ): Result<StackingOutcome> {
    const unit = context.economic.unit;
    const scale = context.economic.scale;
    const empty: Combination = {
      applied: [],
      payableReduction: zero(unit, scale),
      granted: [],
      remainingPayable: context.cart?.subtotal ?? zero(unit, scale),
    };

    if (candidates.length === 0) {
      return ok({ best: empty, searchMode: "exhaustive", combinationsConsidered: 1, displaced: [] });
    }

    const exhaustive = candidates.length <= EXHAUSTIVE_LIMIT;
    const result = exhaustive
      ? this.#exhaustive(candidates, context, score, empty)
      : this.#greedy(candidates, context, score, empty);
    if (!result.ok) return result;

    const chosen = new Set(result.value.best.applied.map((a) => a.valueExchangeId));
    const displaced: ConflictNote[] = [];
    for (const candidate of candidates) {
      if (chosen.has(candidate.id)) continue;
      const blocker = [...chosen]
        .map((id) => candidates.find((c) => c.id === id))
        .filter((c): c is ValueExchange => c !== undefined)
        .map((other) => ({ other, conflict: conflictBetween(candidate, other) }))
        .find((x) => x.conflict !== null);
      displaced.push(
        blocker
          ? { valueExchangeId: candidate.id, reason: blocker.conflict as string, conflictsWith: blocker.other.id }
          : { valueExchangeId: candidate.id, reason: "a different combination scored higher" },
      );
    }

    return ok({ ...result.value, displaced });
  }

  #exhaustive(
    candidates: readonly ValueExchange[],
    context: ResolvedContext,
    score: (combination: Combination) => bigint,
    empty: Combination,
  ): Result<Omit<StackingOutcome, "displaced">> {
    let best = empty;
    let bestScore = score(empty);
    let considered = 1;

    const total = 1 << candidates.length;
    for (let mask = 1; mask < total; mask += 1) {
      const members = candidates.filter((_, index) => (mask & (1 << index)) !== 0);
      if (!isCompatibleSet(members).ok) continue;

      const combination = this.applyCombination(members, context);
      if (!combination.ok) return combination;
      considered += 1;

      const value = score(combination.value);
      // Deterministic tie-break: prefer fewer exchanges, then lexical ids.
      if (value > bestScore || (value === bestScore && betterTieBreak(combination.value, best))) {
        best = combination.value;
        bestScore = value;
      }
    }

    return ok({ best, searchMode: "exhaustive", combinationsConsidered: considered });
  }

  #greedy(
    candidates: readonly ValueExchange[],
    context: ResolvedContext,
    score: (combination: Combination) => bigint,
    empty: Combination,
  ): Result<Omit<StackingOutcome, "displaced">> {
    // Seed the order with each candidate's standalone value, best first.
    const scored: { exchange: ValueExchange; value: bigint }[] = [];
    for (const exchange of candidates) {
      const single = this.applyCombination([exchange], context);
      if (!single.ok) return single;
      scored.push({ exchange, value: score(single.value) });
    }
    scored.sort((a, b) =>
      a.value === b.value ? a.exchange.id.localeCompare(b.exchange.id) : b.value > a.value ? 1 : -1,
    );

    const accepted: ValueExchange[] = [];
    let best = empty;
    let considered = 1;

    for (const { exchange } of scored) {
      const trial = [...accepted, exchange];
      if (!isCompatibleSet(trial).ok) continue;
      const combination = this.applyCombination(trial, context);
      if (!combination.ok) return combination;
      considered += 1;
      const trialScore = score(combination.value);
      const bestScore = score(best);
      // Same reasoning as betterTieBreak: accept on a tie when it means going
      // from applying nothing to applying something.
      if (trialScore > bestScore || (trialScore === bestScore && betterTieBreak(combination.value, best))) {
        accepted.push(exchange);
        best = combination.value;
      }
    }

    return ok({ best, searchMode: "greedy", combinationsConsidered: considered });
  }
}

/**
 * Break a scoring tie.
 *
 * Doing nothing never wins a tie against doing something. An objective scores
 * only value in the interaction's own unit, so an offer that grants points, or
 * carbon credits, or an entitlement, legitimately scores zero and would
 * otherwise be beaten by the empty set - and a customer who was promised points
 * would not receive them.
 *
 * Among combinations that both apply something, the simpler one wins, and
 * lexical order settles the rest so the choice is reproducible.
 */
function betterTieBreak(candidate: Combination, incumbent: Combination): boolean {
  const candidateApplies = candidate.applied.length > 0;
  const incumbentApplies = incumbent.applied.length > 0;
  if (candidateApplies !== incumbentApplies) return candidateApplies;

  if (candidate.applied.length !== incumbent.applied.length) {
    return candidate.applied.length < incumbent.applied.length;
  }
  const a = candidate.applied.map((x) => x.valueExchangeId).join(",");
  const b = incumbent.applied.map((x) => x.valueExchangeId).join(",");
  return a < b;
}
