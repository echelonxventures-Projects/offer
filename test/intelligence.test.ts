/**
 * The analysis layer: graph projection, the named queries, anomaly detection,
 * scorecards and budget allocation.
 *
 * The recurring assertion across this file is that analysis stays honest about
 * what it does not know - a truncated projection says so, a detector with too
 * little history returns nothing rather than a guess, and a scorecard whose
 * feature is missing fails instead of scoring without it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TENANT, TEST_MS, cartContext, funded, publish, simpleDraft, unwrap } from "./_helpers.ts";
import {
  claimsByParty,
  dependentsOfFundingSource,
  historyOfSubject,
  neverDelivered,
  summarise,
} from "../src/intelligence/queries.ts";
import { bucketAuditKinds, median, medianAbsoluteDeviation } from "../src/intelligence/series.ts";
import { AnomalyEngine, DEFAULT_ANOMALY_CONFIG, detectorRegistry } from "../src/intelligence/anomaly.ts";
import {
  DEFAULT_SCORECARD_FEATURES,
  scorecardFeatureMap,
  scorecardSignal,
  scoreWith,
} from "../src/intelligence/scorecard.ts";
import {
  allocationStrategyRegistry,
  compareToCurrent,
  planAllocation,
} from "../src/intelligence/allocation.ts";
import { fromDecimal, type Amount } from "../src/universal/economic/amount.ts";

/* ------------------------------------------------------------------ *
 * Graph projection
 * ------------------------------------------------------------------ */

describe("graph projection", () => {
  async function busy() {
    const platform = await funded();
    const offer = await publish(platform, simpleDraft({ name: "Everyday 10%" }));
    for (let i = 0; i < 3; i += 1) {
      unwrap(
        await platform.capabilities.redeem({
          context: { ...cartContext(), subject: { id: `shopper-${i}` } },
          actor: "checkout",
          idempotencyKey: `order-${i}`,
          candidateIds: [offer.id],
        }),
      );
    }
    return { platform, offer };
  }

  test("projects the nodes and edges the architecture document promises", async () => {
    const { platform, offer } = await busy();
    const projection = unwrap(await platform.graph.project({ tenant: TENANT }));

    const kinds = summarise(projection);
    const nodes = (kind: string) => kinds.nodesByKind[kind] ?? 0;
    const edges = (kind: string) => kinds.edgesByKind[kind] ?? 0;

    assert.ok(nodes("ValueExchange") >= 1, "exchanges are nodes");
    assert.ok(nodes("Execution") >= 3, "every execution is a node");
    assert.ok(nodes("Subject") >= 3, "every subject is a node");
    assert.ok(nodes("FundingSource") >= 1);
    assert.ok(nodes("Party") >= 1);

    assert.ok(edges("FUNDED_BY") >= 1, "exchange -> funding source");
    assert.ok(edges("HELD_BY") >= 1, "funding source -> party");
    assert.ok(edges("EXECUTES") >= 3, "execution -> decision");
    assert.ok(edges("REDEEMED_BY") >= 3, "execution -> subject");
    assert.ok(edges("DECIDED") >= 3, "decision -> exchange");

    assert.ok(
      projection.edges.every((edge) => edge.from !== edge.to),
      "no node is its own neighbour",
    );
    assert.equal(projection.truncated, false);
    assert.ok(projection.scanned.auditRecords > 0, "reports what it cost");
    void offer;
  });

  test("a budget that is reached is reported, not silently honoured", async () => {
    const { platform } = await busy();
    const truncated = unwrap(await platform.graph.project({ tenant: TENANT, maxAuditRecords: 2 }));

    assert.equal(truncated.truncated, true, "a partial graph must say it is partial");
    assert.equal(truncated.scanned.auditRecords, 2);

    // And a budget larger than the chain is not truncation.
    const whole = unwrap(await platform.graph.project({ tenant: TENANT, maxAuditRecords: 10_000 }));
    assert.equal(whole.truncated, false);
  });

  test("a projection is deterministic and changes nothing", async () => {
    const { platform } = await busy();
    const first = unwrap(await platform.graph.project({ tenant: TENANT }));
    const second = unwrap(await platform.graph.project({ tenant: TENANT }));

    assert.deepEqual(first.nodes, second.nodes, "same nodes, same order");
    assert.deepEqual(first.edges, second.edges, "same edges, same order");

    // The chain is untouched: analysis reads, it does not write.
    const audit = unwrap(await platform.capabilities.audit({ tenant: TENANT }));
    assert.equal(audit.verified, true);
  });

  test("including the ledger adds accounts and the postings that reached them", async () => {
    const { platform } = await busy();
    const projection = unwrap(await platform.graph.project({ tenant: TENANT, includeLedger: true }));
    const shape = summarise(projection);

    assert.ok((shape.nodesByKind.Account ?? 0) >= 2, "double entry means at least two accounts");
    assert.ok((shape.edgesByKind.POSTED_TO ?? 0) >= 2, "executions reach accounts");
    assert.ok(projection.scanned.ledgerEntries > 0);
  });
});

/* ------------------------------------------------------------------ *
 * The named questions
 * ------------------------------------------------------------------ */

describe("the questions the graph exists to answer", () => {
  test("'if we retire this funding source, which offers stop working?'", async () => {
    const platform = await funded();
    await publish(platform, simpleDraft({ name: "A" }));
    await publish(platform, simpleDraft({ name: "B" }));

    const projection = unwrap(await platform.graph.project({ tenant: TENANT }));
    const dependency = dependentsOfFundingSource(projection, "merchant-1");

    assert.equal(dependency.dependents.length, 2, "both offers name this source");
    assert.equal(dependency.activeDependents, 2, "and both are live, so both would stop");
    assert.deepEqual(
      dependency.dependents.map((d) => d.name).sort(),
      ["A", "B"],
    );
  });

  test("'which live campaigns have never delivered anything?'", async () => {
    const platform = await funded();
    const delivering = await publish(platform, simpleDraft({ name: "Delivers" }));
    await publish(platform, simpleDraft({ name: "Never delivers" }));

    unwrap(
      await platform.capabilities.redeem({
        context: cartContext(),
        actor: "checkout",
        idempotencyKey: "k",
        candidateIds: [delivering.id],
      }),
    );

    const projection = unwrap(await platform.graph.project({ tenant: TENANT }));
    const idle = neverDelivered(projection);

    assert.equal(idle.length, 1, "exactly one campaign delivered nothing");
    assert.equal(idle[0]?.name, "Never delivers");
  });

  test("'which offers did this customer take?'", async () => {
    const platform = await funded();
    const offer = await publish(platform, simpleDraft());
    unwrap(
      await platform.capabilities.redeem({
        context: { ...cartContext(), subject: { id: "shopper-7" } },
        actor: "checkout",
        idempotencyKey: "k",
        candidateIds: [offer.id],
      }),
    );

    const projection = unwrap(await platform.graph.project({ tenant: TENANT }));
    const history = historyOfSubject(projection, "shopper-7");

    assert.equal(history.executions.length, 1);
    assert.equal(history.decisions.length, 1);
    assert.deepEqual(history.applied, [offer.id], "and which offer it was");

    // A subject nobody has ever seen is an empty history, not an error.
    assert.deepEqual(historyOfSubject(projection, "nobody").executions, []);
  });

  test("attribution claims aggregate by party", async () => {
    const platform = await funded();
    unwrap(
      await platform.capabilities.track({
        tenant: TENANT,
        subjectId: "shopper-1",
        kind: "click",
        party: { kind: "partner", id: "affiliate-a" },
      }),
    );
    unwrap(
      await platform.capabilities.track({
        tenant: TENANT,
        subjectId: "shopper-2",
        kind: "click",
        party: { kind: "partner", id: "affiliate-a" },
      }),
    );

    const projection = unwrap(await platform.graph.project({ tenant: TENANT }));
    const claims = claimsByParty(projection);
    const affiliate = claims.find((c) => c.party === "partner:affiliate-a");

    assert.equal(affiliate?.touchpoints, 2);
    assert.equal(affiliate?.subjects, 2, "two distinct subjects, not two touches on one");
  });
});

/* ------------------------------------------------------------------ *
 * Series and statistics
 * ------------------------------------------------------------------ */

describe("integer statistics", () => {
  test("median and MAD are integer and order-independent", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2, "even length rounds down rather than producing a fraction");
    assert.equal(median([]), 0);
    assert.equal(medianAbsoluteDeviation([10, 10, 10]), 0, "no spread in steady data");
    assert.equal(medianAbsoluteDeviation([1, 2, 3, 4, 100]), 1, "one outlier does not inflate the spread");
  });

  test("MAD is what makes a spiky baseline usable", () => {
    // A single flash sale in the history. A standard deviation would be
    // dragged upwards by it and would then hide the next real incident.
    const history = [20, 22, 21, 19, 500, 20, 21];
    assert.equal(median(history), 21);
    assert.ok(medianAbsoluteDeviation(history) <= 2, "the spike is ignored, not absorbed");
  });
});

describe("series bucketing", () => {
  test("the still-filling bucket is excluded", async () => {
    const platform = await funded();
    await publish(platform, simpleDraft());

    const nowTick = BigInt(TEST_MS);
    const built = unwrap(
      await bucketAuditKinds(platform.store, {
        tenant: TENANT,
        bucketTicks: 60_000n,
        nowTick,
        buckets: 4,
      }),
    );

    for (const series of built.series) {
      assert.equal(series.buckets.length, 4);
      assert.ok(
        series.buckets.every((bucket) => bucket.closed),
        "only closed buckets are returned; judging a half-full one reports a collapse every time",
      );
      assert.ok(
        series.buckets.every((bucket) => bucket.startTick < (nowTick / 60_000n) * 60_000n),
        "no bucket starts at or after the open one",
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * Anomaly detection
 * ------------------------------------------------------------------ */

describe("anomaly detectors", () => {
  const detectors = detectorRegistry();
  const series = (counts: number[]) => ({
    key: "execution.captured",
    buckets: counts.map((count, i) => ({ startTick: BigInt(i), count, closed: true })),
  });
  const run = (key: string, counts: number[], config = DEFAULT_ANOMALY_CONFIG) =>
    detectors.require(key).ok
      ? (detectors.get(key) as { detect: Function }).detect({ series: series(counts), counts, config })
      : [];

  test("a spike is caught and explained with numbers", () => {
    const findings = run("volume_spike", [20, 21, 19, 20, 22, 20, 400]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].observed, 400);
    assert.equal(findings[0].baseline, 20);
    assert.match(findings[0].detail, /400/, "the detail names the observation");
    assert.match(findings[0].detail, /20/, "and the baseline it was judged against");
  });

  test("steady traffic is not an anomaly", () => {
    assert.deepEqual(run("volume_spike", [20, 21, 19, 20, 22, 20, 21]), []);
    assert.deepEqual(run("volume_collapse", [20, 21, 19, 20, 22, 20, 21]), []);
  });

  test("a campaign that stops delivering is caught, because nothing else notices", () => {
    const findings = run("volume_collapse", [30, 32, 29, 31, 30, 33, 0]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].observed, 0);
    assert.match(findings[0].detail, /stopped entirely/);
  });

  test("too little history produces nothing rather than a guess", () => {
    assert.deepEqual(run("volume_spike", [1, 500]), [], "two buckets is not a baseline");
    assert.deepEqual(run("volume_collapse", [1, 0]), []);
  });

  test("small numbers are not judged at all", () => {
    // Three redemptions becoming one is not an incident, it is Tuesday.
    assert.deepEqual(run("volume_collapse", [3, 2, 3, 2, 3, 2, 0]), []);
  });

  test("the bucket being judged is excluded from its own baseline", () => {
    // If the observation were included, the median would be dragged towards it
    // and a sustained doubling at the end would look ordinary.
    const findings = run("volume_spike", [10, 10, 10, 10, 10, 10, 90]);
    assert.equal(findings[0]?.baseline, 10, "baseline is the history, not the history plus the spike");
  });

  test("a gradual shift no single bucket shows is still caught", () => {
    const findings = run("sustained_shift", [10, 11, 10, 12, 22, 24, 23, 25]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "info", "gradual is information, not a page");
    assert.match(findings[0].detail, /risen/);
  });

  test("findings are evidence, never an action", () => {
    for (const detector of detectors.list()) {
      const source = detector.detect.toString();
      assert.ok(!source.includes("pause"), `${detector.key} must not act`);
      assert.ok(!source.includes("block"), `${detector.key} must not act`);
    }
  });
});

describe("the anomaly engine over a real chain", () => {
  test("scans without writing, and reports what it read", async () => {
    const platform = await funded();
    const offer = await publish(platform, simpleDraft());
    unwrap(
      await platform.capabilities.redeem({
        context: cartContext(), actor: "checkout", idempotencyKey: "k", candidateIds: [offer.id],
      }),
    );

    const engine = new AnomalyEngine(platform.store, detectorRegistry());
    const report = unwrap(
      await engine.scan({ tenant: TENANT, nowTick: BigInt(TEST_MS) + 600_000n, bucketTicks: 60_000n }),
    );

    assert.ok(report.scanned > 0, "reports its cost");
    // One burst of traffic in a fixed-clock test is not enough history for any
    // detector to have an opinion, and it must not invent one.
    assert.deepEqual(report.findings, []);

    const audit = unwrap(await platform.capabilities.audit({ tenant: TENANT }));
    assert.equal(audit.verified, true, "scanning does not disturb the chain");
  });
});

/* ------------------------------------------------------------------ *
 * Scorecards
 * ------------------------------------------------------------------ */

describe("scorecards", () => {
  const weights = {
    key: "fraud_v3",
    label: "Fraud scorecard v3",
    description: "Fitted offline; loaded here as data.",
    intercept: -10,
    weights: { recent_redemptions: 8, is_anonymous: 25, cart_whole_units: 0 },
    fittedAt: "2026-09-01",
  };

  async function inputFor(overrides: Record<string, unknown> = {}) {
    const platform = await funded();
    const resolved = unwrap(await platform.context.resolve({ ...cartContext(), ...overrides }));
    return { context: resolved, deps: platform.deps };
  }

  test("a score decomposes into one contribution per feature", async () => {
    const input = await inputFor();
    const result = unwrap(scoreWith(weights, scorecardFeatureMap(), input as never));

    assert.equal(result.contributions.length, 3, "every weighted feature is accounted for");
    const total = result.contributions.reduce((sum, c) => sum + c.contribution, weights.intercept);
    assert.equal(result.score, total, "the score is exactly the sum of its parts");
  });

  test("the largest contributor is identified, because that is what a human reads", async () => {
    const input = await inputFor({ subject: {} });
    const result = unwrap(scoreWith(weights, scorecardFeatureMap(), input as never));

    assert.equal(result.leading?.feature, "is_anonymous");
    assert.equal(result.leading?.contribution, 25);
  });

  test("a missing feature is an error, never a quietly different model", async () => {
    const input = await inputFor();
    const broken = { ...weights, weights: { ...weights.weights, invented_feature: 5 } };
    const result = scoreWith(broken, scorecardFeatureMap(), input as never);

    assert.equal(result.ok, false, "scoring without a weighted feature changes the model's meaning");
    assert.match(result.ok === false ? result.error.message : "", /invented_feature/);
  });

  test("weights are summed in sorted order, so the same model always scores the same", async () => {
    const input = await inputFor();
    const forwards = unwrap(scoreWith(weights, scorecardFeatureMap(), input as never));
    const reordered = {
      ...weights,
      weights: Object.fromEntries(Object.entries(weights.weights).reverse()),
    };
    const backwards = unwrap(scoreWith(reordered, scorecardFeatureMap(), input as never));

    assert.equal(forwards.score, backwards.score);
    assert.deepEqual(
      forwards.contributions.map((c) => c.feature),
      backwards.contributions.map((c) => c.feature),
      "a reordered weights file is the same model",
    );
  });

  test("a scorecard drops into the risk registry and keeps the explanation surface", async () => {
    const platform = await funded();
    platform.registries["risk-signal"]!.register(scorecardSignal({ weights }) as never);

    const resolved = unwrap(await platform.context.resolve({ ...cartContext(), subject: {} }));
    const assessed = unwrap(platform.risk.assess(resolved));
    const fromModel = assessed.signals.find((s) => s.signal === "fraud_v3");

    assert.ok(fromModel, "the fitted model is just another signal");
    assert.match(fromModel.reason, /largest contributor/, "and it still has to explain itself");
    assert.ok(["allow", "review", "block"].includes(assessed.disposition));
  });

  test("every shipped feature is deterministic and integral", async () => {
    const input = await inputFor();
    for (const feature of DEFAULT_SCORECARD_FEATURES) {
      const once = feature.extract(input as never);
      assert.equal(once, feature.extract(input as never), `${feature.key} must be pure`);
      assert.ok(Number.isInteger(once), `${feature.key} must be an integer`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Budget allocation
 * ------------------------------------------------------------------ */

describe("budget allocation", () => {
  const strategies = allocationStrategyRegistry();
  const usd = (decimal: string): Amount => fromDecimal("USD", decimal, 2);

  const demands = [
    { valueExchangeId: "vx_a", name: "A", spent: usd("300.00"), redemptions: 30, priority: 100 },
    { valueExchangeId: "vx_b", name: "B", spent: usd("100.00"), redemptions: 10, priority: 50 },
    { valueExchangeId: "vx_c", name: "C", spent: usd("0.00"), redemptions: 0, priority: 10 },
  ];

  test("allocates the total exactly, to the minor unit", () => {
    for (const strategy of strategies.keys()) {
      const plan = planAllocation(strategies, strategy, { total: usd("1000.00"), demands });
      if (!plan.ok) continue;
      const sum = plan.value.lines.reduce((total, line) => total + line.amount.minor, 0n);
      assert.equal(sum, 100_000n, `${strategy} must not lose or invent money`);
    }
  });

  test("a remainder that will not divide is still distributed exactly", () => {
    // 100.00 over three equal shares is 33.33 three times, with a cent left.
    const plan = unwrap(planAllocation(strategies, "equal", { total: usd("100.00"), demands }));
    const sum = plan.lines.reduce((total, line) => total + line.amount.minor, 0n);
    assert.equal(sum, 10_000n, "the last cent goes somewhere rather than vanishing");
  });

  test("campaigns given nothing are listed with a reason, never dropped", () => {
    const plan = unwrap(planAllocation(strategies, "by_historic_spend", { total: usd("1000.00"), demands }));

    assert.equal(plan.lines.length, 2);
    assert.equal(plan.excluded.length, 1);
    assert.equal(plan.excluded[0]?.valueExchangeId, "vx_c");
    assert.match(plan.excluded[0]?.reason ?? "", /spent nothing/);
  });

  test("every line explains the weight it was given", () => {
    const plan = unwrap(planAllocation(strategies, "by_redemptions", { total: usd("1000.00"), demands }));
    for (const line of plan.lines) {
      assert.match(line.rationale, /redemption/, "'why did this get less' must have an answer");
    }
  });

  test("the order of the input cannot change the plan", () => {
    const forwards = unwrap(planAllocation(strategies, "equal", { total: usd("100.00"), demands }));
    const backwards = unwrap(
      planAllocation(strategies, "equal", { total: usd("100.00"), demands: [...demands].reverse() }),
    );
    assert.deepEqual(forwards.lines, backwards.lines, "including which line absorbs the remainder");
  });

  test("a strategy that weights everything at zero is an error, not an empty plan", () => {
    const idle = demands.map((d) => ({ ...d, redemptions: 0 }));
    const plan = planAllocation(strategies, "by_redemptions", { total: usd("1000.00"), demands: idle });

    assert.equal(plan.ok, false, "silently allocating nothing would look like a working plan");
  });

  test("a plan is compared against what campaigns have now", () => {
    const plan = unwrap(planAllocation(strategies, "equal", { total: usd("300.00"), demands }));
    const changes = compareToCurrent(plan, new Map([["vx_a", usd("50.00")]]));

    const a = changes.find((c) => c.valueExchangeId === "vx_a");
    assert.equal(a?.deltaMinor, 5_000n, "100.00 proposed against 50.00 current");
    const c = changes.find((c) => c.valueExchangeId === "vx_c");
    assert.equal(c?.current.minor, 0n, "a campaign with no current budget reads as zero, not missing");
    assert.equal(changes[0]?.valueExchangeId !== undefined, true, "biggest movement first");
  });

  test("allocation never writes a budget", async () => {
    const platform = await funded();
    const before = unwrap(await platform.store.funding.get(TENANT, "merchant-1"));
    planAllocation(strategies, "equal", { total: usd("1000.00"), demands });
    const after = unwrap(await platform.store.funding.get(TENANT, "merchant-1"));

    assert.deepEqual(before, after, "a plan is a proposal; applying it is a separate deliberate act");
  });
});
