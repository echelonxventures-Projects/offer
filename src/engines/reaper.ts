/**
 * Reservation reaper.
 *
 * A reservation holds budget and a consumed limit. If the checkout it belongs
 * to is abandoned and nothing releases it, that budget is held forever - and a
 * campaign with plenty of money starts refusing customers. Nothing in the
 * platform expires them on its own, so something has to sweep.
 *
 * This is an *operational* job, not a consumer verb, so it is not a
 * twenty-third capability. The capability list is the platform's contract with
 * its callers and is deliberately closed; a maintenance sweep belongs on the
 * platform object, next to the other things an operator runs on a schedule.
 *
 * Idempotent and bounded: it releases at most `limit` reservations per sweep,
 * oldest first, and a reservation released by someone else in between simply
 * fails its own release and is counted as skipped rather than aborting the run.
 */
import type { Result } from "../kernel/result.ts";
import { ok } from "../kernel/result.ts";
import type { Instant } from "../universal/temporal/chronology.ts";
import type { EngineDeps } from "./deps.ts";
import type { ExecutionEngine } from "./execution.ts";

export interface SweepRequest {
  readonly tenant: string;
  /** How old a reservation must be before it is reaped, in seconds. */
  readonly olderThanSeconds: number;
  /** Maximum reservations to release in one sweep. Keeps the job bounded. */
  readonly limit?: number;
  /** Override "now"; the sweep otherwise asks the temporal authority. */
  readonly now?: Instant;
  readonly reason?: string;
}

export interface SweepReport {
  readonly examined: number;
  readonly released: number;
  /** Reservations that could not be released, with the reason. */
  readonly skipped: readonly { readonly executionId: string; readonly reason: string }[];
  /** The cut-off actually used, as a tick string, for the operator's log. */
  readonly cutoff: string;
}

/** Default only; the maintenance job passes the configured batch limit. */
export const DEFAULT_SWEEP_LIMIT = 100;

export class ReservationReaper {
  readonly #deps: EngineDeps;
  readonly #executions: ExecutionEngine;

  constructor(deps: EngineDeps, executions: ExecutionEngine) {
    this.#deps = deps;
    this.#executions = executions;
  }

  async sweep(request: SweepRequest): Promise<Result<SweepReport>> {
    const now = request.now ? ok(request.now) : this.#deps.temporal.now();
    if (!now.ok) return now;

    const cutoffTick = now.value.tick - BigInt(Math.round(request.olderThanSeconds * 1000));
    const cutoff = cutoffTick.toString();
    const limit = request.limit ?? DEFAULT_SWEEP_LIMIT;

    const stale = await this.#deps.store.executions.staleByState(request.tenant, "reserved", cutoff, limit);
    if (!stale.ok) return stale;

    const skipped: { executionId: string; reason: string }[] = [];
    let released = 0;

    for (const execution of stale.value) {
      const outcome = await this.#executions.release(
        request.tenant,
        execution.id,
        { tenant: request.tenant, instant: now.value, correlationId: `reaper:${cutoff}` },
        request.reason ?? "reaped: reservation expired without capture",
        "maintenance",
      );
      if (outcome.ok) {
        released += 1;
      } else {
        // Someone else released or captured it between the query and now.
        // That is a normal race, not a failure of the sweep.
        skipped.push({ executionId: execution.id, reason: outcome.error.message });
      }
    }

    return ok({ examined: stale.value.length, released, skipped, cutoff });
  }
}
