/**
 * The metric catalogue.
 *
 * Names are data, not string literals scattered through the engines. That buys
 * three things: an exporter for any backend can be generated from this list, an
 * operator can read what exists without grepping, and a rename is one edit.
 *
 * Every entry says what it is for. A metric nobody can act on is noise, and the
 * `actionable` flag marks the ones worth an alert - see `alerts.ts`.
 */
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";

export type MetricKind = "counter" | "histogram" | "gauge";

export interface MetricDefinition extends RegistryEntry {
  readonly kind: MetricKind;
  /** "ms", "count", "percent", "minor_units", or "" for dimensionless. */
  readonly unit: string;
  /** Label names this metric is emitted with. */
  readonly labels: readonly string[];
  /** True when an operator should be able to alert on it directly. */
  readonly actionable?: boolean;
}

const m = (
  key: string,
  kind: MetricKind,
  unit: string,
  labels: readonly string[],
  description: string,
  actionable = false,
): MetricDefinition => ({ key, label: key, kind, unit, labels, description, actionable });

export const METRICS = {
  /* ---------------------------- decision ---------------------------- */
  decisionDuration: "goip.decision.duration",
  decisionCandidates: "goip.decision.candidates",
  decisionEligible: "goip.decision.eligible",
  decisionApplied: "goip.decision.applied",
  decisionSearchMode: "goip.decision.search_mode",
  decisionReduction: "goip.decision.reduction_minor",

  /* ---------------------------- context ----------------------------- */
  contextDuration: "goip.context.duration",
  resolverDuration: "goip.context.resolver.duration",
  resolverOutcome: "goip.context.resolver.outcome",

  /* ----------------------------- rules ------------------------------ */
  ruleNodes: "goip.rule.nodes_evaluated",
  ruleError: "goip.rule.error",

  /* -------------------------- eligibility --------------------------- */
  eligibilityFailed: "goip.eligibility.failed",

  /* --------------------------- execution ---------------------------- */
  executionReserved: "goip.execution.reserved",
  executionCaptured: "goip.execution.captured",
  executionReleased: "goip.execution.released",
  executionReversed: "goip.execution.reversed",
  executionReaped: "goip.execution.reaped",
  reserveDuration: "goip.execution.reserve.duration",
  captureDuration: "goip.execution.capture.duration",

  /* ---------------------------- funding ----------------------------- */
  fundingUtilisation: "goip.funding.utilisation",
  fundingInsufficient: "goip.funding.insufficient",

  /* ---------------------------- limits ------------------------------ */
  limitExceeded: "goip.limit.exceeded",

  /* --------------------------- governance --------------------------- */
  governanceRejected: "goip.governance.rejected",
  riskDisposition: "goip.risk.disposition",

  /* ---------------------------- health ------------------------------ */
  ledgerBalanced: "goip.ledger.balanced",
  auditVerified: "goip.audit.verified",
  auditRecords: "goip.audit.records",
  staleReservations: "goip.execution.stale",
  healthCheck: "goip.health.check",
} as const;

export const METRIC_DEFINITIONS: MetricDefinition[] = [
  m(METRICS.decisionDuration, "histogram", "ms", ["tenant", "reality"], "End-to-end decision latency, excluding context resolution."),
  m(METRICS.decisionCandidates, "histogram", "count", ["tenant"], "Exchanges considered. Rising means the campaign portfolio is growing."),
  m(METRICS.decisionEligible, "histogram", "count", ["tenant"], "Exchanges that passed eligibility. Approaching 10 means stacking is about to go greedy."),
  m(METRICS.decisionApplied, "histogram", "count", ["tenant"], "Exchanges in the winning combination."),
  m(METRICS.decisionSearchMode, "counter", "", ["tenant", "mode"], "Exhaustive or greedy. Greedy means the answer may not be optimal.", true),
  m(METRICS.decisionReduction, "histogram", "minor_units", ["tenant", "unit"], "Value taken off the price, in minor units."),

  m(METRICS.contextDuration, "histogram", "ms", ["tenant"], "Total context resolution time."),
  m(METRICS.resolverDuration, "histogram", "ms", ["resolver"], "Per-resolver time. The metric that finds the resolver making an external call.", true),
  m(METRICS.resolverOutcome, "counter", "", ["resolver", "outcome"], "applied / skipped / failed, per resolver."),

  m(METRICS.ruleNodes, "histogram", "count", ["tenant"], "Nodes and terms evaluated. Rising means conditions are getting complex."),
  m(METRICS.ruleError, "counter", "", ["tenant"], "A condition could not be evaluated. An authoring bug: the offer silently delivers nothing.", true),

  m(METRICS.eligibilityFailed, "counter", "", ["tenant", "check"], "Failures by check name. The single most useful metric here.", true),

  m(METRICS.executionReserved, "counter", "", ["tenant"], "Reservations taken."),
  m(METRICS.executionCaptured, "counter", "", ["tenant"], "Reservations captured."),
  m(METRICS.executionReleased, "counter", "", ["tenant", "reason"], "Reservations released, by reason."),
  m(METRICS.executionReversed, "counter", "", ["tenant"], "Captures reversed."),
  m(METRICS.executionReaped, "counter", "", ["tenant"], "Reservations released by the maintenance sweep."),
  m(METRICS.reserveDuration, "histogram", "ms", ["tenant"], "Reservation latency, including the transaction."),
  m(METRICS.captureDuration, "histogram", "ms", ["tenant"], "Capture latency, including the ledger write."),

  m(METRICS.fundingUtilisation, "gauge", "percent", ["tenant", "source"], "Committed as a percentage of budget.", true),
  m(METRICS.fundingInsufficient, "counter", "", ["tenant", "source"], "A benefit could not be funded. Customers are being refused a price they were shown.", true),

  m(METRICS.limitExceeded, "counter", "", ["tenant", "limit"], "Redemptions refused, by which limit blocked them."),

  m(METRICS.governanceRejected, "counter", "", ["tenant", "policy"], "Publications blocked, by policy."),
  m(METRICS.riskDisposition, "counter", "", ["tenant", "disposition"], "allow / review / block."),

  m(METRICS.ledgerBalanced, "gauge", "", ["tenant"], "1 when the ledger nets to zero in every unit. Anything else is an incident.", true),
  m(METRICS.auditVerified, "gauge", "", ["tenant"], "1 when the audit chain verifies. Anything else is a security incident.", true),
  m(METRICS.auditRecords, "gauge", "count", ["tenant"], "Records in the chain."),
  m(METRICS.staleReservations, "gauge", "count", ["tenant"], "Reservations older than the reaper threshold. Persistently non-zero means the sweep is not running.", true),
  m(METRICS.healthCheck, "counter", "", ["tenant", "check", "status"], "Health check outcomes."),
];

export function metricRegistry(): Registry<MetricDefinition> {
  return new Registry<MetricDefinition>("metric").registerAll(METRIC_DEFINITIONS);
}

/**
 * Render the catalogue for a scrape-based backend.
 *
 * Deliberately format-agnostic in shape: it emits the name, type, unit and help
 * text every such system wants, and an adapter maps that to its own syntax. A
 * Prometheus exporter is about fifteen lines on top of this.
 */
export function describeMetrics(): { name: string; type: MetricKind; unit: string; help: string; labels: readonly string[] }[] {
  return METRIC_DEFINITIONS.map((definition) => ({
    name: definition.key,
    type: definition.kind,
    unit: definition.unit,
    help: definition.description ?? "",
    labels: definition.labels,
  }));
}
