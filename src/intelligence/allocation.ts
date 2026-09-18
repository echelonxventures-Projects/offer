/**
 * Budget allocation across campaigns.
 *
 * "We have 500,000 to spend next quarter across eleven campaigns. How should it
 * be split?" - a planning question, asked before anything is live, and answered
 * here rather than in a spreadsheet nobody can audit.
 *
 * Three things make this safe to act on:
 *
 *  - **It allocates exactly.** The same remainder-preserving `allocate()` the
 *    ledger uses, so the parts sum to the total to the minor unit. A plan that
 *    loses a cent per campaign is a plan that will not reconcile.
 *  - **It is advisory.** Nothing here writes a budget, moves money or touches a
 *    funding source. It returns a proposal. Applying it is a separate,
 *    deliberate act by somebody with the `fund` capability, and that separation
 *    is the point: an optimiser with write access is an optimiser that can
 *    empty a campaign at three in the morning.
 *  - **It shows its reasoning.** Every allocation carries the weight it was
 *    given and why, so "why did marketing get less this quarter" has an answer
 *    that is not "the model said so".
 *
 * The strategies are registered, so a deployment with its own planning logic
 * adds one rather than editing this file.
 */
import type { Result } from "../kernel/result.ts";
import { ok, fail } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";
import type { Amount } from "../universal/economic/amount.ts";
import { allocate, zero } from "../universal/economic/amount.ts";
import { compareKeys } from "../kernel/order.ts";

export interface CampaignDemand {
  readonly valueExchangeId: string;
  readonly name: string;
  /** What it spent in the period being learned from. */
  readonly spent: Amount;
  /** Redemptions in that period. Zero is meaningful: it delivered nothing. */
  readonly redemptions: number;
  /** What the author asked for, if anything. */
  readonly requested?: Amount;
  /** Author priority, as on the exchange. */
  readonly priority: number;
}

export interface AllocationLine {
  readonly valueExchangeId: string;
  readonly name: string;
  readonly amount: Amount;
  /** The weight this campaign was given, and the sentence explaining it. */
  readonly weight: bigint;
  readonly rationale: string;
}

export interface AllocationPlan {
  readonly strategy: string;
  readonly total: Amount;
  readonly lines: readonly AllocationLine[];
  /** Campaigns given nothing, and why. Never silently dropped. */
  readonly excluded: readonly { readonly valueExchangeId: string; readonly reason: string }[];
}

export interface AllocationInput {
  readonly total: Amount;
  readonly demands: readonly CampaignDemand[];
}

export interface AllocationStrategy extends RegistryEntry {
  /** Non-negative weight per campaign. Zero excludes it, with a reason. */
  weigh(demand: CampaignDemand, input: AllocationInput): { readonly weight: bigint; readonly rationale: string };
}

/* ------------------------------------------------------------------ */

export const DEFAULT_ALLOCATION_STRATEGIES: AllocationStrategy[] = [
  {
    key: "equal",
    label: "Equal split",
    description: "Every campaign gets the same. The honest default when there is no history to learn from.",
    weigh() {
      return { weight: 1n, rationale: "equal split" };
    },
  },
  {
    key: "by_priority",
    label: "By author priority",
    description: "Splits in proportion to the priority the campaign author declared.",
    weigh(demand) {
      const weight = BigInt(Math.max(0, demand.priority));
      return weight === 0n
        ? { weight: 0n, rationale: "priority is zero" }
        : { weight, rationale: `priority ${demand.priority}` };
    },
  },
  {
    key: "by_historic_spend",
    label: "By what it actually spent",
    description:
      "Splits in proportion to last period's spend. Rewards campaigns that delivered and starves ones that did not - which is right for renewal and wrong for anything new, so it excludes nothing and says so.",
    weigh(demand) {
      if (demand.spent.minor <= 0n) {
        return { weight: 0n, rationale: "spent nothing in the period being learned from" };
      }
      return { weight: demand.spent.minor, rationale: `spent ${demand.spent.minor} minor units` };
    },
  },
  {
    key: "by_redemptions",
    label: "By redemption count",
    description:
      "Splits by how many customers actually used it, ignoring how much each cost. Favours reach over value, which is the right objective for acquisition and the wrong one for margin.",
    weigh(demand) {
      const weight = BigInt(Math.max(0, demand.redemptions));
      return weight === 0n
        ? { weight: 0n, rationale: "no redemptions in the period" }
        : { weight, rationale: `${demand.redemptions} redemption(s)` };
    },
  },
];

export function allocationStrategyRegistry(): Registry<AllocationStrategy> {
  return new Registry<AllocationStrategy>("allocation-strategy").registerAll(DEFAULT_ALLOCATION_STRATEGIES);
}

/* ------------------------------------------------------------------ */

export function planAllocation(
  strategies: Registry<AllocationStrategy>,
  strategyKey: string,
  input: AllocationInput,
): Result<AllocationPlan> {
  const strategy = strategies.require(strategyKey);
  if (!strategy.ok) return strategy;

  if (input.total.minor < 0n) {
    return fail(ErrorCode.INVALID_REQUEST, "cannot allocate a negative total", {
      total: input.total.minor.toString(),
    });
  }

  // Sorted, so the same demands in a different order produce the same plan -
  // including the same distribution of the remainder.
  const demands = [...input.demands].sort((a, b) => compareKeys(a.valueExchangeId, b.valueExchangeId));

  const weighed = demands.map((demand) => ({ demand, ...strategy.value.weigh(demand, input) }));
  const included = weighed.filter((entry) => entry.weight > 0n);
  const excluded = weighed
    .filter((entry) => entry.weight <= 0n)
    .map((entry) => ({ valueExchangeId: entry.demand.valueExchangeId, reason: entry.rationale }));

  if (included.length === 0) {
    return fail(
      ErrorCode.INVALID_REQUEST,
      `strategy '${strategyKey}' gave every campaign a weight of zero, so there is nothing to allocate`,
      { strategy: strategyKey, campaigns: demands.length },
    );
  }

  const parts = allocate(input.total, included.map((entry) => entry.weight));
  if (!parts.ok) return parts;

  const lines = included.map((entry, index) => ({
    valueExchangeId: entry.demand.valueExchangeId,
    name: entry.demand.name,
    amount: parts.value[index] as Amount,
    weight: entry.weight,
    rationale: entry.rationale,
  }));

  return ok({ strategy: strategyKey, total: input.total, lines, excluded });
}

/**
 * What a plan would change, against what each campaign has now.
 *
 * A plan is only useful next to the status quo. Returning the delta stops the
 * reader doing the subtraction, which is where planning mistakes are made.
 */
export interface AllocationChange {
  readonly valueExchangeId: string;
  readonly name: string;
  readonly current: Amount;
  readonly proposed: Amount;
  readonly deltaMinor: bigint;
}

export function compareToCurrent(
  plan: AllocationPlan,
  current: ReadonlyMap<string, Amount>,
): readonly AllocationChange[] {
  return plan.lines
    .map((line) => {
      const now = current.get(line.valueExchangeId) ?? zero(line.amount.unit, line.amount.scale);
      return {
        valueExchangeId: line.valueExchangeId,
        name: line.name,
        current: now,
        proposed: line.amount,
        deltaMinor: line.amount.minor - now.minor,
      };
    })
    .sort((a, b) => {
      const size = b.deltaMinor < 0n ? -b.deltaMinor : b.deltaMinor;
      const other = a.deltaMinor < 0n ? -a.deltaMinor : a.deltaMinor;
      return size === other ? compareKeys(a.valueExchangeId, b.valueExchangeId) : size > other ? 1 : -1;
    });
}
