/**
 * Alert rules, as data.
 *
 * The shipped set is short on purpose. An alert nobody acts on trains everyone
 * to ignore the ones that matter, so each of these has a defined response in
 * docs/07-operations/06-runbook.md, and anything without one is a metric rather
 * than an alert.
 *
 * Severity is the response, not the feeling:
 *   page - somebody is woken up
 *   warn - somebody looks at it during working hours
 */
import type { RegistryEntry, Registry } from "../registry/registry.ts";
import { Registry as RegistryClass } from "../registry/registry.ts";
import type { Distribution, Labels, MetricSnapshot } from "./telemetry.ts";
import { METRICS } from "./metrics.ts";
import type { HealthReport } from "./health.ts";
import { compareKeys } from "../kernel/order.ts";

/** What an alert rule may read. `MemoryTelemetry` satisfies this. */
export interface MetricReader {
  counter(metric: string, labels?: Labels): number;
  counterTotal(metric: string): number;
  gaugeValue(metric: string, labels?: Labels): number | undefined;
  distribution(metric: string, labels?: Labels): Distribution | undefined;
  snapshot(): MetricSnapshot[];
}

export type AlertSeverity = "page" | "warn";

export interface AlertInput {
  readonly tenant: string;
  readonly metrics: MetricReader;
  readonly health?: HealthReport;
  /**
   * Increase in a counter since the previous evaluation.
   *
   * Counters are cumulative, so a rule written against a total latches: one
   * funding refusal at 09:00 would page every evaluation for the rest of the
   * process's life. Rules ask "what happened since I last looked" instead.
   */
  delta(metric: string, labels?: Labels): number;
}

export interface AlertFiring {
  readonly rule: string;
  readonly severity: AlertSeverity;
  readonly message: string;
  /** What to do. An alert without one is noise. */
  readonly runbook: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface AlertRule extends RegistryEntry {
  readonly severity: AlertSeverity;
  readonly runbook: string;
  evaluate(input: AlertInput): AlertFiring | null;
}

const fire = (rule: AlertRule, message: string, data?: Record<string, unknown>): AlertFiring => ({
  rule: rule.key,
  severity: rule.severity,
  message,
  runbook: rule.runbook,
  ...(data === undefined ? {} : { data }),
});

const checkStatus = (input: AlertInput, name: string) =>
  input.health?.checks.find((check) => check.name === name);

export const DEFAULT_ALERT_RULES: AlertRule[] = [
  {
    key: "ledger.unbalanced",
    label: "Ledger does not balance",
    description: "Value has been created or destroyed. This should be impossible: unbalanced transactions are refused at the write boundary.",
    severity: "page",
    runbook: "docs/07-operations/06-runbook.md#3-ledger-does-not-balance",
    evaluate(input) {
      const check = checkStatus(input, "ledger");
      const gauge = input.metrics.gaugeValue(METRICS.ledgerBalanced, { tenant: input.tenant });
      if (check?.status === "unhealthy" || gauge === 0) {
        return fire(this as AlertRule, "the ledger does not net to zero; stop financial capabilities and investigate", check?.data as Record<string, unknown>);
      }
      return null;
    },
  },
  {
    key: "audit.unverified",
    label: "Audit chain verification failed",
    description: "A stored record no longer matches its hash. Treat as a security incident, not a bug.",
    severity: "page",
    runbook: "docs/07-operations/06-runbook.md#4-audit-chain-verification-fails",
    evaluate(input) {
      const check = checkStatus(input, "audit");
      const gauge = input.metrics.gaugeValue(METRICS.auditVerified, { tenant: input.tenant });
      if (check?.status === "unhealthy" || gauge === 0) {
        return fire(this as AlertRule, "the audit chain does not verify; do not write to the audit store", check?.data as Record<string, unknown>);
      }
      return null;
    },
  },
  {
    key: "rules.broken",
    label: "A condition cannot be evaluated",
    description: "Looks like a client error and is not: the offer silently delivers nothing until the condition is fixed.",
    severity: "page",
    runbook: "docs/07-operations/06-runbook.md#2-rule_error-in-production",
    evaluate(input) {
      const count = input.delta(METRICS.ruleError, { tenant: input.tenant });
      if (count > 0) {
        return fire(this as AlertRule, `${count} condition(s) failed to evaluate; a campaign is delivering nothing`, { count });
      }
      return null;
    },
  },
  {
    key: "funding.exhausted",
    label: "A campaign cannot be funded",
    description: "Customers are being refused a price they may already have been shown.",
    severity: "page",
    runbook: "docs/07-operations/06-runbook.md#5-budget-exhausted-mid-campaign",
    evaluate(input) {
      const refusals = input.delta(METRICS.fundingInsufficient);
      const check = checkStatus(input, "funding");

      // Use the health detail only when health is what is wrong. Reporting a
      // healthy funding message while paging - which an earlier version did -
      // is worse than no alert at all.
      if (check?.status === "unhealthy") {
        return fire(this as AlertRule, check.detail, check.data as Record<string, unknown>);
      }
      if (refusals > 0) {
        return fire(
          this as AlertRule,
          `${refusals} benefit(s) could not be funded since the last check; customers are being refused a price they were shown`,
          { refusals },
        );
      }
      return null;
    },
  },
  {
    key: "funding.utilisation",
    label: "Budget nearly exhausted",
    severity: "warn",
    runbook: "docs/07-operations/06-runbook.md#5-budget-exhausted-mid-campaign",
    evaluate(input) {
      const check = checkStatus(input, "funding");
      if (check?.status === "degraded") {
        return fire(this as AlertRule, check.detail, check.data as Record<string, unknown>);
      }
      return null;
    },
  },
  {
    key: "stacking.greedy",
    label: "Stacking is no longer optimal",
    description: "More than ten offers were simultaneously eligible. Usually a campaign-portfolio problem, not an engineering one.",
    severity: "warn",
    runbook: "docs/07-operations/06-runbook.md#7-stacking-went-greedy",
    evaluate(input) {
      const greedy = input.delta(METRICS.decisionSearchMode, { tenant: input.tenant, mode: "greedy" });
      if (greedy > 0) {
        return fire(this as AlertRule, `${greedy} decision(s) fell back to a greedy search; tighten stacking groups`, { greedy });
      }
      return null;
    },
  },
  {
    key: "reservations.stale",
    label: "Reservations are piling up",
    description: "Budget is held by checkouts that were never captured or released. The sweep is probably not running.",
    severity: "warn",
    runbook: "docs/07-operations/06-runbook.md#6-reservations-accumulating",
    evaluate(input) {
      const check = checkStatus(input, "reservations");
      if (check?.status !== "healthy" && check !== undefined) {
        return fire(this as AlertRule, check.detail, check.data as Record<string, unknown>);
      }
      return null;
    },
  },
];

export function alertRuleRegistry(): Registry<AlertRule> {
  return new RegistryClass<AlertRule>("alert-rule").registerAll(DEFAULT_ALERT_RULES);
}

export class AlertEngine {
  readonly rules: Registry<AlertRule>;
  /** Counter totals at the previous evaluation, so rules can ask for deltas. */
  readonly #previous = new Map<string, number>();

  constructor(rules: Registry<AlertRule> = alertRuleRegistry()) {
    this.rules = rules;
  }

  /** Evaluate every rule. Pages first, then warnings, then by rule key. */
  evaluate(input: Omit<AlertInput, "delta">): AlertFiring[] {
    const seen = new Map<string, number>();

    const delta = (metric: string, labels?: Labels): number => {
      const key = labels === undefined ? metric : seriesKey(metric, labels);
      const current = labels === undefined ? input.metrics.counterTotal(metric) : input.metrics.counter(metric, labels);
      seen.set(key, current);
      return current - (this.#previous.get(key) ?? 0);
    };

    const withDelta: AlertInput = { ...input, delta };

    const firings: AlertFiring[] = [];
    for (const rule of this.rules.list()) {
      const firing = rule.evaluate(withDelta);
      if (firing) firings.push(firing);
    }

    // Only advance the baseline for series a rule actually read, so adding a
    // rule later does not silently start it at a non-zero baseline.
    for (const [key, value] of seen) this.#previous.set(key, value);

    return firings.sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === "page" ? -1 : 1) || compareKeys(a.rule, b.rule),
    );
  }

  /** Forget the baseline, so the next evaluation sees every counter in full. */
  reset(): void {
    this.#previous.clear();
  }
}

function seriesKey(metric: string, labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`);
  return parts.length === 0 ? metric : `${metric}{${parts.join(",")}}`;
}
