/**
 * Settlement Engine.
 *
 * Two jobs, kept separate on purpose:
 *
 *   1. `allocateFunding` - decide who pays for a benefit, exactly, to the minor
 *      unit, honouring caps and remaining budgets.
 *   2. `postBenefit` - turn that into balanced double-entry lines.
 *
 * The posting convention, stated once so it is not re-derived per effect:
 *   - the funder always takes a debit to an expense account: they bore a cost
 *   - the credit goes wherever the value landed:
 *       price reduction  -> a clearing account, netted at merchant settlement
 *       wallet / cashback -> a subject liability: we now owe the subject
 *       commission        -> a payable to the third party
 *       points            -> a points liability in the points unit
 * Every transaction balances within each unit or it is rejected.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { IdFactory } from "../kernel/ids.ts";
import type { Amount } from "../universal/economic/amount.ts";
import { allocate, fromDecimal, subtract, zero } from "../universal/economic/amount.ts";
import type { EconomicAuthority } from "../universal/economic/authority.ts";
import type { FundingAllocation, FundingModel, FundingSource, FundingSpec, PartyRef } from "../model/funding.ts";
import type { Registry } from "../registry/registry.ts";
import type { AccountNaming, PostingRule } from "./posting.ts";
import { resolvePosting } from "./posting.ts";
import type { EffectKind } from "../model/benefit.ts";
import type { LedgerEntry } from "./ledger.ts";
import { assertBalanced } from "./ledger.ts";

/** Headroom left in a source: budget minus reserved minus spent. */
export function availableOf(source: FundingSource): Amount | null {
  if (!source.budget) return null; // uncapped
  return {
    unit: source.budget.unit,
    scale: source.budget.scale,
    minor: source.budget.minor - source.reserved.minor - source.spent.minor,
  };
}

export interface FundingAllocationInput {
  readonly cost: Amount;
  readonly spec: FundingSpec;
  readonly sources: ReadonlyMap<string, FundingSource>;
  readonly model: FundingModel;
}

/**
 * Divide a cost across funding sources.
 *
 * Proportional splits use the remainder-preserving allocator, then each share
 * is clipped by that source's cap and remaining budget, and any shortfall is
 * offered to the sources that still have headroom, in declaration order. If it
 * cannot be placed in full the whole allocation fails: a half-funded benefit is
 * worse than a refused one, because the subject has already been told a price.
 */
export function allocateFunding(input: FundingAllocationInput): Result<FundingAllocation[]> {
  const { cost, spec, sources, model } = input;
  if (spec.splits.length === 0) {
    return fail(ErrorCode.INVALID_REQUEST, "funding spec has no sources");
  }
  if (cost.minor === 0n) {
    return ok([]);
  }

  const resolved: { split: (typeof spec.splits)[number]; source: FundingSource; cap: bigint | null }[] = [];
  for (const split of spec.splits) {
    const source = sources.get(split.sourceId);
    if (!source) {
      return fail(ErrorCode.NOT_FOUND, `funding source '${split.sourceId}' not found`, { sourceId: split.sourceId });
    }
    if (source.unit !== cost.unit) {
      return fail(ErrorCode.UNIT_MISMATCH, `funding source '${source.id}' is in ${source.unit}, cost is in ${cost.unit}`, {
        sourceId: source.id,
        sourceUnit: source.unit,
        costUnit: cost.unit,
      });
    }
    const cap = split.cap ? fromDecimal(cost.unit, split.cap.decimal, cost.scale).minor : null;
    resolved.push({ split, source, cap });
  }

  const headroom = resolved.map(({ source, cap }) => {
    const available = availableOf(source);
    const budgetLimit = available === null ? null : available.minor;
    if (cap === null) return budgetLimit;
    return budgetLimit === null ? cap : cap < budgetLimit ? cap : budgetLimit;
  });

  let shares: bigint[];
  if (model.strategy === "waterfall") {
    shares = new Array<bigint>(resolved.length).fill(0n);
    let remaining = cost.minor;
    for (let i = 0; i < resolved.length && remaining > 0n; i += 1) {
      const limit = headroom[i];
      const take = limit === null || limit === undefined ? remaining : remaining < limit ? remaining : limit;
      const clipped = take < 0n ? 0n : take;
      shares[i] = clipped;
      remaining -= clipped;
    }
    if (remaining > 0n) return insufficient(cost, remaining, resolved.map((r) => r.source.id));
  } else {
    const weights = resolved.map(({ split }) => BigInt(Math.max(0, Math.round((split.weight ?? 1) * 1000))));
    const raw = allocate(cost, weights.every((w) => w === 0n) ? weights.map(() => 1n) : weights);
    if (!raw.ok) return raw;

    shares = raw.value.map((part, index) => {
      const limit = headroom[index];
      if (limit === null || limit === undefined) return part.minor;
      return part.minor < limit ? part.minor : limit < 0n ? 0n : limit;
    });

    let shortfall = cost.minor - shares.reduce((total, s) => total + s, 0n);
    for (let i = 0; i < shares.length && shortfall > 0n; i += 1) {
      const limit = headroom[i];
      if (limit === null || limit === undefined) {
        shares[i] = (shares[i] as bigint) + shortfall;
        shortfall = 0n;
        break;
      }
      const spare = limit - (shares[i] as bigint);
      if (spare <= 0n) continue;
      const take = spare < shortfall ? spare : shortfall;
      shares[i] = (shares[i] as bigint) + take;
      shortfall -= take;
    }
    if (shortfall > 0n) return insufficient(cost, shortfall, resolved.map((r) => r.source.id));
  }

  return ok(
    resolved.map(({ source, cap }, index) => {
      const minor = shares[index] as bigint;
      const available = availableOf(source);
      const limitedByCap = cap !== null && minor === cap;
      const limitedByBudget = available !== null && minor === available.minor && !limitedByCap;
      return {
        sourceId: source.id,
        party: source.party,
        amount: { unit: cost.unit, scale: cost.scale, minor },
        ...(limitedByCap ? { limitedBy: "cap" as const } : limitedByBudget ? { limitedBy: "budget" as const } : {}),
      };
    }),
  );
}

function insufficient(cost: Amount, shortfall: bigint, sourceIds: string[]): Result<FundingAllocation[]> {
  return fail(ErrorCode.INSUFFICIENT_FUNDS, `funding sources cannot cover ${cost.minor} ${cost.unit}`, {
    shortfallMinor: shortfall.toString(),
    costMinor: cost.minor.toString(),
    unit: cost.unit,
    sources: sourceIds,
  });
}

/* ------------------------------------------------------------------ *
 * Account naming. Deterministic, so the same economic event always
 * lands in the same account without a lookup table.
 * ------------------------------------------------------------------ */

/**
 * Account naming and posting rules moved to `posting.ts` in Phase 3.
 *
 * They were a template-literal object and an `if (effect.key === ...)` chain,
 * which meant a deployment with its own chart of accounts had to fork, and a
 * new effect kind had to edit the ledger. Both are now injectable.
 */
export { defaultAccountNaming } from "./posting.ts";
export type { AccountNaming, PostingRule } from "./posting.ts";


export interface PostBenefitInput {
  readonly tenant: string;
  readonly reality: string;
  readonly at: string;
  readonly transactionId: string;
  readonly reference: { readonly kind: string; readonly id: string };
  readonly effect: EffectKind;
  readonly value: Amount;
  readonly funding: readonly FundingAllocation[];
  readonly subjectId?: string;
  /** For third-party benefits: who is owed. Defaults to the subject. */
  readonly payee?: PartyRef;
  readonly ids: IdFactory;
  readonly memo?: string;
  /** Where the credit side lands, by effect. */
  readonly postingRules: Registry<PostingRule>;
  /** How account identifiers are formed. */
  readonly accounts: AccountNaming;
}

/** Produce the balanced entries for one benefit. */
export function postBenefit(input: PostBenefitInput): Result<LedgerEntry[]> {
  const { tenant, reality, at, transactionId, reference, effect, value, funding, ids } = input;
  if (value.minor === 0n) return ok([]);

  const entries: LedgerEntry[] = [];
  const line = (accountId: string, direction: "debit" | "credit", amount: Amount, memo: string): LedgerEntry => ({
    id: ids.next("led"),
    tenant,
    reality,
    transactionId,
    accountId,
    direction,
    amount,
    at,
    reference,
    memo,
  });

  // Debit side: every funder bears their share as an expense.
  for (const allocation of funding) {
    if (allocation.amount.minor === 0n) continue;
    entries.push(
      line(
        input.accounts.expense(allocation.sourceId, allocation.amount.unit),
        "debit",
        allocation.amount,
        `funded by ${allocation.party.kind}:${allocation.party.id}`,
      ),
    );
  }

  if (entries.length === 0) {
    return fail(ErrorCode.INVALID_REQUEST, "benefit has value but no funding allocations", {
      value: value.minor.toString(),
    });
  }

  // Credit side: wherever the effect says the value landed. The ledger does not
  // know what a commission is; it looks up the rule the effect named.
  const rule = input.postingRules.require(effect.posting);
  if (!rule.ok) return rule;

  const target = resolvePosting(rule.value, {
    tenant,
    value,
    effectKey: effect.key,
    accounts: input.accounts,
    ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
    ...(input.payee === undefined ? {} : { payee: input.payee }),
  });
  if (!target.ok) return target;
  entries.push(line(target.value.accountId, "credit", value, target.value.memo));

  const balanced = assertBalanced(entries);
  return balanced.ok ? ok(entries) : balanced;
}


/** Reverse a set of entries: same accounts, opposite directions. */
export function reverseEntries(
  entries: readonly LedgerEntry[],
  transactionId: string,
  at: string,
  reference: { kind: string; id: string },
  ids: IdFactory,
): LedgerEntry[] {
  return entries.map((entry) => ({
    ...entry,
    id: ids.next("led"),
    transactionId,
    at,
    reference,
    direction: entry.direction === "debit" ? "credit" : "debit",
    memo: `reversal of ${entry.id}`,
  }));
}

/** Convenience for reading a source's remaining budget as a display string. */
export function remainingBudget(source: FundingSource, economic: EconomicAuthority): string {
  const available = availableOf(source);
  if (available === null) return "uncapped";
  return economic.display(available);
}

/*
 * Reservation arithmetic used to live here as `withReservation` and
 * `captureReservation`, operating on a source the caller had already read.
 * That is the read-check-write shape Phase 1 removed: holding a budget is now
 * `FundingStore.tryReserve`, which checks headroom and writes in one atomic
 * step. Keeping a copy here would have left a second, unsafe path.
 */

export const zeroLike = (amount: Amount): Amount => zero(amount.unit, amount.scale);
