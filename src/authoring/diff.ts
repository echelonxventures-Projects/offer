/**
 * Behavioural diff between two versions of an offer.
 *
 * An approver reviewing a change needs one question answered: **does this
 * increase what we could end up paying?** A textual diff does not answer it —
 * a rate moving from 10 to 15, a cap being removed and a redemption limit
 * rising all look like small edits, and one of them is unbounded.
 *
 * So changes are classified by their effect on exposure rather than by where
 * they appear in the record.
 */
import { canonicalize } from "../kernel/canonical.ts";
import type { ValueExchange } from "../model/value-exchange.ts";
import type { BenefitSpec } from "../model/benefit.ts";

export type ExposureDirection = "increases" | "decreases" | "neutral" | "unknown";

export interface ExchangeChange {
  /** Dotted path into the record, e.g. `benefits.discount.params.rate`. */
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly exposure: ExposureDirection;
  /** Why this matters, in one line, for an approver. */
  readonly note: string;
}

export interface ExchangeDiff {
  readonly valueExchangeId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changes: readonly ExchangeChange[];
  /** True when any change increases or cannot be shown not to increase exposure. */
  readonly increasesExposure: boolean;
  readonly summary: string;
}

const numberOf = (value: unknown): number | undefined => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return undefined;
};

/** Higher is riskier: a bigger rate, a bigger amount, a bigger limit. */
function compareNumeric(before: unknown, after: unknown, higherIsRiskier = true): ExposureDirection {
  const a = numberOf(before);
  const b = numberOf(after);
  if (a === undefined || b === undefined) return "unknown";
  if (a === b) return "neutral";
  const rose = b > a;
  return rose === higherIsRiskier ? "increases" : "decreases";
}

/** Removing a bound always increases exposure; adding one always reduces it. */
function compareBound(before: unknown, after: unknown): ExposureDirection {
  if (before === undefined && after !== undefined) return "decreases";
  if (before !== undefined && after === undefined) return "increases";
  if (before === undefined && after === undefined) return "neutral";
  return compareNumeric(
    typeof before === "object" ? (before as { decimal?: string }).decimal : before,
    typeof after === "object" ? (after as { decimal?: string }).decimal : after,
  );
}

function benefitChanges(before: ValueExchange, after: ValueExchange): ExchangeChange[] {
  const changes: ExchangeChange[] = [];
  const byId = (list: readonly BenefitSpec[]) => new Map(list.map((benefit) => [benefit.id, benefit]));
  const previous = byId(before.benefits);
  const next = byId(after.benefits);

  for (const [id, benefit] of next) {
    const was = previous.get(id);
    if (!was) {
      changes.push({
        path: `benefits.${id}`,
        before: undefined,
        after: benefit.type,
        exposure: "increases",
        note: "a new benefit is granted",
      });
      continue;
    }
    if (was.type !== benefit.type || was.effect !== benefit.effect) {
      changes.push({
        path: `benefits.${id}.type`,
        before: `${was.type}/${was.effect}`,
        after: `${benefit.type}/${benefit.effect}`,
        exposure: "unknown",
        note: "the benefit computes or pays differently; preview it",
      });
    }
    if (canonicalize(was.params) !== canonicalize(benefit.params)) {
      const rate = compareNumeric(was.params.rate, benefit.params.rate);
      const amount = compareNumeric(was.params.amount, benefit.params.amount);
      const exposure = rate !== "unknown" ? rate : amount !== "unknown" ? amount : "unknown";
      changes.push({
        path: `benefits.${id}.params`,
        before: was.params,
        after: benefit.params,
        exposure,
        note:
          exposure === "increases"
            ? "the benefit is larger"
            : exposure === "decreases"
              ? "the benefit is smaller"
              : "the parameters changed; the effect on cost is not obvious",
      });
    }
    const cap = compareBound(was.cap, benefit.cap);
    if (cap !== "neutral") {
      changes.push({
        path: `benefits.${id}.cap`,
        before: was.cap,
        after: benefit.cap,
        exposure: cap,
        note: cap === "increases" ? "the cap was raised or removed" : "the cap was tightened",
      });
    }
  }

  for (const [id, benefit] of previous) {
    if (!next.has(id)) {
      changes.push({
        path: `benefits.${id}`,
        before: benefit.type,
        after: undefined,
        exposure: "decreases",
        note: "a benefit was removed",
      });
    }
  }
  return changes;
}

function limitChanges(before: ValueExchange, after: ValueExchange): ExchangeChange[] {
  const changes: ExchangeChange[] = [];
  const bounds: [string, unknown, unknown][] = [
    ["limits.totalRedemptions", before.limits.totalRedemptions, after.limits.totalRedemptions],
    ["limits.perSubject", before.limits.perSubject, after.limits.perSubject],
    ["limits.totalIssuance", before.limits.totalIssuance, after.limits.totalIssuance],
    ["limits.totalBudget", before.limits.totalBudget, after.limits.totalBudget],
    ["limits.maxPerRedemption", before.limits.maxPerRedemption, after.limits.maxPerRedemption],
  ];

  for (const [path, was, now] of bounds) {
    const exposure = compareBound(was, now);
    if (exposure === "neutral") continue;
    changes.push({
      path,
      before: was,
      after: now,
      exposure,
      note:
        exposure === "increases"
          ? "the limit was raised or removed, so more can be spent"
          : "the limit was tightened",
    });
  }

  // A minimum spend is a bound on who qualifies, not on cost: lowering it
  // widens the audience, which increases exposure.
  const minimum = compareBound(before.limits.minimumBase, after.limits.minimumBase);
  if (minimum !== "neutral") {
    changes.push({
      path: "limits.minimumBase",
      before: before.limits.minimumBase,
      after: after.limits.minimumBase,
      exposure: minimum === "increases" ? "decreases" : "increases",
      note: minimum === "increases" ? "a higher minimum spend narrows the audience" : "a lower minimum spend widens it",
    });
  }
  return changes;
}

export function diffValueExchange(before: ValueExchange, after: ValueExchange): ExchangeDiff {
  const changes: ExchangeChange[] = [...benefitChanges(before, after), ...limitChanges(before, after)];

  if (canonicalize(before.conditions) !== canonicalize(after.conditions)) {
    changes.push({
      path: "conditions",
      before: before.conditions,
      after: after.conditions,
      exposure: "unknown",
      // Conditions can widen or narrow, and no static comparison can tell
      // which. Preview against the samples is what answers it.
      note: "the eligibility conditions changed; preview both versions to see who now qualifies",
    });
  }

  for (const [path, was, now] of [
    ["scope.spatial", before.scope.spatial, after.scope.spatial],
    ["scope.channels", before.scope.channels, after.scope.channels],
    ["scope.merchants", before.scope.merchants, after.scope.merchants],
    ["window", before.window, after.window],
    ["stacking", before.stacking, after.stacking],
    ["funding", before.funding, after.funding],
    ["acquisition", before.acquisition, after.acquisition],
    ["visibility", before.visibility, after.visibility],
  ] as const) {
    if (canonicalize(was) === canonicalize(now)) continue;
    changes.push({
      path,
      before: was,
      after: now,
      exposure: "unknown",
      note: `${path} changed`,
    });
  }

  const increasesExposure = changes.some(
    (change) => change.exposure === "increases" || change.exposure === "unknown",
  );

  return {
    valueExchangeId: after.id,
    fromVersion: before.version,
    toVersion: after.version,
    changes,
    increasesExposure,
    summary:
      changes.length === 0
        ? "No behavioural change."
        : `${changes.length} change(s). ` +
          (increasesExposure
            ? "At least one may increase what this offer costs; review it against a preview."
            : "All changes reduce or hold exposure."),
  };
}
