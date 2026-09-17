/**
 * Decision objectives.
 *
 * What "best" means is a business decision, not an engineering one, so it is a
 * registry entry. A marketplace maximising conversion, a bank minimising its
 * own cost and a government maximising subsidy reach all want different
 * answers from identical inputs, and none of them should need a fork.
 *
 * Scores are bigint minor units, so comparisons are exact.
 */
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";
import type { ResolvedContext } from "../context/context.ts";
import type { Combination } from "./stacking.ts";

export interface DecisionObjective extends RegistryEntry {
  score(combination: Combination, context: ResolvedContext): bigint;
}

/** Value delivered to the subject, counting only the interaction's own unit. */
function subjectValue(combination: Combination, context: ResolvedContext): bigint {
  const unit = context.economic.unit;
  const granted = combination.granted.find((g) => g.unit === unit);
  return combination.payableReduction.minor + (granted?.minor ?? 0n);
}

/** Sentinel score meaning "this combination applied nothing at all". */
const APPLIES_NOTHING = -(2n ** 96n);

export const DEFAULT_OBJECTIVES: DecisionObjective[] = [
  {
    key: "max_subject_value",
    label: "Maximise subject value",
    description: "The default. Gives the subject the most value expressed in the interaction's unit.",
    score: subjectValue,
  },
  {
    key: "max_payable_reduction",
    label: "Maximise immediate saving",
    description: "Optimises what comes off the price now, ignoring deferred value. Right for conversion at checkout.",
    score: (combination) => combination.payableReduction.minor,
  },
  {
    key: "min_cost",
    label: "Minimise cost",
    description: "The cheapest combination that still applies something. Right when an incentive must be present but small.",
    /**
     * Applying nothing is the cheapest option of all, so it has to be scored
     * as the worst rather than merely as zero - otherwise this objective always
     * returns the empty set and the name becomes a lie.
     */
    score: (combination, context) =>
      combination.applied.length === 0 ? APPLIES_NOTHING : -subjectValue(combination, context),
  },
  {
    key: "max_applied",
    label: "Maximise number applied",
    description: "Prefers stacking many small benefits. Mostly useful for testing stacking rules.",
    score: (combination) => BigInt(combination.applied.length),
  },
  {
    key: "max_priority",
    label: "Respect authored priority",
    description: "Follows the priority numbers the campaign author set, ignoring computed value.",
    score: (combination) => combination.applied.reduce((total, a) => total + BigInt(a.resolution.computations.length), 0n),
  },
];

export const DEFAULT_OBJECTIVE = "max_subject_value";

export function objectiveRegistry(): Registry<DecisionObjective> {
  return new Registry<DecisionObjective>("decision-objective").registerAll(DEFAULT_OBJECTIVES);
}
