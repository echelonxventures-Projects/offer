/**
 * Telemetry, health and alerting.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MemoryTelemetry, fixedStopwatch, multiTelemetry, percentile } from "../src/observability/telemetry.ts";
import { METRICS, METRIC_DEFINITIONS, describeMetrics } from "../src/observability/metrics.ts";
import { AlertEngine } from "../src/observability/alerts.ts";
import { GoipPlatform } from "../src/platform/platform.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { instant } from "../src/universal/temporal/chronology.ts";
import { MemoryPlatformStore } from "../src/adapters/memory-store.ts";
import { TENANT, TEST_MS, cartContext, publish, publishUnchecked, simpleDraft, unwrap } from "./_helpers.ts";

const at = (ms: number) => instant("earth.unix.ms", BigInt(ms));

/** A platform wired to a collector, so the tests can read what was emitted. */
async function instrumented(atMs = TEST_MS) {
  const telemetry = new MemoryTelemetry({ stopwatch: fixedStopwatch() });
  const store = new MemoryPlatformStore();
  const platform = new GoipPlatform({
    clock: fixedClock(BigInt(atMs) * 1_000_000n),
    ids: sequentialIdFactory(),
    store,
    telemetry,
    metricReader: telemetry,
  });
  unwrap(
    await platform.capabilities.fund({
      tenant: TENANT, actor: "t", sourceId: "merchant-1", label: "Budget",
      party: { kind: "merchant", id: "m1" }, unit: "USD", budgetDecimal: "10000.00",
    }),
  );
  return { platform, telemetry, store };
}

describe("telemetry collector", () => {
  test("accumulates counters per label set", () => {
    const t = new MemoryTelemetry();
    t.count("m", 1, { a: "1" });
    t.count("m", 2, { a: "1" });
    t.count("m", 5, { a: "2" });
    assert.equal(t.counter("m", { a: "1" }), 3);
    assert.equal(t.counter("m", { a: "2" }), 5);
    assert.equal(t.counterTotal("m"), 8);
  });

  test("label order does not create a second series", () => {
    const t = new MemoryTelemetry();
    t.count("m", 1, { a: "1", b: "2" });
    t.count("m", 1, { b: "2", a: "1" });
    assert.equal(t.counter("m", { a: "1", b: "2" }), 2);
  });

  test("histograms report distribution and percentiles", () => {
    const t = new MemoryTelemetry();
    for (const value of [10, 20, 30, 40, 50]) t.observe("d", value);
    const distribution = t.distribution("d")!;
    assert.equal(distribution.count, 5);
    assert.equal(distribution.sum, 150);
    assert.equal(distribution.min, 10);
    assert.equal(distribution.max, 50);
    assert.equal(percentile(distribution, 50), 30);
    assert.equal(percentile(distribution, 100), 50);
  });

  test("timers record elapsed milliseconds from an injected stopwatch", () => {
    const stopwatch = fixedStopwatch(1000);
    const t = new MemoryTelemetry({ stopwatch });
    const stop = t.timer("op");
    stopwatch.advance(42);
    stop();
    assert.equal(t.distribution("op")!.max, 42);
  });

  test("samples are capped, so a collector cannot become the outage", () => {
    const t = new MemoryTelemetry({ maxSamples: 10 });
    for (let i = 0; i < 100; i += 1) t.observe("d", i);
    const distribution = t.distribution("d")!;
    assert.equal(distribution.count, 10);
    assert.equal(distribution.max, 99, "the most recent samples are kept");
  });

  test("gauges replace rather than accumulate", () => {
    const t = new MemoryTelemetry();
    t.gauge("g", 1);
    t.gauge("g", 7);
    assert.equal(t.gaugeValue("g"), 7);
  });

  test("multiTelemetry fans out to every sink", () => {
    const a = new MemoryTelemetry();
    const b = new MemoryTelemetry();
    const both = multiTelemetry(a, b);
    both.count("m", 3);
    both.observe("d", 5);
    assert.equal(a.counter("m"), 3);
    assert.equal(b.counter("m"), 3);
    assert.equal(b.distribution("d")!.count, 1);
  });
});

describe("metric catalogue", () => {
  test("names are unique and every metric documents itself", () => {
    const names = METRIC_DEFINITIONS.map((d) => d.key);
    assert.equal(new Set(names).size, names.length);
    for (const definition of METRIC_DEFINITIONS) {
      assert.ok(definition.description, `${definition.key} has no description`);
      assert.ok(definition.kind);
    }
  });

  test("every name used by the engines is in the catalogue", () => {
    const catalogued = new Set(METRIC_DEFINITIONS.map((d) => d.key));
    for (const name of Object.values(METRICS)) {
      assert.ok(catalogued.has(name), `${name} is emitted but not catalogued`);
    }
  });

  test("the catalogue renders for a scrape-based exporter", () => {
    const described = describeMetrics();
    assert.equal(described.length, METRIC_DEFINITIONS.length);
    assert.ok(described.every((d) => d.name && d.type && d.help));
  });
});

describe("engine instrumentation", () => {
  test("a decision records candidates, eligibility and search mode", async () => {
    const { platform, telemetry } = await instrumented();
    await publish(platform, simpleDraft());
    unwrap(await platform.capabilities.apply({ context: cartContext() }));

    assert.equal(telemetry.distribution(METRICS.decisionCandidates, { tenant: TENANT })!.max, 1);
    assert.equal(telemetry.distribution(METRICS.decisionApplied, { tenant: TENANT })!.max, 1);
    assert.equal(telemetry.counter(METRICS.decisionSearchMode, { tenant: TENANT, mode: "exhaustive" }), 1);
    assert.ok(telemetry.distribution(METRICS.decisionDuration, { tenant: TENANT, reality: "production" }));
  });

  test("context resolvers are timed individually, not just in aggregate", async () => {
    const { platform, telemetry } = await instrumented();
    unwrap(await platform.context.resolve(cartContext()));

    // The metric that finds the resolver making an external call.
    assert.ok(telemetry.distribution(METRICS.resolverDuration, { resolver: "core.cart" }));
    assert.ok(telemetry.distribution(METRICS.resolverDuration, { resolver: "core.temporal" }));
    assert.equal(telemetry.counter(METRICS.resolverOutcome, { resolver: "core.cart", outcome: "applied" }), 1);
  });

  test("eligibility failures are broken down by check name", async () => {
    const { platform, telemetry } = await instrumented();
    await publish(platform, simpleDraft({ scope: { channels: ["pos"] } }));
    unwrap(await platform.capabilities.apply({ context: cartContext({ channel: "web" }) }));

    assert.equal(telemetry.counter(METRICS.eligibilityFailed, { tenant: TENANT, check: "channel" }), 1);
    assert.equal(telemetry.counter(METRICS.eligibilityFailed, { tenant: TENANT, check: "window" }), 0);
  });

  test("a broken condition is emitted at error severity, not swallowed", async () => {
    const { platform, telemetry } = await instrumented();
    await publishUnchecked(
      platform,
      simpleDraft({ conditions: { op: "gt", left: { path: "subject.id" }, right: { literal: 5 } } }),
    );
    const result = await platform.capabilities.apply({ context: cartContext() });

    assert.equal(result.ok, false);
    assert.equal(telemetry.counter(METRICS.ruleError, { tenant: TENANT }), 1);
    const errors = telemetry.events({ severity: "error" });
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /could not be evaluated/);
  });

  test("an unfundable benefit is counted and raised as an event", async () => {
    const { platform, telemetry } = await instrumented();
    unwrap(
      await platform.capabilities.fund({
        tenant: TENANT, actor: "t", sourceId: "tiny", label: "Tiny",
        party: { kind: "merchant", id: "m1" }, unit: "USD", budgetDecimal: "1.00",
      }),
    );
    await publish(platform, simpleDraft({ funding: { model: "single", splits: [{ sourceId: "tiny" }] } }));
    const result = await platform.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "k" });

    assert.equal(result.ok, false);
    assert.equal(telemetry.counterTotal(METRICS.fundingInsufficient), 1);
    assert.equal(telemetry.counter(METRICS.fundingInsufficient, { tenant: TENANT, source: "tiny" }), 1);
    assert.equal(telemetry.events({ severity: "error" }).length, 1);
  });

  test("execution funnel counters move", async () => {
    const { platform, telemetry } = await instrumented();
    await publish(platform, simpleDraft());
    unwrap(await platform.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k" }));

    assert.equal(telemetry.counter(METRICS.executionReserved, { tenant: TENANT }), 1);
    assert.equal(telemetry.counter(METRICS.executionCaptured, { tenant: TENANT }), 1);
  });

  test("an exhausted limit is refused at eligibility, and counted there", async () => {
    const { platform, telemetry } = await instrumented();
    await publish(platform, simpleDraft({ limits: { totalRedemptions: 1 } }));
    unwrap(await platform.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "a" }));

    // The advisory check at eligibility catches this before reserve is reached,
    // so nothing applies and the breakdown is under eligibility.failed.
    unwrap(
      await platform.capabilities.apply({
        context: cartContext({ subject: { id: "s2", segments: [], counters: {} } }),
      }),
    );
    assert.equal(
      telemetry.counter(METRICS.eligibilityFailed, { tenant: TENANT, check: "limit.total_redemptions" }),
      1,
    );
  });

  test("limit.exceeded counts the races the advisory check cannot catch", async () => {
    const { platform, telemetry } = await instrumented();
    await publish(platform, simpleDraft({ limits: { totalRedemptions: 1 } }));

    // Fired together, every caller sees room at eligibility. Only the
    // authoritative check inside the store refuses the losers - which is
    // exactly what this metric is for.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        platform.capabilities.reserve({
          context: cartContext({ subject: { id: `s${i}`, segments: [], counters: {} } }),
          actor: "load",
          idempotencyKey: `k${i}`,
        }),
      ),
    );

    assert.equal(
      telemetry.counter(METRICS.limitExceeded, { tenant: TENANT, limit: "limit.total_redemptions" }),
      7,
      "one admitted, seven refused by the atomic check",
    );
    assert.equal(telemetry.counter(METRICS.executionReserved, { tenant: TENANT }), 1);
  });
});

describe("health", () => {
  test("a clean platform is healthy on every check", async () => {
    const { platform } = await instrumented();
    await publish(platform, simpleDraft());
    unwrap(await platform.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k" }));

    const report = unwrap(await platform.health.check(TENANT, { now: at(TEST_MS) }));
    assert.equal(report.status, "healthy");
    assert.deepEqual(report.checks.map((c) => c.name).sort(), ["audit", "funding", "ledger", "reservations"]);
  });

  test("a tampered audit record makes the platform unhealthy", async () => {
    const { platform, store } = await instrumented();
    await publish(platform, simpleDraft());

    const records = unwrap(await store.audit.recent(TENANT, 10));
    (records[1] as unknown as { payload: Record<string, string> }).payload = { tampered: "yes" };

    const report = unwrap(await platform.health.check(TENANT, { now: at(TEST_MS) }));
    assert.equal(report.status, "unhealthy");
    assert.equal(report.checks.find((c) => c.name === "audit")!.status, "unhealthy");
  });

  test("high budget utilisation degrades before it fails", async () => {
    const { platform } = await instrumented();
    unwrap(
      await platform.capabilities.fund({
        tenant: TENANT, actor: "t", sourceId: "small", label: "Small",
        party: { kind: "merchant", id: "m1" }, unit: "USD", budgetDecimal: "11.00",
      }),
    );
    await publish(platform, simpleDraft({ funding: { model: "single", splits: [{ sourceId: "small" }] } }));
    unwrap(await platform.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k" }));

    // 10.00 of 11.00 committed -> ~90%.
    const report = unwrap(await platform.health.check(TENANT, { now: at(TEST_MS) }));
    assert.equal(report.status, "degraded");
    assert.match(report.checks.find((c) => c.name === "funding")!.detail, /above 80%/);
  });

  test("stale reservations degrade the platform, because the sweep is not running", async () => {
    const { platform } = await instrumented();
    await publish(platform, simpleDraft());
    unwrap(await platform.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "k" }));

    const report = unwrap(await platform.health.check(TENANT, { now: at(TEST_MS + 7200 * 1000) }));
    assert.equal(report.status, "degraded");
    assert.match(report.checks.find((c) => c.name === "reservations")!.detail, /is the sweep running/);
  });
});

describe("alerts", () => {
  test("a broken condition pages", async () => {
    const { platform, telemetry } = await instrumented();
    await publishUnchecked(
      platform,
      simpleDraft({ conditions: { op: "gt", left: { path: "subject.id" }, right: { literal: 5 } } }),
    );
    await platform.capabilities.apply({ context: cartContext() });

    const firings = new AlertEngine().evaluate({ tenant: TENANT, metrics: telemetry });
    const rule = firings.find((f) => f.rule === "rules.broken");
    assert.ok(rule, "a rule error must page");
    assert.equal(rule!.severity, "page");
    assert.ok(rule!.runbook.includes("runbook"), "every alert names a response");
  });

  test("a tampered chain pages", async () => {
    const { platform, telemetry, store } = await instrumented();
    await publish(platform, simpleDraft());
    const records = unwrap(await store.audit.recent(TENANT, 10));
    (records[1] as unknown as { payload: Record<string, string> }).payload = { tampered: "yes" };

    const health = unwrap(await platform.health.check(TENANT, { now: at(TEST_MS) }));
    const firings = new AlertEngine().evaluate({ tenant: TENANT, metrics: telemetry, health });
    assert.ok(firings.some((f) => f.rule === "audit.unverified" && f.severity === "page"));
  });

  test("counter alerts use deltas, so they do not latch forever", async () => {
    const { platform, telemetry } = await instrumented();
    const broken = await publishUnchecked(
      platform,
      simpleDraft({ conditions: { op: "gt", left: { path: "subject.id" }, right: { literal: 5 } } }),
    );
    await platform.capabilities.apply({ context: cartContext(), candidateIds: [broken.id] });

    const engine = new AlertEngine();
    const first = engine.evaluate({ tenant: TENANT, metrics: telemetry });
    assert.ok(first.some((f) => f.rule === "rules.broken"), "the first evaluation sees the error");

    // Nothing new has happened. A rule written against the cumulative total
    // would page again here, and every minute after, forever.
    const second = engine.evaluate({ tenant: TENANT, metrics: telemetry });
    assert.equal(second.some((f) => f.rule === "rules.broken"), false, "a quiet interval must not re-page");

    // A fresh occurrence fires again.
    await platform.capabilities.apply({ context: cartContext(), candidateIds: [broken.id] });
    const third = engine.evaluate({ tenant: TENANT, metrics: telemetry });
    assert.ok(third.some((f) => f.rule === "rules.broken"), "a new error must page again");
  });

  test("a funding alert never reports a healthy message", async () => {
    const { platform, telemetry } = await instrumented();
    unwrap(
      await platform.capabilities.fund({
        tenant: TENANT, actor: "t", sourceId: "tiny", label: "Tiny",
        party: { kind: "merchant", id: "m1" }, unit: "USD", budgetDecimal: "1.00",
      }),
    );
    const thin = await publish(platform, simpleDraft({ funding: { model: "single", splits: [{ sourceId: "tiny" }] } }));
    await platform.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "k", candidateIds: [thin.id] });

    const health = unwrap(await platform.health.check(TENANT, { now: at(TEST_MS) }));
    const firing = new AlertEngine()
      .evaluate({ tenant: TENANT, metrics: telemetry, health })
      .find((f) => f.rule === "funding.exhausted");

    assert.ok(firing, "an unfundable benefit must alert");
    assert.match(firing!.message, /could not be funded/);
    assert.doesNotMatch(firing!.message, /none above/, "paging with a healthy message is worse than not paging");
  });

  test("a clean platform fires nothing", async () => {
    const { platform, telemetry } = await instrumented();
    await publish(platform, simpleDraft());
    unwrap(await platform.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k" }));

    const health = unwrap(await platform.health.check(TENANT, { now: at(TEST_MS) }));
    assert.deepEqual(new AlertEngine().evaluate({ tenant: TENANT, metrics: telemetry, health }), []);
  });

  test("pages sort before warnings", async () => {
    const { platform, telemetry } = await instrumented();

    // A stale reservation (warn) from a healthy offer...
    const healthy = await publish(platform, simpleDraft({ name: "healthy" }));
    unwrap(
      await platform.capabilities.reserve({
        context: cartContext(),
        actor: "t",
        idempotencyKey: "k",
        candidateIds: [healthy.id],
      }),
    );

    // ...and a broken condition (page). Evaluated on its own, because a broken
    // rule is an error that would otherwise fail every later decision too.
    const broken = await publishUnchecked(
      platform,
      simpleDraft({ name: "broken", conditions: { op: "gt", left: { path: "subject.id" }, right: { literal: 5 } } }),
    );
    await platform.capabilities.apply({ context: cartContext(), candidateIds: [broken.id] });

    const health = unwrap(await platform.health.check(TENANT, { now: at(TEST_MS + 7200 * 1000) }));
    const firings = new AlertEngine().evaluate({ tenant: TENANT, metrics: telemetry, health });

    assert.ok(firings.length >= 2, "expected both a page and a warning");
    assert.equal(firings[0]!.severity, "page");
    assert.equal(firings[firings.length - 1]!.severity, "warn");
  });
});
