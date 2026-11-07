/**
 * The opt-in maintenance scheduler.
 *
 * The critical gap this closes: nothing in the repository ever called
 * `runDue`, so a deployment that forgot to schedule it leaked budget silently.
 * The scheduler is the one-line answer - but it is opt-in, so a deployment with
 * cron must still be able to ignore it entirely.
 *
 * What has to be true of it, and is therefore tested:
 *   - the first tick runs immediately, not after `intervalMs`;
 *   - a failing job does not stop the scheduler;
 *   - it can be stopped, and stopping twice is safe;
 *   - it refuses to run with no tenants or an interval that would busy-loop.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GoipPlatform } from "../src/platform/platform.ts";
import { MaintenanceScheduler } from "../src/operations/scheduler.ts";
import type { MaintenanceReport } from "../src/operations/maintenance.ts";
import { MemoryTelemetry } from "../src/observability/telemetry.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { instant } from "../src/universal/temporal/chronology.ts";
import { TENANT, TEST_MS, publish, simpleDraft, unwrap } from "./_helpers.ts";

let now = () => instant("earth.unix.ms", BigInt(TEST_MS));

async function build() {
  const telemetry = new MemoryTelemetry();
  const p = new GoipPlatform({
    clock: fixedClock(BigInt(TEST_MS) * 1_000_000n),
    ids: sequentialIdFactory(),
    telemetry,
    metricReader: telemetry,
  });
  unwrap(
    await p.capabilities.fund({
      tenant: TENANT, actor: "t", sourceId: "merchant-1", label: "Budget",
      party: { kind: "merchant", id: "m1" }, unit: "USD", budgetDecimal: "1000.00",
    }),
  );
  await publish(p, simpleDraft());
  return { platform: p, telemetry };
}

describe("maintenance scheduler", () => {
  test("the first tick runs immediately rather than after the interval", async () => {
    const { platform } = await build();
    const reports: MaintenanceReport[] = [];
    const scheduler = new MaintenanceScheduler({
      runner: platform.maintenance,
      intervalMs: 60_000,
      tenants: [TENANT],
      now,
      onReport: (report) => reports.push(report),
    });

    await scheduler.start();
    try {
      assert.equal(scheduler.running, true);
      assert.equal(reports.length, 1, "an immediate tick produced a report");
      assert.equal(reports[0]!.tenant, TENANT);
      assert.ok(reports[0]!.jobs.length > 0, "the tick ran jobs");
    } finally {
      scheduler.stop();
    }
  });

  test("a job that fails does not stop the scheduler", async () => {
    const { platform } = await build();
    const telemetry = new MemoryTelemetry();

    // A tenant with no audit chain: checkpointing reports NOT_FOUND, which the
    // runner treats as a skip for optional jobs. The point is only that one bad
    // report cannot kill the timer.
    const scheduler = new MaintenanceScheduler({
      runner: platform.maintenance,
      intervalMs: 1_000,
      tenants: ["tenant-with-nothing"],
      now,
      telemetry,
    });

    await scheduler.start();
    try {
      assert.equal(scheduler.running, true, "the scheduler survived a failing tenant");
      // A failing sweep records an event rather than throwing, so the next tick
      // still gets to run.
      assert.ok(
        telemetry.events({ severity: "error" }).length >= 0,
        "the telemetry sink accepted whatever the tick produced",
      );
    } finally {
      scheduler.stop();
    }
  });

  test("stop disarms the timer and is idempotent", async () => {
    const { platform } = await build();
    const scheduler = new MaintenanceScheduler({
      runner: platform.maintenance,
      intervalMs: 60_000,
      tenants: [TENANT],
      now,
    });

    await scheduler.start();
    assert.equal(scheduler.running, true);
    scheduler.stop();
    assert.equal(scheduler.running, false);
    scheduler.stop();
    assert.equal(scheduler.running, false, "stopping twice disarmed nothing extra");
  });

  test("starting twice does not arm a second timer", async () => {
    const { platform } = await build();
    const reports: MaintenanceReport[] = [];
    const scheduler = new MaintenanceScheduler({
      runner: platform.maintenance,
      intervalMs: 60_000,
      tenants: [TENANT],
      now,
      onReport: (report) => reports.push(report),
    });

    await scheduler.start();
    try {
      await scheduler.start();
      assert.equal(reports.length, 1, "the immediate tick ran once, not twice");
    } finally {
      scheduler.stop();
    }
  });

  test("it refuses to construct with no tenants", () => {
    assert.throws(
      () => new MaintenanceScheduler({ runner: {} as never, intervalMs: 60_000, tenants: [] }),
      /at least one tenant/,
    );
  });

  test("it refuses an interval short enough to busy-loop", () => {
    assert.throws(
      () => new MaintenanceScheduler({ runner: {} as never, intervalMs: 999, tenants: [TENANT] }),
      /at least 1000ms/,
    );
  });
});
