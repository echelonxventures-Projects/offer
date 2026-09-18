/**
 * Maintenance.
 *
 * Everything the platform needs run periodically, in one place, expressed as
 * jobs with intervals. The runner does **not** own a timer: the host calls
 * `runDue(tenant, now)` and the runner decides what is due.
 *
 * That split is deliberate. cron, a setInterval, a Kubernetes CronJob, a Lambda
 * on a schedule and a queue consumer are all the same thing from here - "call
 * this when due" - and binding the platform to one of them would be the same
 * mistake as binding it to a metrics vendor.
 *
 * Jobs are not capabilities. The capability list is the platform's contract
 * with its callers and is closed at twenty-two; a maintenance sweep is
 * something an operator runs, not something a consumer invokes.
 */
import type { Result } from "../kernel/result.ts";
import { ok } from "../kernel/result.ts";
import type { RegistryEntry, Registry } from "../registry/registry.ts";
import { Registry as RegistryClass } from "../registry/registry.ts";
import type { Instant } from "../universal/temporal/chronology.ts";
import type { Telemetry } from "../observability/telemetry.ts";
import type { HealthEngine, HealthReport } from "../observability/health.ts";
import type { AlertEngine, AlertFiring, MetricReader } from "../observability/alerts.ts";
import type { AuditService } from "../audit/audit-service.ts";
import type { ReconciliationService } from "../ledger/reconciliation.ts";
import type { ReservationReaper } from "../engines/reaper.ts";
import { compareKeys } from "../kernel/order.ts";

export interface MaintenanceConfigView {
  readonly sweepBatchLimit: number;
  readonly staleReservationSeconds: number;
}

export interface MaintenanceContext {
  readonly tenant: string;
  readonly now: Instant;
  readonly config: MaintenanceConfigView;
  readonly reaper: ReservationReaper;
  readonly audit: AuditService;
  readonly reconciliation: ReconciliationService;
  readonly health: HealthEngine;
  readonly telemetry: Telemetry;
}

export interface JobOutcome {
  /** One line for an operator's log. */
  readonly summary: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface MaintenanceJob extends RegistryEntry {
  /** How often this should run. The runner enforces it; the host does not. */
  readonly intervalSeconds: number;
  /**
   * Lower runs first. Explicit because alphabetical order put the health check
   * before the sweep, so it reported stale reservations the sweep was about to
   * release - a report that was true when taken and wrong by the time anyone
   * read it.
   */
  readonly order: number;
  /** Skip rather than fail when a prerequisite is absent (no anchor configured). */
  readonly optional?: boolean;
  run(context: MaintenanceContext): Promise<Result<JobOutcome>>;
}

export interface JobReport {
  readonly job: string;
  readonly status: "ran" | "skipped" | "failed" | "not_due";
  readonly summary: string;
  readonly durationMs: number;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface MaintenanceReport {
  readonly tenant: string;
  readonly at: string;
  readonly jobs: readonly JobReport[];
  readonly ran: number;
  readonly failed: number;
  readonly health?: HealthReport;
  readonly alerts: readonly AlertFiring[];
}

/* ------------------------------------------------------------------ *
 * Shipped jobs
 * ------------------------------------------------------------------ */

export const DEFAULT_MAINTENANCE_JOBS: MaintenanceJob[] = [
  {
    key: "reservations.sweep",
    order: 10,
    label: "Release stale reservations",
    description:
      "Without this, an abandoned checkout holds budget forever and a campaign with money left starts refusing customers. The most important job here.",
    intervalSeconds: 300,
    async run({ tenant, now, reaper, config }) {
      const swept = await reaper.sweep({
        tenant,
        olderThanSeconds: config.staleReservationSeconds,
        limit: config.sweepBatchLimit,
        now,
      });
      if (!swept.ok) return swept;
      return ok({
        summary:
          swept.value.released === 0
            ? "no stale reservations"
            : `released ${swept.value.released} stale reservation(s)`,
        data: {
          examined: swept.value.examined,
          released: swept.value.released,
          skipped: swept.value.skipped.length,
        },
      });
    },
  },
  {
    key: "audit.checkpoint",
    order: 20,
    label: "Checkpoint the audit chain",
    description: "Verify forward from the last checkpoint so verification does not become O(all of history).",
    intervalSeconds: 3600,
    async run({ tenant, now, audit }) {
      const checkpointed = await audit.checkpoint(tenant, now);
      if (!checkpointed.ok) {
        // An empty chain is not a failure; there is simply nothing to trust yet.
        if (checkpointed.error.code === "NOT_FOUND") {
          return ok({ summary: "no audit records to checkpoint" });
        }
        return checkpointed;
      }
      return ok({
        summary: `verified ${checkpointed.value.verified} record(s) and checkpointed at seq ${checkpointed.value.checkpoint.seq}`,
        data: { seq: checkpointed.value.checkpoint.seq, verified: checkpointed.value.verified },
      });
    },
  },
  {
    key: "audit.anchor",
    order: 30,
    label: "Publish the audit head externally",
    description:
      "Without an anchor, an attacker who can rewrite the whole chain can forge it consistently and verification will pass.",
    intervalSeconds: 3600,
    optional: true,
    async run({ tenant, now, audit }) {
      const published = await audit.anchor(tenant, "maintenance", now);
      if (!published.ok) {
        if (published.error.code === "NOT_FOUND") return ok({ summary: "no audit records to anchor" });
        return published;
      }
      return ok({
        summary: `anchored seq ${published.value.seq}`,
        data: { seq: published.value.seq, hash: published.value.hash },
      });
    },
  },
  {
    key: "audit.reconcile",
    order: 40,
    label: "Compare the chain against the anchor",
    description: "The check that actually detects a wholesale rewrite.",
    intervalSeconds: 3600,
    optional: true,
    async run({ tenant, audit }) {
      const reconciled = await audit.reconcileWithAnchor(tenant);
      if (!reconciled.ok) return reconciled;
      return ok({ summary: reconciled.value.detail, data: { status: reconciled.value.status } });
    },
  },
  {
    key: "ledger.snapshot",
    order: 50,
    label: "Snapshot ledger balances",
    description:
      "Records a trusted starting point so reconciliation folds only new entries. Without it, answering " +
      "'what is each account worth' rescans the fastest-growing table in the system, forever - and the " +
      "health check does that every minute.",
    intervalSeconds: 3600,
    async run({ tenant, now, reconciliation }) {
      const snapshot = await reconciliation.snapshot(tenant, now);
      if (!snapshot.ok) {
        // An empty ledger is not a failure; there is simply nothing to trust yet.
        if (snapshot.error.code === "NOT_FOUND") return ok({ summary: "no ledger entries to snapshot" });
        // An unbalanced one IS a failure, and a loud one: snapshotting a hole
        // would make it permanent.
        return snapshot;
      }
      return ok({
        summary: `snapshotted ${snapshot.value.positions.length} account position(s) through entry ${snapshot.value.throughSeq}`,
        data: { throughSeq: snapshot.value.throughSeq, positions: snapshot.value.positions.length },
      });
    },
  },
  {
    key: "health.check",
    order: 90,
    label: "Integrity health check",
    description: "Ledger balance, audit verification, funding headroom, stale reservations.",
    intervalSeconds: 60,
    async run({ tenant, now, health }) {
      const report = await health.check(tenant, { now });
      if (!report.ok) return report;
      return ok({
        summary: `health is ${report.value.status}`,
        data: {
          status: report.value.status,
          checks: report.value.checks.map((check) => `${check.name}=${check.status}`),
        },
      });
    },
  },
];

export function maintenanceJobRegistry(): Registry<MaintenanceJob> {
  return new RegistryClass<MaintenanceJob>("maintenance-job").registerAll(DEFAULT_MAINTENANCE_JOBS);
}

/* ------------------------------------------------------------------ */

export interface MaintenanceRunnerOptions {
  readonly jobs?: Registry<MaintenanceJob>;
  readonly alerts?: AlertEngine;
  /** Where alert rules read metrics from. Omit to skip alert evaluation. */
  readonly metrics?: MetricReader;
}

export class MaintenanceRunner {
  readonly jobs: Registry<MaintenanceJob>;
  readonly #context: Omit<MaintenanceContext, "tenant" | "now">;
  readonly #alerts?: AlertEngine;
  readonly #metrics?: MetricReader;
  /**
   * Last-run times, per tenant and job, held in process.
   *
   * A multi-process deployment needs a lease instead, or every instance runs
   * every job. The sweep and the checkpoint are both idempotent so duplicate
   * runs are harmless rather than dangerous - but they are wasteful, and
   * `docs/07-operations/07-maintenance.md` says what to do about it.
   */
  readonly #lastRun = new Map<string, bigint>();

  constructor(context: Omit<MaintenanceContext, "tenant" | "now">, options: MaintenanceRunnerOptions = {}) {
    this.#context = context;
    this.jobs = options.jobs ?? maintenanceJobRegistry();
    if (options.alerts) this.#alerts = options.alerts;
    if (options.metrics) this.#metrics = options.metrics;
  }

  /** Run every job whose interval has elapsed. Called by whatever schedules it. */
  async runDue(tenant: string, now: Instant): Promise<Result<MaintenanceReport>> {
    return this.#run(tenant, now, false);
  }

  /** Run every job regardless of interval. For an operator forcing a pass. */
  async runAll(tenant: string, now: Instant): Promise<Result<MaintenanceReport>> {
    return this.#run(tenant, now, true);
  }

  async #run(tenant: string, now: Instant, force: boolean): Promise<Result<MaintenanceReport>> {
    const context: MaintenanceContext = { ...this.#context, tenant, now };
    const reports: JobReport[] = [];
    let ran = 0;
    let failed = 0;
    let health: HealthReport | undefined;

    for (const job of [...this.jobs.list()].sort((a, b) => a.order - b.order || compareKeys(a.key, b.key))) {
      const key = `${tenant}/${job.key}`;
      const last = this.#lastRun.get(key);
      const dueAt = last === undefined ? now.tick : last + BigInt(Math.round(job.intervalSeconds * 1000));

      if (!force && last !== undefined && now.tick < dueAt) {
        reports.push({
          job: job.key,
          status: "not_due",
          summary: `next run in ${Number(dueAt - now.tick) / 1000}s`,
          durationMs: 0,
        });
        continue;
      }

      const started = Date.now();
      const outcome = await job.run(context);
      const durationMs = Date.now() - started;
      this.#lastRun.set(key, now.tick);

      if (!outcome.ok) {
        // An optional job whose prerequisite is absent is a skip, not a failure:
        // no anchor configured is a deployment choice, not an incident.
        if (job.optional && outcome.error.code === "NOT_IMPLEMENTED") {
          reports.push({ job: job.key, status: "skipped", summary: outcome.error.message, durationMs });
          continue;
        }
        failed += 1;
        reports.push({ job: job.key, status: "failed", summary: outcome.error.message, durationMs, data: { ...outcome.error.details } });
        this.#context.telemetry.event({
          name: "goip.maintenance.failed",
          severity: "error",
          message: `maintenance job '${job.key}' failed: ${outcome.error.message}`,
          labels: { tenant, job: job.key },
        });
        continue;
      }

      ran += 1;
      reports.push({
        job: job.key,
        status: "ran",
        summary: outcome.value.summary,
        durationMs,
        ...(outcome.value.data === undefined ? {} : { data: outcome.value.data }),
      });
    }

    // The health job populates the gauges the alert rules read, so alerts are
    // evaluated after every job has run, never before.
    const healthReport = await this.#context.health.check(tenant, { now });
    if (healthReport.ok) health = healthReport.value;

    const alerts =
      this.#alerts && this.#metrics
        ? this.#alerts.evaluate({ tenant, metrics: this.#metrics, ...(health === undefined ? {} : { health }) })
        : [];

    for (const alert of alerts) {
      this.#context.telemetry.event({
        name: `goip.alert.${alert.rule}`,
        severity: alert.severity === "page" ? "error" : "warn",
        message: alert.message,
        labels: { tenant, rule: alert.rule },
        ...(alert.data === undefined ? {} : { data: alert.data }),
      });
    }

    return ok({
      tenant,
      at: now.tick.toString(),
      jobs: reports,
      ran,
      failed,
      ...(health === undefined ? {} : { health }),
      alerts,
    });
  }
}
