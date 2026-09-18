/**
 * Example 12 - analysis: the graph, anomalies, a fitted model, and a plan.
 *
 * Everything here is downstream. Nothing in this file can change what a
 * customer is charged, and a layering test enforces that: no engine, rule or
 * ledger module may import the analysis layer at all.
 *
 * That boundary is the whole reason this is safe to build. The architecture
 * document has one rule about the graph - never traverse it inside a decision -
 * because a decision whose latency and outcome depend on how much history a
 * subject has cannot be operated or replayed.
 */
import { GoipPlatform } from "../src/platform/platform.ts";
import {
  claimsByParty,
  dependentsOfFundingSource,
  historyOfSubject,
  neverDelivered,
  summarise,
} from "../src/intelligence/queries.ts";
import { scorecardSignal } from "../src/intelligence/scorecard.ts";
import { allocationStrategyRegistry, compareToCurrent, planAllocation } from "../src/intelligence/allocation.ts";
import { fromDecimal } from "../src/universal/economic/amount.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { DEMO_INSTANT_MS, TENANT, heading, money, must, row, section } from "./_bootstrap.ts";
import { simpleOffer } from "./_fixtures.ts";

const platform = new GoipPlatform({
  clock: fixedClock(BigInt(DEMO_INSTANT_MS) * 1_000_000n),
  ids: sequentialIdFactory(),
});
const caps = platform.capabilities;

heading("EXAMPLE 12 - ANALYSIS: the graph, anomalies, a fitted model, a plan");

must(
  await caps.fund({
    tenant: TENANT, actor: "ops", sourceId: "merchant-acme", label: "Acme budget",
    party: { kind: "merchant", id: "acme" }, unit: "USD", budgetDecimal: "50000.00",
  }),
  "fund",
);

const popular = must(
  await caps.create({ tenant: TENANT, actor: "ops", draft: simpleOffer("Everyday 10% off") }),
  "create popular",
);
must(await caps.publish({ tenant: TENANT, actor: "ops", valueExchangeId: popular.id, approvedBy: "finance" }), "publish");

const forgotten = must(
  await caps.create({
    tenant: TENANT, actor: "ops",
    draft: { ...simpleOffer("Tuesday club"), name: "Tuesday club" },
  }),
  "create forgotten",
);
must(await caps.publish({ tenant: TENANT, actor: "ops", valueExchangeId: forgotten.id, approvedBy: "finance" }), "publish");

const basket = (subject: string) => ({
  tenant: TENANT, unit: "USD", channel: "web", subject: { id: subject },
  cart: {
    lines: [{
      id: "l1", sku: "WIDGET", quantity: 1,
      unitPrice: { unit: "USD", minor: 10_000n, scale: 2 },
      categories: ["tools"], merchant: "acme",
    }],
  },
});

for (let i = 0; i < 6; i += 1) {
  must(
    await caps.redeem({
      context: basket(`shopper-${i}`), actor: "checkout",
      idempotencyKey: `order-${i}`, candidateIds: [popular.id],
    }),
    `redeem ${i}`,
  );
}
must(
  await caps.track({
    tenant: TENANT, subjectId: "shopper-0", kind: "click",
    party: { kind: "partner", id: "affiliate-a" },
  }),
  "track",
);

/* ---------------------------------------------------------------- */
section("1. the incentive graph, projected");

const projection = must(await platform.graph.project({ tenant: TENANT, includeLedger: true }), "project");
const shape = summarise(projection);

row("nodes", String(projection.nodes.length));
row("edges", String(projection.edges.length));
row("audit records read", String(projection.scanned.auditRecords));
row("truncated", String(projection.truncated));
for (const [kind, count] of Object.entries(shape.edgesByKind)) row(`  ${kind}`, String(count));

console.log(`
   Derived, never stored. Delete this projection and the next one is identical,
   because every edge is already implied by a field on a record. It reports
   what it read, and a projection that hit its budget says 'truncated' rather
   than quietly handing back a partial graph.`);

/* ---------------------------------------------------------------- */
section("2. the questions it exists to answer");

const risky = dependentsOfFundingSource(projection, "merchant-acme");
row("if we retire merchant-acme", `${risky.activeDependents} live campaign(s) stop`);
for (const dependent of risky.dependents) row(`  ${dependent.name}`, dependent.state);

const idle = neverDelivered(projection);
row("live but never delivered", String(idle.length));
for (const campaign of idle) row(`  ${campaign.name}`, "configured, never used");

const history = historyOfSubject(projection, "shopper-0");
row("shopper-0 redemptions", String(history.executions.length));
row("shopper-0 took", history.applied.join(", ") || "nothing");

for (const claim of claimsByParty(projection)) {
  row(`claims by ${claim.party}`, `${claim.touchpoints} touch(es), ${claim.subjects} subject(s)`);
}

console.log(`
   'Which offers stop working if we retire this funding source' is the single
   most useful pre-change safety query in this domain, and 'which campaigns
   were configured and never delivered anything' is the least available - a
   campaign that quietly does nothing raises no errors at all.`);

/* ---------------------------------------------------------------- */
section("3. anomaly detection over the chain");

const report = must(
  await platform.anomalies.scan({
    tenant: TENANT,
    nowTick: BigInt(DEMO_INSTANT_MS) + 3_600_000n,
    bucketTicks: 300_000n,
  }),
  "scan",
);
row("series examined", String(report.seriesExamined));
row("records read", String(report.scanned));
row("findings", String(report.findings.length));
for (const finding of report.findings) row(`  ${finding.detector}`, finding.detail);

console.log(`
   No findings, and that is the correct answer: one burst of traffic is not a
   baseline, and a detector with too little history returns nothing rather than
   a guess. Integer statistics over closed buckets - the bucket containing
   'now' is still filling, and judging a half-full bucket reports a collapse in
   volume every single time it runs, which is how an alerting system teaches
   people to ignore it.`);

/* ---------------------------------------------------------------- */
section("4. a fitted model, still explaining itself");

// Fitted somewhere else, in whatever statistical tooling the deployment owns.
// What arrives here is the result: a table of integers.
platform.registries["risk-signal"]!.register(
  scorecardSignal({
    weights: {
      key: "fraud_v3",
      label: "Fraud scorecard v3",
      description: "Fitted offline on last quarter's disputes.",
      intercept: -10,
      weights: { recent_redemptions: 8, is_anonymous: 25, cart_whole_units: 0 },
      fittedAt: "2026-09-01",
    },
  }) as never,
);

const resolved = must(await platform.context.resolve({ ...basket("walk-in"), subject: {} }), "resolve");
const assessed = must(platform.risk.assess(resolved), "assess");

row("disposition", assessed.disposition);
for (const signal of assessed.signals) row(`  ${signal.signal}`, signal.reason);

console.log(`
   The risk engine neither knows nor cares that one of those signals came from
   a fitted model. It is a linear scorecard held as data, so every score
   decomposes into one contribution per feature - and 'blocked because the
   anonymous feature contributed 25 of 85' can be appealed, where 'blocked,
   score 0.91' cannot. Every incentive platform eventually has to explain a
   block to a real person standing at a till.`);

/* ---------------------------------------------------------------- */
section("5. planning next quarter's budget");

const strategies = allocationStrategyRegistry();
const usd = (decimal: string) => fromDecimal("USD", decimal, 2);

const plan = must(
  planAllocation(strategies, "by_redemptions", {
    total: usd("100000.00"),
    demands: [
      { valueExchangeId: popular.id, name: "Everyday 10% off", spent: usd("600.00"), redemptions: 6, priority: 100 },
      { valueExchangeId: forgotten.id, name: "Tuesday club", spent: usd("0.00"), redemptions: 0, priority: 50 },
    ],
  }),
  "plan",
);

row("strategy", plan.strategy);
for (const line of plan.lines) row(`  ${line.name}`, `${money(line.amount)}  (${line.rationale})`);
for (const excluded of plan.excluded) row(`  excluded`, `${excluded.valueExchangeId}: ${excluded.reason}`);

const changes = compareToCurrent(plan, new Map([[popular.id, usd("40000.00")]]));
for (const change of changes) {
  row(`  ${change.name}`, `${money(change.current)} -> ${money(change.proposed)}`);
}

const allocated = plan.lines.reduce((total, line) => total + line.amount.minor, 0n);
row("allocated exactly", `${allocated === 10_000_000n} (${allocated} of 10000000 minor units)`);

console.log(`
   It allocates to the minor unit using the same remainder-preserving
   allocate() the ledger uses, because a plan that loses a cent per campaign is
   a plan that will not reconcile. A campaign given nothing is listed with a
   reason rather than dropped.

   And it is advisory. Nothing here wrote a budget or moved money - applying
   this is a separate, deliberate act by somebody holding the 'fund'
   capability. An optimiser with write access is an optimiser that can empty a
   campaign at three in the morning.`);

/* ---------------------------------------------------------------- */
section("what this example does not show");

console.log(`
   No training, no gradient descent, no inference over a neural network. The
   platform executes a model somebody else fitted, and calling that machine
   learning would be a marketing claim. The known-gaps list says so.

   What it does instead is keep every answer reproducible and appealable:
   integer arithmetic, codepoint ordering, and a contribution breakdown behind
   every number on this page.`);
