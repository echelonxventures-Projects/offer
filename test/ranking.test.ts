/**
 * Discovery ranking.
 *
 * Ranking was a closed union and a `switch` inside the discovery engine, which
 * is the exact shape this platform removes everywhere else. These tests hold
 * the replacement to the same standard as the rest: deterministic, explainable,
 * and unable to reach the decision path.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TENANT, cartContext, funded, publish, simpleDraft, unwrap } from "./_helpers.ts";
import { compareKeys } from "../src/kernel/order.ts";
import { DEFAULT_RANKING_FEATURES, weightedRanking } from "../src/engines/ranking.ts";

async function catalogue() {
  const platform = await funded();
  await publish(platform, simpleDraft({ name: "Zebra 5%", priority: 10,
    benefits: [{ id: "d", type: "percentage", params: { rate: "5" }, effect: "price_reduction" }] }));
  await publish(platform, simpleDraft({ name: "apple 20%", priority: 1,
    benefits: [{ id: "d", type: "percentage", params: { rate: "20" }, effect: "price_reduction" }] }));
  await publish(platform, simpleDraft({ name: "Middle 10%", priority: 99,
    benefits: [{ id: "d", type: "percentage", params: { rate: "10" }, effect: "price_reduction" }] }));
  return platform;
}

describe("ranking is a registry, not a union", () => {
  test("the shipped rankings are registered and describable", async () => {
    const platform = await funded();
    const rankings = platform.registries["discovery-ranking"]!;

    assert.deepEqual(rankings.keys(), ["name", "priority", "recommended", "value"]);
    for (const entry of rankings.list()) {
      assert.ok(entry.label.length > 0, `${entry.key} needs a label`);
      const described = entry as { description?: string };
      assert.ok((described.description ?? "").length > 0, `${entry.key} needs a description`);
    }
  });

  test("a tenant registers its own without touching an engine", async () => {
    const platform = await catalogue();
    platform.registries["discovery-ranking"]!.register({
      key: "reverse_alphabetical",
      label: "Reverse alphabetical",
      description: "Registered by a deployment.",
      compare: (a: never, b: never) =>
        compareKeys((b as { candidate: { name: string } }).candidate.name,
                    (a as { candidate: { name: string } }).candidate.name),
    } as never);

    const found = unwrap(
      await platform.capabilities.discover({ context: cartContext(), rank: "reverse_alphabetical" }),
    ).results;
    assert.deepEqual(found.map((f) => f.name), ["apple 20%", "Zebra 5%", "Middle 10%"]);
  });

  test("an unknown ranking is refused rather than quietly defaulted", async () => {
    const platform = await catalogue();
    const result = await platform.capabilities.discover({ context: cartContext(), rank: "by_vibes" });

    assert.equal(result.ok, false, "ranking by something other than what was asked is worse than refusing");
    assert.match(result.ok === false ? result.error.message : "", /by_vibes/);
  });
});

describe("ranking is deterministic", () => {
  test("alphabetical is codepoint order, so every host agrees", async () => {
    const platform = await catalogue();
    const found = unwrap(await platform.capabilities.discover({ context: cartContext(), rank: "name" })).results;

    // Locale collation would put "apple" before "Middle"; codepoint order does
    // not, and codepoint order is what SQLite and Go also use.
    assert.deepEqual(found.map((f) => f.name), ["Middle 10%", "Zebra 5%", "apple 20%"]);
  });

  test("the same catalogue ranks the same way twice", async () => {
    const platform = await catalogue();
    for (const rank of ["value", "priority", "name", "recommended"]) {
      const first = unwrap(await platform.capabilities.discover({ context: cartContext(), rank })).results;
      const second = unwrap(await platform.capabilities.discover({ context: cartContext(), rank })).results;
      assert.deepEqual(first.map((f) => f.valueExchangeId), second.map((f) => f.valueExchangeId), rank);
    }
  });

  test("value ranks by what the subject would receive", async () => {
    const platform = await catalogue();
    const found = unwrap(await platform.capabilities.discover({ context: cartContext(), rank: "value" })).results;
    assert.equal(found[0]?.name, "apple 20%", "the biggest discount, whatever its priority");
  });

  test("priority ranks by what the author asked for", async () => {
    const platform = await catalogue();
    const found = unwrap(await platform.capabilities.discover({ context: cartContext(), rank: "priority" })).results;
    assert.equal(found[0]?.name, "Middle 10%", "priority 99 outranks the better discount");
  });
});

describe("a weighted ranking shows its working", () => {
  test("recommended explains every contribution", async () => {
    const platform = await catalogue();
    const found = unwrap(await platform.capabilities.discover({ context: cartContext(), rank: "recommended" })).results;

    for (const result of found) {
      assert.ok(result.ranking, `${result.name} must carry its explanation`);
      assert.ok(result.ranking.contributions.length > 0);
      const summed = result.ranking.contributions.reduce((total, c) => total + c.contribution, 0);
      assert.equal(result.ranking.total, summed, "the total is exactly the sum of its parts");
      for (const contribution of result.ranking.contributions) {
        assert.equal(contribution.contribution, contribution.score * contribution.weight);
      }
    }
  });

  test("the explanation orders the results it explains", async () => {
    const platform = await catalogue();
    const found = unwrap(await platform.capabilities.discover({ context: cartContext(), rank: "recommended" })).results;
    const totals = found.map((f) => f.ranking?.total ?? 0);
    assert.deepEqual([...totals].sort((a, b) => b - a), totals, "higher total ranks first");
  });

  test("an unweighted ranking carries no explanation rather than an empty one", async () => {
    const platform = await catalogue();
    const found = unwrap(await platform.capabilities.discover({ context: cartContext(), rank: "value" })).results;
    assert.equal(found[0]?.ranking, undefined, "'value' is a comparator, and says so by omission");
  });

  test("a feature referenced with no registration is skipped, not fatal", async () => {
    const platform = await catalogue();
    const features = platform.registries["ranking-feature"]!;
    const ranking = weightedRanking({
      key: "partly_unknown",
      label: "Partly unknown",
      description: "References a feature nobody registered.",
      weights: { relative_value: 1, no_such_feature: 100 },
      features: features as never,
    });

    // Ranking is presentation. An unknown feature must not take down discovery
    // the way an unevaluable condition once took down a whole response.
    const explanation = ranking.explain?.({
      candidate: { valueExchangeId: "vx_1", name: "A", eligible: true },
      cohort: [{ valueExchangeId: "vx_1", name: "A", eligible: true }],
      context: unwrap(await platform.context.resolve(cartContext())),
      scale: 10_000,
    });
    assert.equal(explanation?.contributions.length, 1, "only the feature that exists contributes");
  });
});

describe("ranking features", () => {
  test("every feature is bounded, integral and pure", async () => {
    const platform = await catalogue();
    const context = unwrap(await platform.context.resolve(cartContext()));
    const candidate = { valueExchangeId: "vx_1", name: "A", eligible: true };
    const input = { candidate, cohort: [candidate], context, scale: 10_000 };

    for (const feature of DEFAULT_RANKING_FEATURES) {
      const score = feature.score(input);
      assert.ok(Number.isInteger(score), `${feature.key} must be integral`);
      assert.ok(score >= 0 && score <= 10_000, `${feature.key} must stay on the scale`);
      assert.equal(score, feature.score(input), `${feature.key} must be pure`);
    }
  });

  test("the scale is configuration, so a deployment can widen it", async () => {
    const { GoipPlatform } = await import("../src/platform/platform.ts");
    const { fixedClock } = await import("../src/universal/temporal/authority.ts");
    const { sequentialIdFactory } = await import("../src/kernel/ids.ts");
    const { TEST_MS } = await import("./_helpers.ts");

    const wide = new GoipPlatform({
      clock: fixedClock(BigInt(TEST_MS) * 1_000_000n),
      ids: sequentialIdFactory(),
      config: { ranking: { scale: 1_000_000 } },
    });
    assert.equal(wide.config.ranking.scale, 1_000_000);
  });
});

describe("ranking cannot reach the decision path", () => {
  test("changing the ranking does not change what applies", async () => {
    const platform = await catalogue();
    const context = cartContext();

    const quoted = unwrap(await platform.capabilities.apply({ context }));
    const before = quoted.decision.hash;

    platform.registries["discovery-ranking"]!.register({
      key: "upside_down",
      label: "Upside down",
      description: "Deliberately perverse.",
      compare: () => -1,
    } as never);

    const after = unwrap(await platform.capabilities.apply({ context })).decision.hash;
    assert.equal(before, after, "presentation order is not an input to a decision");
    void TENANT;
  });
});
