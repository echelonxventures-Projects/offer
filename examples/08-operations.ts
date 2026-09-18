/**
 * Example 8 - running it.
 *
 * A simulated day: real traffic, an abandoned checkout, a campaign that runs
 * out of money, and a condition somebody broke. Then the maintenance pass that
 * an operator's scheduler would trigger, and what it reports.
 *
 * The point is that none of these problems need a human to notice them. Each
 * one surfaces as a metric, a health check or an alert with a runbook link.
 */
import { GoipPlatform } from "../src/platform/platform.ts";
import { MemoryTelemetry, percentile } from "../src/observability/telemetry.ts";
import { MemoryAuditAnchor } from "../src/audit/anchor.ts";
import { METRICS } from "../src/observability/metrics.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { instant } from "../src/universal/temporal/chronology.ts";
import { DEMO_INSTANT_MS, TENANT, heading, money, must, row, section } from "./_bootstrap.ts";
import { simpleOffer } from "./_fixtures.ts";

const telemetry = new MemoryTelemetry();
const anchor = new MemoryAuditAnchor();

const platform = new GoipPlatform({
  clock: fixedClock(BigInt(DEMO_INSTANT_MS) * 1_000_000n),
  ids: sequentialIdFactory(),
  telemetry,
  anchor,
  metricReader: telemetry,
});
const caps = platform.capabilities;
const at = (ms: number) => instant("earth.unix.ms", BigInt(ms));

heading("EXAMPLE 8 - OPERATIONS: a day's traffic, then the maintenance pass");

/* ---------------------------------------------------------------- */
section("setup: two campaigns, one of them under-funded");

must(
  await caps.fund({
    tenant: TENANT, actor: "ops", sourceId: "merchant-acme", label: "Acme budget",
    party: { kind: "merchant", id: "acme" }, unit: "USD", budgetDecimal: "500.00",
  }),
  "fund healthy",
);
must(
  await caps.fund({
    tenant: TENANT, actor: "ops", sourceId: "merchant-thin", label: "Thin budget",
    party: { kind: "merchant", id: "thin" }, unit: "USD", budgetDecimal: "25.00",
  }),
  "fund thin",
);

const healthy = must(await caps.create({ tenant: TENANT, actor: "ops", draft: simpleOffer("Everyday 10% off") }), "create healthy");
must(await caps.publish({ tenant: TENANT, actor: "ops", valueExchangeId: healthy.id, approvedBy: "finance" }), "publish healthy");

const thin = must(
  await caps.create({
    tenant: TENANT, actor: "ops",
    draft: { ...simpleOffer("Flash sale"), name: "Flash sale", funding: { model: "single", splits: [{ sourceId: "merchant-thin" }] } },
  }),
  "create thin",
);
must(await caps.publish({ tenant: TENANT, actor: "ops", valueExchangeId: thin.id, approvedBy: "finance" }), "publish thin");

// Somebody edits a condition and gets it wrong. Nothing complains at publish
// time - `validate` checks policy, not rule semantics.
const broken = must(
  await caps.create({
    tenant: TENANT, actor: "ops",
    draft: {
      ...simpleOffer("Loyalty bonus"),
      name: "Loyalty bonus",
      conditions: { op: "gte", left: { path: "subject.tier" }, right: { literal: 5 } },
    },
  }),
  "create broken",
);
must(await caps.publish({ tenant: TENANT, actor: "ops", valueExchangeId: broken.id, approvedBy: "finance" }), "publish broken");
row("campaigns live", "3 (one of them quietly broken)");

const basket = (subject: string) => ({
  tenant: TENANT,
  unit: "USD",
  channel: "web",
  subject: { id: subject },
  cart: {
    lines: [{ id: "l1", sku: "WIDGET", quantity: 1, unitPrice: { unit: "USD", minor: 10_000n, scale: 2 }, categories: ["tools"], merchant: "acme" }],
  },
});

/* ---------------------------------------------------------------- */
section("traffic");

let redeemed = 0;
for (let i = 0; i < 12; i += 1) {
  const result = await caps.redeem({
    context: basket(`shopper-${i}`),
    actor: "checkout",
    idempotencyKey: `order-${i}`,
    candidateIds: [healthy.id],
  });
  if (result.ok) redeemed += 1;
}
row("orders redeemed", String(redeemed));

// Two shoppers abandon their baskets after a price was quoted and held.
for (const i of [100, 101]) {
  must(
    await caps.reserve({ context: basket(`shopper-${i}`), actor: "checkout", idempotencyKey: `abandoned-${i}`, candidateIds: [healthy.id] }),
    "reserve",
  );
}
row("baskets abandoned", "2 (budget still held)");

// The flash sale runs out of money mid-campaign.
let refusedByBudget = 0;
for (let i = 0; i < 5; i += 1) {
  const result = await caps.reserve({
    context: basket(`flash-${i}`),
    actor: "checkout",
    idempotencyKey: `flash-${i}`,
    candidateIds: [thin.id],
  });
  if (!result.ok) refusedByBudget += 1;
}
row("flash sale refusals", String(refusedByBudget));

// And somebody hits the broken campaign.
const brokenAttempt = await caps.apply({ context: basket("shopper-200"), candidateIds: [broken.id] });
row("broken campaign", brokenAttempt.ok ? "applied" : `refused: ${brokenAttempt.error.code}`);

/* ---------------------------------------------------------------- */
section("what the metrics say, with nobody watching");

const decisions = telemetry.distribution(METRICS.decisionDuration, { tenant: TENANT, reality: "production" });
if (decisions) {
  row("decisions", `${decisions.count}, p50 ${percentile(decisions, 50).toFixed(2)}ms, p99 ${percentile(decisions, 99).toFixed(2)}ms`);
}
row("reserved / captured", `${telemetry.counter(METRICS.executionReserved, { tenant: TENANT })} / ${telemetry.counter(METRICS.executionCaptured, { tenant: TENANT })}`);
row("funding refusals", String(telemetry.counterTotal(METRICS.fundingInsufficient)));
row("rule errors", String(telemetry.counter(METRICS.ruleError, { tenant: TENANT })));

section("slowest context resolver");
for (const snapshot of telemetry.snapshot().filter((s) => s.metric === METRICS.resolverDuration)) {
  const p99 = snapshot.distribution ? percentile(snapshot.distribution, 99) : 0;
  row(String(snapshot.labels.resolver), `p99 ${p99.toFixed(3)}ms over ${snapshot.distribution?.count ?? 0} calls`);
}
console.log("   Timed per resolver, not in aggregate. A resolver that starts making");
console.log("   an external call shows up here and nowhere else.");

/* ---------------------------------------------------------------- */
section("maintenance pass (two hours later)");

const twoHoursOn = at(DEMO_INSTANT_MS + 7200 * 1000);
const report = must(await platform.maintenance.runDue(TENANT, twoHoursOn), "maintenance");

for (const job of report.jobs) {
  row(`${job.status === "ran" ? " " : "-"} ${job.job}`, job.summary);
}

section("health");
row("overall", report.health!.status);
for (const check of report.health!.checks) {
  row(`  ${check.name}`, `${check.status} - ${check.detail}`);
}

section("alerts");
if (report.alerts.length === 0) {
  row("none", "nothing needs a human");
} else {
  for (const alert of report.alerts) {
    row(alert.severity.toUpperCase(), alert.message);
    row("", `-> ${alert.runbook}`);
  }
}

/* ---------------------------------------------------------------- */
section("the audit chain, and why the anchor matters");

const anchored = must(await platform.auditService.reconcileWithAnchor(TENANT), "reconcile");
row("chain vs anchor", `${anchored.status} - ${anchored.detail}`);
console.log("   Verification alone only proves the chain is self-consistent, which a");
console.log("   wholesale rewrite also is. Comparing against a hash held elsewhere is");
console.log("   what makes tamper-evidence mean something.");

section("after the sweep");
const acme = must(await platform.store.funding.get(TENANT, "merchant-acme"), "funding");
row("acme reserved", money(acme.reserved));
row("acme spent", money(acme.spent));
console.log("\n   The two abandoned baskets released their budget without anyone noticing");
console.log("   they existed. That is the job that, left unwritten, becomes the first");
console.log("   production incident.\n");
