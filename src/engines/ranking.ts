/**
 * Discovery ranking.
 *
 * "What should we show this customer first?" — the recommendation question.
 *
 * Discovery used to take `rank: "value" | "priority" | "name"`, a closed union
 * with a `switch` inside the engine. That is the shape this platform removes
 * everywhere else: a tenant that wants to rank by margin, by inventory age or
 * by a fitted model had to edit an engine. Ranking is now a registry.
 *
 * Two levels, because they answer different questions:
 *
 *  - A **ranking** is a total order. It can be anything, including one that no
 *    score expresses well, such as alphabetical.
 *  - A **feature** is one bounded, named, explainable input to a score. A
 *    weighted set of features is a ranking, and one that can show its working.
 *
 * Three properties hold throughout, and they are the reason this is not just
 * "sort by whatever":
 *
 *  1. **Deterministic.** Integer arithmetic and codepoint ordering, with ties
 *     broken by id. The same cohort ranks the same way on every host.
 *  2. **Explainable.** A weighted ranking reports each feature's contribution.
 *     Nobody can appeal "the model liked it".
 *  3. **Off the decision path.** Ranking orders what is *presented*. It never
 *     decides what applies — that is the objective registry, and keeping the
 *     two apart is what stops a presentation tweak silently changing what a
 *     customer is charged.
 */
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";
import type { ResolvedContext } from "../context/context.ts";
import type { ValueExchange } from "../model/value-exchange.ts";
import type { Amount } from "../universal/economic/amount.ts";
import { compareKeys } from "../kernel/order.ts";

/**
 * The scale a feature scores on, carried with every input.
 *
 * Passed rather than imported so a deployment can widen it - see
 * `RankingConfig`. A feature that hardcodes 10000 still works at the default
 * and silently saturates if the scale is raised, which is why every shipped
 * feature reads it from its input.
 */

export interface RankingCandidate {
  readonly valueExchangeId: string;
  readonly name: string;
  readonly eligible: boolean;
  readonly indicativeValue?: Amount;
  /** The stored record, when discovery could resolve it. */
  readonly exchange?: ValueExchange;
}

export interface RankingInput {
  readonly candidate: RankingCandidate;
  /** Features return 0..`scale`. */
  readonly scale: number;
  /**
   * Every candidate being ranked together.
   *
   * Passed because the useful features are relative — "the best value here",
   * "the soonest to expire" — and a feature that cannot see its peers can only
   * express absolutes. It is readonly, and a feature that mutates it is a bug
   * in that feature rather than something this module can prevent.
   */
  readonly cohort: readonly RankingCandidate[];
  readonly context: ResolvedContext;
}

export interface RankingFeature extends RegistryEntry {
  /**
   * 0..10000. Higher is better, always — a feature that means "worse when
   * larger" inverts inside itself, so a weight never has to be negative to be
   * read correctly.
   */
  score(input: RankingInput): number;
}

export interface RankingContribution {
  readonly feature: string;
  readonly score: number;
  readonly weight: number;
  /** score × weight. The units are arbitrary; only the ordering is meaningful. */
  readonly contribution: number;
}

export interface RankingExplanation {
  readonly total: number;
  readonly contributions: readonly RankingContribution[];
}

export interface DiscoveryRanking extends RegistryEntry {
  /** Negative when `a` should come first. */
  compare(a: RankingInput, b: RankingInput): number;
  /** Present only on rankings built from features. */
  explain?(input: RankingInput): RankingExplanation;
}

/* ------------------------------------------------------------------ *
 * Features
 * ------------------------------------------------------------------ */

function valueOf(candidate: RankingCandidate): bigint {
  return candidate.indicativeValue?.minor ?? 0n;
}

/** Express `value` against the cohort's best, on `scale`. */
function relativeTo(value: bigint, best: bigint, scale: number): number {
  if (best <= 0n) return 0;
  if (value <= 0n) return 0;
  if (value >= best) return scale;
  return Number((value * BigInt(scale)) / best);
}

export const DEFAULT_RANKING_FEATURES: RankingFeature[] = [
  {
    key: "relative_value",
    label: "Value relative to the best on offer",
    description: "The straightforward one: what this is worth, against the most valuable thing here.",
    score({ candidate, cohort, scale }) {
      const best = cohort.reduce((max, other) => (valueOf(other) > max ? valueOf(other) : max), 0n);
      return relativeTo(valueOf(candidate), best, scale);
    },
  },
  {
    key: "author_priority",
    label: "Author priority",
    description: "What the campaign author asked for, expressed against the highest priority present.",
    score({ candidate, cohort, scale }) {
      const best = cohort.reduce((max, other) => Math.max(max, other.exchange?.priority ?? 0), 0);
      return relativeTo(
        BigInt(Math.max(0, candidate.exchange?.priority ?? 0)),
        BigInt(Math.max(0, best)),
        scale,
      );
    },
  },
  {
    key: "ending_soonest",
    label: "Ending soonest",
    description:
      "An offer about to close is worth surfacing before one that runs all year. Scores 0 for anything with no end date, because 'never ends' is not urgent.",
    score({ candidate, cohort, context, scale }) {
      const remaining = remainingTicks(candidate, context);
      if (remaining === undefined) return 0;

      // Furthest-away end in the cohort sets the scale, so this is "soonest
      // among these", not an absolute claim about what counts as soon.
      let longest = 0n;
      for (const other of cohort) {
        const otherRemaining = remainingTicks(other, context);
        if (otherRemaining !== undefined && otherRemaining > longest) longest = otherRemaining;
      }
      if (longest <= 0n) return scale;
      const scaled = relativeTo(remaining, longest, scale);
      return scale - scaled; // less time left ranks higher
    },
  },
  {
    key: "unconditional",
    label: "Applies without conditions",
    description:
      "An offer with no conditions will apply to the basket the customer already has. One with ten might not, and showing it invites 'why didn't I get this?'.",
    score({ candidate, scale }) {
      const conditions = candidate.exchange?.conditions;
      if (conditions === undefined) return scale;
      const nodes = countNodes(conditions as { readonly [key: string]: unknown });
      // Eight nodes is an elaborate condition; past that the score is flat.
      return Math.max(0, scale - Math.min(nodes, 8) * Math.trunc(scale / 8));
    },
  },
  {
    key: "newest",
    label: "Most recently published",
    description: "Recency as a tiebreak that does not bias towards whichever campaign was configured first.",
    score({ candidate, cohort, scale }) {
      const at = (item: RankingCandidate) => {
        const updated = item.exchange?.updatedAt;
        return updated === undefined ? 0n : BigInt(Date.parse(updated) || 0);
      };
      let oldest = at(candidate);
      let newest = at(candidate);
      for (const other of cohort) {
        const value = at(other);
        if (value < oldest) oldest = value;
        if (value > newest) newest = value;
      }
      if (newest === oldest) return scale;
      return relativeTo(at(candidate) - oldest, newest - oldest, scale);
    },
  },
];

function remainingTicks(candidate: RankingCandidate, context: ResolvedContext): bigint | undefined {
  const to = candidate.exchange?.window?.to;
  if (to === undefined) return undefined;
  // Comparing ticks across chronologies would be meaningless, so a window
  // expressed in a different chronology simply does not contribute.
  if (to.chronology !== context.instant.chronology) return undefined;
  const remaining = to.tick - context.instant.tick;
  return remaining < 0n ? 0n : remaining;
}

function countNodes(node: { readonly [key: string]: unknown }, depth = 0): number {
  if (depth > 16) return 16;
  let total = 1;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === "object") {
          total += countNodes(item as { readonly [key: string]: unknown }, depth + 1);
        }
      }
    } else if (value !== null && typeof value === "object") {
      total += countNodes(value as { readonly [key: string]: unknown }, depth + 1);
    }
  }
  return total;
}

/* ------------------------------------------------------------------ *
 * Rankings
 * ------------------------------------------------------------------ */

/**
 * Build a ranking from weighted features.
 *
 * Weights are integers. Floating-point weights would make the total depend on
 * summation order, and two hosts that disagree about the order of two offers
 * is exactly the class of bug this platform spends its determinism budget on.
 */
export function weightedRanking(spec: {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly weights: Readonly<Record<string, number>>;
  readonly features: Registry<RankingFeature>;
}): DiscoveryRanking {
  const explain = (input: RankingInput): RankingExplanation => {
    const contributions: RankingContribution[] = [];
    let total = 0;
    // Sorted, so the total is summed in the same order on every host.
    for (const feature of Object.keys(spec.weights).sort(compareKeys)) {
      const weight = spec.weights[feature] ?? 0;
      const found = spec.features.get(feature);
      if (found === undefined) continue;
      const score = clamp(found.score(input), input.scale);
      const contribution = score * weight;
      total += contribution;
      contributions.push({ feature, score, weight, contribution });
    }
    return { total, contributions };
  };

  return {
    key: spec.key,
    label: spec.label,
    description: spec.description,
    explain,
    compare(a, b) {
      return explain(b).total - explain(a).total;
    },
  };
}

function clamp(score: number, scale: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(scale, Math.trunc(score)));
}

export function rankingRegistry(features: Registry<RankingFeature>): Registry<DiscoveryRanking> {
  return new Registry<DiscoveryRanking>("discovery-ranking").registerAll([
    {
      key: "value",
      label: "Most valuable first",
      description: "The default. Ranks by what the subject would actually receive.",
      compare(a, b) {
        const av = valueOf(a.candidate);
        const bv = valueOf(b.candidate);
        if (av !== bv) return bv > av ? 1 : -1;
        const priority = (b.candidate.exchange?.priority ?? 0) - (a.candidate.exchange?.priority ?? 0);
        return priority || compareKeys(a.candidate.name, b.candidate.name);
      },
    },
    {
      key: "priority",
      label: "Author priority first",
      description: "Ranks by the campaign author's declared weight rather than by value.",
      compare(a, b) {
        return (b.candidate.exchange?.priority ?? 0) - (a.candidate.exchange?.priority ?? 0);
      },
    },
    {
      key: "name",
      label: "Alphabetical",
      description: "Codepoint order, not locale order, so every host agrees.",
      compare(a, b) {
        return compareKeys(a.candidate.name, b.candidate.name);
      },
    },
    weightedRanking({
      key: "recommended",
      label: "Recommended",
      description:
        "A blend: mostly value, with a nudge towards offers that are ending soon and that will actually apply. The shipped weights are a starting point, not a finding — a deployment fits its own.",
      weights: { relative_value: 5, ending_soonest: 2, unconditional: 2, author_priority: 1 },
      features,
    }),
  ]);
}

export function rankingFeatureRegistry(): Registry<RankingFeature> {
  return new Registry<RankingFeature>("ranking-feature").registerAll(DEFAULT_RANKING_FEATURES);
}
