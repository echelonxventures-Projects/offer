/**
 * Health.
 *
 * Four checks, chosen because each one is a question an operator would
 * otherwise have to answer by hand at three in the morning:
 *
 *   ledger      - has value been created or destroyed?
 *   audit       - has stored history been altered?
 *   funding     - is a campaign about to start refusing customers?
 *   reservations - is the maintenance sweep actually running?
 *
 * Deliberately not a liveness probe. This is an *integrity* check: it reads
 * real state and can be slow, so a deployment should run it on a schedule and
 * serve the cached result, not run it per request.
 */
import type { Result } from "../kernel/result.ts";
import { ok } from "../kernel/result.ts";
import type { Instant } from "../universal/temporal/chronology.ts";
import { reconcile, verifyLedger } from "../ledger/payout.ts";
import { availableOf } from "../ledger/settlement.ts";
import type { EngineDeps } from "../engines/deps.ts";
import { METRICS } from "./metrics.ts";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheck {
  readonly name: string;
  readonly status: HealthStatus;
  readonly detail: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface HealthReport {
  readonly tenant: string;
  readonly status: HealthStatus;
  readonly checks: readonly HealthCheck[];
  readonly at: string;
  /** Milliseconds the report took to produce. */
  readonly durationMs: number;
}

export interface HealthOptions {
  /** Warn above this budget utilisation. */
  readonly fundingWarnPercent?: number;
  /** A reservation older than this is stale. */
  readonly staleReservationSeconds?: number;
  /** Verify the audit chain from this sequence rather than from genesis. */
  readonly auditFromSeq?: number;
  readonly now?: Instant;
}

const WORST: Record<HealthStatus, number> = { healthy: 0, degraded: 1, unhealthy: 2 };

export class HealthEngine {
  readonly #deps: EngineDeps;
  readonly #defaults: { fundingWarnPercent: number; staleReservationSeconds: number };

  constructor(
    deps: EngineDeps,
    defaults: { fundingWarnPercent: number; staleReservationSeconds: number } = {
      fundingWarnPercent: 80,
      staleReservationSeconds: 3600,
    },
  ) {
    this.#deps = deps;
    this.#defaults = defaults;
  }

  async check(tenant: string, options: HealthOptions = {}): Promise<Result<HealthReport>> {
    const started = Date.now();
    const now = options.now ? ok(options.now) : this.#deps.temporal.now();
    if (!now.ok) return now;

    const checks: HealthCheck[] = [
      await this.#ledger(tenant),
      await this.#audit(tenant, options.auditFromSeq),
      await this.#funding(tenant, options.fundingWarnPercent ?? this.#defaults.fundingWarnPercent),
      await this.#reservations(
        tenant,
        options.staleReservationSeconds ?? this.#defaults.staleReservationSeconds,
        now.value,
      ),
    ];

    let status: HealthStatus = "healthy";
    for (const check of checks) {
      if (WORST[check.status] > WORST[status]) status = check.status;
      this.#deps.telemetry.count(METRICS.healthCheck, 1, { tenant, check: check.name, status: check.status });
    }

    return ok({
      tenant,
      status,
      checks,
      at: now.value.tick.toString(),
      durationMs: Date.now() - started,
    });
  }

  /** Does the ledger net to zero in every unit? Anything else is an incident. */
  async #ledger(tenant: string): Promise<HealthCheck> {
    const entries = await this.#deps.store.ledger.all(tenant);
    if (!entries.ok) {
      return { name: "ledger", status: "unhealthy", detail: entries.error.message };
    }
    const verified = verifyLedger(entries.value);
    this.#deps.telemetry.gauge(METRICS.ledgerBalanced, verified.ok ? 1 : 0, { tenant });

    if (verified.ok) {
      return {
        name: "ledger",
        status: "healthy",
        detail: `${entries.value.length} entries net to zero in ${verified.value.units.length} unit(s)`,
        data: { entries: entries.value.length, units: verified.value.units },
      };
    }
    return {
      name: "ledger",
      status: "unhealthy",
      detail: "the ledger does not net to zero; value has been created or destroyed",
      data: { ...verified.error.details, positions: reconcile(entries.value).length },
    };
  }

  /** Does the audit chain still verify? */
  async #audit(tenant: string, fromSeq?: number): Promise<HealthCheck> {
    const verified = await this.#deps.store.audit.verify(tenant, fromSeq);
    this.#deps.telemetry.gauge(METRICS.auditVerified, verified.ok ? 1 : 0, { tenant });

    if (verified.ok) {
      this.#deps.telemetry.gauge(METRICS.auditRecords, verified.value.records, { tenant });
      return {
        name: "audit",
        status: "healthy",
        detail: `${verified.value.records} record(s) verified${fromSeq ? ` from seq ${fromSeq}` : ""}`,
        data: { records: verified.value.records, head: verified.value.head },
      };
    }
    return {
      name: "audit",
      status: "unhealthy",
      detail: verified.error.message,
      data: { ...verified.error.details },
    };
  }

  /** Is any funding source close to refusing customers? */
  async #funding(tenant: string, warnPercent: number): Promise<HealthCheck> {
    const sources = await this.#deps.store.funding.list(tenant);
    if (!sources.ok) {
      return { name: "funding", status: "unhealthy", detail: sources.error.message };
    }

    const strained: { sourceId: string; utilisation: number }[] = [];
    let exhausted = 0;

    for (const source of sources.value) {
      if (!source.budget || source.budget.minor === 0n) continue;
      const committed = source.reserved.minor + source.spent.minor;
      const utilisation = Number((committed * 10_000n) / source.budget.minor) / 100;
      this.#deps.telemetry.gauge(METRICS.fundingUtilisation, utilisation, { tenant, source: source.id });

      const available = availableOf(source);
      if (available !== null && available.minor <= 0n) exhausted += 1;
      if (utilisation >= warnPercent) strained.push({ sourceId: source.id, utilisation });
    }

    if (exhausted > 0) {
      return {
        name: "funding",
        status: "unhealthy",
        detail: `${exhausted} funding source(s) exhausted; those campaigns are refusing customers`,
        data: { exhausted, strained },
      };
    }
    if (strained.length > 0) {
      return {
        name: "funding",
        status: "degraded",
        detail: `${strained.length} source(s) above ${warnPercent}% utilisation`,
        data: { strained },
      };
    }
    return {
      name: "funding",
      status: "healthy",
      detail: `${sources.value.length} source(s), none above ${warnPercent}%`,
    };
  }

  /**
   * Are reservations piling up?
   *
   * Persistently non-zero means the maintenance sweep is not running, and
   * budget is leaking. This is the check that would have caught the single most
   * likely first production incident.
   */
  async #reservations(tenant: string, staleSeconds: number, now: Instant): Promise<HealthCheck> {
    const cutoff = (now.tick - BigInt(Math.round(staleSeconds * 1000))).toString();
    const stale = await this.#deps.store.executions.staleByState(tenant, "reserved", cutoff, 1000);
    if (!stale.ok) {
      return { name: "reservations", status: "unhealthy", detail: stale.error.message };
    }
    this.#deps.telemetry.gauge(METRICS.staleReservations, stale.value.length, { tenant });

    if (stale.value.length === 0) {
      return { name: "reservations", status: "healthy", detail: `no reservations older than ${staleSeconds}s` };
    }
    return {
      name: "reservations",
      status: "degraded",
      detail: `${stale.value.length} reservation(s) older than ${staleSeconds}s are holding budget; is the sweep running?`,
      data: { stale: stale.value.length, oldest: stale.value[0]?.id },
    };
  }
}
