/**
 * An opt-in maintenance scheduler.
 *
 * The {@link MaintenanceRunner} deliberately owns no timer: `runDue` is called by
 * whatever the deployment already trusts to run things periodically - cron, a
 * Kubernetes CronJob, a queue consumer. Binding the platform to one scheduler
 * would be the same mistake as binding it to a metrics vendor, and the whole
 * point of `docs/07-operations/07-maintenance.md` is that the trigger is a
 * deployment choice.
 *
 * The gap that left behind is real, though: nothing in this repository ever
 * called `runDue`, so a deployment that forgot to schedule it leaked budget
 * silently. This module is the one-line answer for a deployment that has no
 * scheduler of its own and wants the platform to own the tick. It is a
 * convenience, not a requirement: call `start()` and forget it, or keep invoking
 * `runDue` yourself and never import this file.
 *
 * It is still in-process. A multi-process deployment runs it on one instance
 * only, or takes a lease - the jobs are idempotent, so duplicates are wasteful
 * rather than dangerous, exactly as they are for the runner itself.
 */
import type { MaintenanceRunner, MaintenanceReport } from "./maintenance.ts";
import type { Instant } from "../universal/temporal/chronology.ts";
import { instant } from "../universal/temporal/chronology.ts";
import type { Telemetry } from "../observability/telemetry.ts";
import { noopTelemetry } from "../observability/telemetry.ts";

export interface SchedulerOptions {
  /** The runner this scheduler triggers. Required. */
  readonly runner: MaintenanceRunner;
  /**
   * How often to check whether jobs are due. This is a poll interval, not a job
   * interval: each job still honours its own `intervalSeconds`, so a short tick
   * here only makes a due job start sooner, it never runs anything twice.
   */
  readonly intervalMs: number;
  /**
   * Which tenants to maintain. Usually one; a platform serving several keeps a
   * single scheduler with the full list rather than one timer per tenant.
   */
  readonly tenants: readonly string[];
  /** Wall clock, so tests do not wait. Defaults to real time. */
  readonly now?: () => Instant;
  /** Failure sink. A thrown job does not stop the scheduler. */
  readonly telemetry?: Telemetry;
  /**
   * What to do with each report. Logging it is the default; wiring it to an
   * alert or a dashboard replaces this.
   */
  readonly onReport?: (report: MaintenanceReport) => void;
}

/**
 * Owns one timer, and nothing else.
 *
 * Every tick asks the runner what is due. The runner decides; the scheduler only
 * asks. That separation is why a deployment with cron can ignore this class
 * entirely and call `runner.runDue` itself.
 */
export class MaintenanceScheduler {
  readonly #options: Required<Omit<SchedulerOptions, "onReport">> &
    Pick<SchedulerOptions, "onReport">;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: SchedulerOptions) {
    if (options.intervalMs < 1_000) {
      throw new RangeError(`scheduler interval must be at least 1000ms, got ${options.intervalMs}`);
    }
    if (options.tenants.length === 0) throw new RangeError("scheduler needs at least one tenant");
    this.#options = {
      runner: options.runner,
      intervalMs: options.intervalMs,
      tenants: options.tenants,
      now: options.now ?? defaultNow,
      telemetry: options.telemetry ?? noopTelemetry,
      onReport: options.onReport,
    };
  }

  /** Whether the timer is currently armed. */
  get running(): boolean {
    return this.#timer !== undefined;
  }

  /**
   * Arm the timer and return once the first tick has completed.
   *
   * The first tick runs immediately rather than after `intervalMs`, because a
   * scheduler that does nothing for a minute after start is the bug this class
   * exists to remove.
   */
  async start(): Promise<void> {
    if (this.#timer !== undefined) return;
    await this.#tick();
    this.#timer = setInterval(() => {
      void this.#tick();
    }, this.#options.intervalMs);
    // An armed timer keeps the event loop alive, which stops a CLI from ever
    // exiting. Unref lets the process end when the only thing left is waiting
    // for the next tick.
    this.#timer.unref?.();
  }

  /** Disarm the timer. Safe to call when not running. */
  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #tick(): Promise<void> {
    const now = this.#options.now();
    for (const tenant of this.#options.tenants) {
      const report = await this.#options.runner.runDue(tenant, now);
      if (report.ok) {
        this.#options.onReport?.(report.value);
        continue;
      }
      // A failed sweep is reported, not fatal: the next tick tries again, and
      // killing the scheduler over one bad job would stop every other job too.
      this.#options.telemetry.event({
        name: "goip.maintenance.scheduler_failed",
        severity: "error",
        message: `scheduled maintenance failed for tenant '${tenant}': ${report.error.message}`,
        labels: { tenant, code: report.error.code },
      });
    }
  }
}

const defaultNow = (): Instant => instant("earth.unix.ms", BigInt(Date.now()));
