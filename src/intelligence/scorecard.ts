/**
 * Scorecards: a fitted model that can still explain itself.
 *
 * The risk engine's doc comment has always said that "a tenant that wants a
 * learned model registers it as one more signal and keeps the explanation
 * surface intact". This is that, made concrete, because an extension point
 * nobody has ever built against is a claim rather than a feature.
 *
 * A scorecard is a linear model held **as data**: named features, integer
 * weights, an intercept. Fitting happens outside this platform, in whatever
 * statistical tooling a deployment already owns. What arrives here is the
 * fitted result, which is a table of numbers.
 *
 * Why this shape rather than an embedded model runtime:
 *
 *  - **It explains itself by construction.** Every score decomposes into one
 *    contribution per feature. "Blocked because the velocity feature
 *    contributed 40 of 85" is appealable. "Blocked, score 0.91" is not, and
 *    every incentive platform eventually has to explain a block to a real
 *    customer who is standing at a till.
 *  - **It is deterministic.** Integer weights summed in sorted key order, so
 *    the same context scores identically on every host and in every
 *    re-implementation. A float model would make the total depend on summation
 *    order.
 *  - **It carries no dependency.** Loading a scorecard is loading JSON. The
 *    zero-dependency, zero-build promise survives.
 *
 * What this is not: training, gradient descent, inference over a neural
 * network, or anything that could be called learning. The platform executes a
 * model somebody else fitted. Calling that "machine learning" would be a
 * marketing claim, and the roadmap says so.
 */
import type { Result } from "../kernel/result.ts";
import { ok, fail } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { RiskInput, RiskSignal, SignalOutcome } from "../engines/risk.ts";
import { compareKeys } from "../kernel/order.ts";

/** A feature extracts one integer from a context. Deterministic and bounded. */
export interface ScorecardFeature {
  readonly key: string;
  readonly label: string;
  extract(input: RiskInput): number;
}

export interface ScorecardWeights {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Added to every score. Usually negative: the prior that most traffic is fine. */
  readonly intercept: number;
  /** Feature key to integer weight. A key with no feature registered is an error. */
  readonly weights: Readonly<Record<string, number>>;
  /** Free-form provenance: when it was fitted, on what, by whom. */
  readonly fittedAt?: string;
  readonly fittedOn?: string;
}

export interface ScorecardContribution {
  readonly feature: string;
  readonly label: string;
  readonly value: number;
  readonly weight: number;
  readonly contribution: number;
}

export interface ScorecardResult {
  readonly score: number;
  readonly intercept: number;
  readonly contributions: readonly ScorecardContribution[];
  /** The single largest contributor. What a human reads first. */
  readonly leading?: ScorecardContribution;
}

/**
 * Score a context against a fitted scorecard.
 *
 * Features are summed in sorted key order. That is not fussiness: it is what
 * makes the total reproducible when a deployment reorders its weights file.
 */
export function scoreWith(
  weights: ScorecardWeights,
  features: ReadonlyMap<string, ScorecardFeature>,
  input: RiskInput,
): Result<ScorecardResult> {
  const contributions: ScorecardContribution[] = [];
  let score = weights.intercept;

  for (const key of Object.keys(weights.weights).sort(compareKeys)) {
    const feature = features.get(key);
    if (feature === undefined) {
      // Silently skipping would change the model's meaning without anybody
      // noticing, which is the worst available outcome for a scoring rule.
      return fail(
        ErrorCode.UNKNOWN_REGISTRY_ENTRY,
        `scorecard '${weights.key}' references feature '${key}', which is not registered`,
        { scorecard: weights.key, feature: key, available: [...features.keys()].sort(compareKeys) },
      );
    }
    const weight = weights.weights[key] ?? 0;
    const value = Math.trunc(feature.extract(input));
    const contribution = value * weight;
    score += contribution;
    contributions.push({ feature: key, label: feature.label, value, weight, contribution });
  }

  const ranked = [...contributions].sort(
    (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || compareKeys(a.feature, b.feature),
  );

  return ok({
    score,
    intercept: weights.intercept,
    contributions,
    ...(ranked[0] === undefined ? {} : { leading: ranked[0] }),
  });
}

/* ------------------------------------------------------------------ *
 * Shipped features
 * ------------------------------------------------------------------ */

export const DEFAULT_SCORECARD_FEATURES: ScorecardFeature[] = [
  {
    key: "recent_redemptions",
    label: "Recent redemptions by this subject",
    extract: ({ context }) => context.subject.counters["redemptions.recent"] ?? 0,
  },
  {
    key: "is_anonymous",
    label: "Subject is anonymous",
    extract: ({ context }) => (context.subject.anonymous ? 1 : 0),
  },
  {
    key: "cart_whole_units",
    label: "Basket size in whole units",
    extract: ({ context }) => {
      const subtotal = context.cart?.subtotal;
      if (subtotal === undefined) return 0;
      return Number(subtotal.minor / 10n ** BigInt(subtotal.scale));
    },
  },
  {
    key: "cart_lines",
    label: "Distinct lines in the basket",
    extract: ({ context }) => context.cart?.lines.length ?? 0,
  },
  {
    key: "exchanges_applied",
    label: "Exchanges about to apply",
    extract: ({ exchanges }) => exchanges?.length ?? 0,
  },
];

export function scorecardFeatureMap(
  features: readonly ScorecardFeature[] = DEFAULT_SCORECARD_FEATURES,
): Map<string, ScorecardFeature> {
  return new Map(features.map((feature) => [feature.key, feature]));
}

/* ------------------------------------------------------------------ *
 * As a risk signal
 * ------------------------------------------------------------------ */

/**
 * Wrap a scorecard as a risk signal.
 *
 * The result drops straight into the `risk-signal` registry beside the
 * hand-written signals, and the risk engine neither knows nor cares that this
 * one came from a fitted model. That is the whole point: the explanation
 * surface, the thresholds and the appeal path are unchanged.
 */
export function scorecardSignal(spec: {
  readonly weights: ScorecardWeights;
  readonly features?: readonly ScorecardFeature[];
  readonly weight?: number;
  /** Scores are clamped into 0..100, the range every risk signal speaks. */
  readonly maximum?: number;
}): RiskSignal {
  const features = scorecardFeatureMap(spec.features ?? DEFAULT_SCORECARD_FEATURES);
  const maximum = spec.maximum ?? 100;

  return {
    key: spec.weights.key,
    label: spec.weights.label,
    description: spec.weights.description,
    weight: spec.weight ?? 1,
    evaluate(input): Result<SignalOutcome> {
      const scored = scoreWith(spec.weights, features, input);
      if (!scored.ok) return scored;

      const clamped = Math.max(0, Math.min(maximum, scored.value.score));
      const leading = scored.value.leading;
      const reason =
        leading === undefined || leading.contribution === 0
          ? `scored ${clamped} with nothing contributing`
          : `scored ${clamped}; largest contributor was ${leading.label} (${leading.value} × ${leading.weight} = ${leading.contribution})`;

      return ok({ score: clamped, reason });
    },
  };
}
