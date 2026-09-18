/**
 * Explanations.
 *
 * "Why didn't I get the discount?" is the most frequent question this platform
 * will ever be asked. Everything needed to answer it is already in the decision
 * — the ten checks, the rule trace, the displacement reasons — but as a data
 * structure, which is the right shape for a machine and the wrong one for a
 * person under time pressure.
 *
 * These are pure functions over a decision. No I/O, no store, no engine: a
 * support tool can render a decision it was handed, and so can a log line.
 */
import { toDecimal } from "../universal/economic/amount.ts";
import type { Amount } from "../universal/economic/amount.ts";
import type { Decision, RejectedExchange } from "../engines/decision.ts";
import type { EligibilityVerdict } from "../engines/eligibility.ts";
import type { PreviewReport } from "./preview.ts";

const money = (amount: Amount): string => `${toDecimal(amount)} ${amount.unit}`;

/**
 * Plain-language names for the eligibility checks.
 *
 * The check keys are stable identifiers and must not change; these are the
 * customer-facing phrasing, kept separate so one can be reworded without
 * breaking anything that matches on the other.
 */
const CHECK_PROSE: Readonly<Record<string, string>> = {
  reality: "this offer does not exist in this environment",
  lifecycle: "this offer is not currently live",
  window: "this offer is not available at this time",
  spatial: "this offer is not available in this location",
  channel: "this offer is not available on this channel",
  merchant: "nothing in the basket is from a participating merchant",
  acquisition: "the offer has not been claimed or the code was not provided",
  minimum_base: "the basket is below the minimum spend",
  conditions: "the basket or the customer does not meet the conditions",
  "limit.total_redemptions": "this offer has been fully redeemed",
  "limit.total_issuance": "no more of this offer can be issued",
  "limit.per_subject": "this customer has already used this offer the maximum number of times",
  "limit.per_subject_per_period": "this customer has used this offer too recently",
  "limit.total_budget": "this offer's budget is exhausted",
};

export interface Explanation {
  /** One sentence. What a customer or an agent should be told. */
  readonly summary: string;
  /** Supporting detail, most useful first. */
  readonly details: readonly string[];
}

/** Why a specific offer did not apply. */
export function explainRejection(rejection: RejectedExchange): Explanation {
  const failed = rejection.verdict.checks.find((check) => !check.passed);
  const prose = failed ? CHECK_PROSE[failed.check] : undefined;

  const details: string[] = [];
  if (failed) {
    details.push(`Check that failed: ${failed.check}${failed.detail ? ` (${failed.detail})` : ""}`);
  }

  // The rule trace is the answer when the failure is a condition, and it is
  // wasted unless somebody surfaces the predicate that actually decided.
  if (failed?.check === "conditions" && rejection.verdict.ruleTrace) {
    const deciding = [...rejection.verdict.ruleTrace].reverse().find((entry) => !entry.result);
    if (deciding) {
      details.push(
        `The condition that decided it: '${deciding.op}'${deciding.detail ? ` — ${deciding.detail}` : ""}`,
      );
    }
  }

  const skipped = rejection.verdict.checks.filter((check) => check.skipped);
  if (skipped.length > 0) {
    details.push(`Not evaluated, because an earlier check already failed: ${skipped.map((s) => s.check).join(", ")}`);
  }

  return {
    summary: `'${rejection.name}' did not apply: ${prose ?? rejection.reason}`,
    details,
  };
}

/** Why an offer was eligible but did not end up applying. */
export function explainDisplacement(decision: Decision, valueExchangeId: string): Explanation | undefined {
  const displaced = decision.displaced.find((note) => note.valueExchangeId === valueExchangeId);
  if (!displaced) return undefined;

  return {
    summary: displaced.conflictsWith
      ? `It qualified, but could not be combined with an offer that was applied.`
      : `It qualified, but a different combination of offers was worth more.`,
    details: [
      `Reason: ${displaced.reason}`,
      ...(displaced.conflictsWith ? [`Conflicts with: ${displaced.conflictsWith}`] : []),
      `The platform considered ${decision.combinationsConsidered} compatible combination(s) using the '${decision.objective}' objective.`,
      ...(decision.searchMode === "greedy"
        ? [
            "Note: more than ten offers qualified, so the combination chosen may not be the best possible one.",
          ]
        : []),
    ],
  };
}

/** The whole decision, as a person would read it. */
export function explainDecision(decision: Decision): Explanation {
  const details: string[] = [];

  if (decision.applied.length === 0) {
    const reasons = decision.rejected.slice(0, 5).map((rejection) => explainRejection(rejection).summary);
    return {
      summary:
        decision.rejected.length === 0
          ? "No offers were available for this interaction."
          : `None of the ${decision.rejected.length} available offers applied.`,
      details: reasons,
    };
  }

  for (const applied of decision.applied) {
    const computations = applied.resolution.computations
      .map((computation) => `${computation.detail} → ${money(computation.value)}`)
      .join("; ");
    details.push(`${applied.order + 1}. '${applied.name}' computed on ${money(applied.appliedTo)}: ${computations}`);
  }

  if (decision.granted.length > 0) {
    details.push(`Also granted: ${decision.granted.map(money).join(", ")}`);
  }
  if (decision.displaced.length > 0) {
    details.push(
      `${decision.displaced.length} other offer(s) qualified but were not applied: ` +
        decision.displaced.map((note) => note.reason).join("; "),
    );
  }

  return {
    summary:
      `${decision.applied.length} offer(s) applied, reducing the amount payable by ` +
      `${money(decision.payableReduction)} to ${money(decision.remainingPayable)}.`,
    details,
  };
}

/** Why one specific offer did not apply, whatever the reason. */
export function explainOffer(decision: Decision, valueExchangeId: string): Explanation {
  const applied = decision.applied.find((entry) => entry.valueExchangeId === valueExchangeId);
  if (applied) {
    return {
      summary: `'${applied.name}' applied.`,
      details: applied.resolution.computations.map(
        (computation) => `${computation.detail} → ${money(computation.value)}`,
      ),
    };
  }

  const rejected = decision.rejected.find((entry) => entry.valueExchangeId === valueExchangeId);
  if (rejected) return explainRejection(rejected);

  const displaced = explainDisplacement(decision, valueExchangeId);
  if (displaced) return displaced;

  return {
    summary: "That offer was not considered for this interaction.",
    details: [
      `It was not among the ${decision.candidatesConsidered} candidate(s) evaluated.`,
      "It may be inactive, scoped to another reality, or restricted to a code that was not presented.",
    ],
  };
}

/** A preview report, for an author rather than a support agent. */
export function explainPreview(report: PreviewReport): Explanation {
  const errors = report.findings.filter((finding) => finding.severity === "error");
  const warnings = report.findings.filter((finding) => finding.severity === "warning");

  const summary = !report.passed
    ? `'${report.name}' cannot be published: ${errors.length} error(s) found by preview.`
    : `'${report.name}' applies to ${report.appliesTo} of ${report.samplesRun} sample contexts` +
      (warnings.length > 0 ? `, with ${warnings.length} warning(s).` : ".");

  return {
    summary,
    details: [
      ...report.findings.map((finding) => `[${finding.severity}] ${finding.code}: ${finding.message}`),
      ...report.outcomes.map((outcome) =>
        outcome.applies
          ? `✓ ${outcome.summary} → ${outcome.value ? money(outcome.value) : "no value"}`
          : `✗ ${outcome.summary} → ${outcome.reason ?? "did not apply"}`,
      ),
    ],
  };
}

/** Render an explanation as flat text, for a log or a terminal. */
export function renderExplanation(explanation: Explanation, indent = "  "): string {
  return [explanation.summary, ...explanation.details.map((line) => `${indent}${line}`)].join("\n");
}
