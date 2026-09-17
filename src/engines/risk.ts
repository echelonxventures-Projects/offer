/**
 * Risk and Fraud Engine.
 *
 * Signals score a context; the engine sums their weighted contributions and
 * compares the total to two thresholds. It returns `allow`, `review` or
 * `block`, and always says which signals fired.
 *
 * The scoring is deliberately simple and deliberately explainable. A model that
 * cannot say why it blocked a redemption cannot be appealed, and every incentive
 * platform eventually has to explain a block to a real customer. A tenant that
 * wants a learned model registers it as one more signal and keeps the
 * explanation surface intact.
 */
import type { Result } from "../kernel/result.ts";
import { ok } from "../kernel/result.ts";
import type { RegistryEntry, Registry } from "../registry/registry.ts";
import { Registry as RegistryClass } from "../registry/registry.ts";
import type { ResolvedContext } from "../context/context.ts";
import type { ValueExchange } from "../model/value-exchange.ts";
import type { EngineDeps } from "./deps.ts";

export interface RiskInput {
  readonly context: ResolvedContext;
  /** The exchanges about to be applied, when the assessment follows a decision. */
  readonly exchanges?: readonly ValueExchange[];
  readonly deps: EngineDeps;
}

export interface SignalOutcome {
  /** 0 means "nothing seen"; 100 means "as suspicious as this signal gets". */
  readonly score: number;
  readonly reason: string;
}

export interface RiskSignal extends RegistryEntry {
  /** Multiplier applied to this signal's score. */
  readonly weight: number;
  evaluate(input: RiskInput): Result<SignalOutcome>;
}

export type RiskDisposition = "allow" | "review" | "block";

export interface RiskAssessment {
  readonly score: number;
  readonly disposition: RiskDisposition;
  readonly signals: readonly { readonly signal: string; readonly score: number; readonly reason: string }[];
}

export interface RiskThresholds {
  readonly review: number;
  readonly block: number;
}

export const DEFAULT_THRESHOLDS: RiskThresholds = { review: 50, block: 80 };

export const DEFAULT_SIGNALS: RiskSignal[] = [
  {
    key: "velocity",
    label: "Redemption velocity",
    description: "A subject redeeming far more often than a normal customer.",
    weight: 1,
    evaluate({ context }) {
      const recent = context.subject.counters["redemptions.recent"] ?? 0;
      const score = recent >= 10 ? 90 : recent >= 5 ? 55 : recent >= 3 ? 25 : 0;
      return ok({ score, reason: `${recent} recent redemption(s)` });
    },
  },
  {
    key: "anonymous_high_value",
    label: "High value to an anonymous subject",
    description: "Anonymous traffic is fine; anonymous traffic taking large benefits is worth a look.",
    weight: 1,
    evaluate({ context }) {
      if (!context.subject.anonymous) return ok({ score: 0, reason: "subject is identified" });
      const subtotal = context.cart?.subtotal;
      if (!subtotal) return ok({ score: 10, reason: "anonymous subject, no cart" });
      const wholeUnits = Number(subtotal.minor / 10n ** BigInt(subtotal.scale));
      const score = wholeUnits > 1000 ? 70 : wholeUnits > 250 ? 40 : 10;
      return ok({ score, reason: `anonymous subject with a basket of ${wholeUnits} ${subtotal.unit}` });
    },
  },
  {
    key: "jurisdiction_mismatch",
    label: "Jurisdiction mismatch",
    description: "The subject's declared jurisdiction differs from where the interaction is happening.",
    weight: 1,
    evaluate({ context }) {
      const declared = context.subject.attributes["jurisdiction"];
      const actual = context.spatial.jurisdiction;
      if (typeof declared !== "string" || !actual) return ok({ score: 0, reason: "nothing to compare" });
      return ok(
        declared === actual
          ? { score: 0, reason: `both ${actual}` }
          : { score: 45, reason: `subject declares ${declared}, interaction is in ${actual}` },
      );
    },
  },
  {
    key: "new_subject_large_benefit",
    label: "New subject taking a large benefit",
    weight: 1,
    evaluate({ context }) {
      const lifetime = context.subject.counters["orders.lifetime"] ?? 0;
      if (lifetime > 0) return ok({ score: 0, reason: `${lifetime} prior order(s)` });
      const score = context.subject.anonymous ? 30 : 20;
      return ok({ score, reason: "first interaction for this subject" });
    },
  },
];

export function riskSignalRegistry(): Registry<RiskSignal> {
  return new RegistryClass<RiskSignal>("risk-signal").registerAll(DEFAULT_SIGNALS);
}

export class RiskEngine {
  readonly signals: Registry<RiskSignal>;
  readonly #thresholds: RiskThresholds;
  readonly #deps: EngineDeps;

  constructor(deps: EngineDeps, signals: Registry<RiskSignal>, thresholds: RiskThresholds = DEFAULT_THRESHOLDS) {
    this.#deps = deps;
    this.signals = signals;
    this.#thresholds = thresholds;
  }

  assess(context: ResolvedContext, exchanges?: readonly ValueExchange[]): Result<RiskAssessment> {
    const input: RiskInput = {
      context,
      deps: this.#deps,
      ...(exchanges === undefined ? {} : { exchanges }),
    };

    const fired: { signal: string; score: number; reason: string }[] = [];
    let weighted = 0;
    let totalWeight = 0;

    for (const signal of this.signals.list()) {
      const outcome = signal.evaluate(input);
      if (!outcome.ok) return outcome;
      totalWeight += signal.weight;
      weighted += outcome.value.score * signal.weight;
      if (outcome.value.score > 0) {
        fired.push({ signal: signal.key, score: outcome.value.score, reason: outcome.value.reason });
      }
    }

    // Mean rather than sum: adding a signal must not inflate every score.
    const score = totalWeight === 0 ? 0 : Math.round(weighted / totalWeight);
    const disposition: RiskDisposition =
      score >= this.#thresholds.block ? "block" : score >= this.#thresholds.review ? "review" : "allow";

    return ok({ score, disposition, signals: fired.sort((a, b) => b.score - a.score) });
  }
}
