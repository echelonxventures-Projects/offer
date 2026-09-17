/**
 * Eligibility, stacking and the decision engine.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { conflictBetween, applicationOrder } from "../src/engines/stacking.ts";
import { instant } from "../src/universal/temporal/chronology.ts";
import { toDecimal } from "../src/universal/economic/amount.ts";
import type { ValueExchange } from "../src/model/value-exchange.ts";
import { TENANT, cartContext, funded, publish, simpleDraft, unwrap, usd } from "./_helpers.ts";

const stackingOnly = (id: string, over: Partial<ValueExchange["stacking"]>, priority = 0): ValueExchange =>
  ({ id, priority, stacking: over } as ValueExchange);

describe("eligibility checks", () => {
  test("reports every check it ran, not just the failure", async () => {
    const p = await funded();
    const exchange = await publish(p, simpleDraft());
    const context = unwrap(await p.context.resolve(cartContext()));
    const verdict = unwrap(await p.decisions.eligibility.evaluate({ exchange, context }));
    assert.equal(verdict.eligible, true);
    const names = verdict.checks.map((c) => c.check);
    for (const expected of ["reality", "lifecycle", "window", "spatial", "channel", "merchant", "acquisition", "minimum_base", "conditions"]) {
      assert.ok(names.includes(expected), `missing check '${expected}'`);
    }
  });

  test("a draft exchange is never redeemable", async () => {
    const p = await funded();
    const created = unwrap(await p.capabilities.create({ tenant: TENANT, actor: "a", draft: simpleDraft() }));
    const context = unwrap(await p.context.resolve(cartContext()));
    const verdict = unwrap(await p.decisions.eligibility.evaluate({ exchange: created, context }));
    assert.equal(verdict.eligible, false);
    assert.match(verdict.primaryReason!, /lifecycle/);
  });

  test("skips the rule evaluation once something structural has failed", async () => {
    const p = await funded();
    const exchange = await publish(p, simpleDraft({ scope: { channels: ["pos"] } }));
    const context = unwrap(await p.context.resolve(cartContext({ channel: "web" })));
    const verdict = unwrap(await p.decisions.eligibility.evaluate({ exchange, context }));
    const conditions = verdict.checks.find((c) => c.check === "conditions");
    assert.equal(conditions?.skipped, true);
    assert.match(conditions!.detail!, /an earlier check already failed/);
  });

  test("a broken rule is an error, not a quiet non-qualification", async () => {
    const p = await funded();
    const exchange = await publish(p, simpleDraft({ conditions: { op: "gt", left: { path: "subject.id" }, right: { literal: 5 } } }));
    const context = unwrap(await p.context.resolve(cartContext()));
    const result = await p.decisions.eligibility.evaluate({ exchange, context });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "RULE_ERROR");
  });

  test("a minimum base is enforced against the cart subtotal", async () => {
    const p = await funded();
    const exchange = await publish(p, simpleDraft({ limits: { minimumBase: { unit: "USD", decimal: "200.00" } } }));
    const context = unwrap(await p.context.resolve(cartContext()));
    const verdict = unwrap(await p.decisions.eligibility.evaluate({ exchange, context }));
    assert.equal(verdict.eligible, false);
    assert.match(verdict.primaryReason!, /minimum_base/);
  });

  test("a window with a past end date closes the offer", async () => {
    const p = await funded();
    const exchange = await publish(
      p,
      simpleDraft({ window: { from: instant("earth.unix.ms", 0n), to: instant("earth.unix.ms", 1000n) } }),
    );
    const context = unwrap(await p.context.resolve(cartContext()));
    const verdict = unwrap(await p.decisions.eligibility.evaluate({ exchange, context }));
    assert.equal(verdict.eligible, false);
    assert.match(verdict.primaryReason!, /window/);
  });
});

describe("acquisition", () => {
  test("a code offer needs the code", async () => {
    const p = await funded();
    const exchange = await publish(p, simpleDraft({ acquisition: { mode: "code", code: "SAVE10", codeSharing: "shared" } }));
    const context = unwrap(await p.context.resolve(cartContext()));

    assert.equal(unwrap(await p.decisions.eligibility.evaluate({ exchange, context })).eligible, false);
    assert.equal(
      unwrap(await p.decisions.eligibility.evaluate({ exchange, context, presentedCodes: ["save10"] })).eligible,
      true,
      "codes are matched case-insensitively",
    );
    assert.equal(
      unwrap(await p.decisions.eligibility.evaluate({ exchange, context, presentedCodes: [" SAVE10 "] })).eligible,
      true,
      "and whitespace-insensitively",
    );
  });

  test("an issued offer needs a grant held by an identified subject", async () => {
    const p = await funded();
    const exchange = await publish(p, simpleDraft({ acquisition: { mode: "issued" } }));
    const context = unwrap(await p.context.resolve(cartContext()));
    assert.equal(unwrap(await p.decisions.eligibility.evaluate({ exchange, context })).eligible, false);

    unwrap(await p.capabilities.issue({ tenant: TENANT, actor: "ops", valueExchangeId: exchange.id, subjectId: "s1" }));
    const grants = unwrap(await p.store.grants.forSubject(TENANT, "s1"));
    assert.equal(unwrap(await p.decisions.eligibility.evaluate({ exchange, context, grants })).eligible, true);
  });

  test("an anonymous subject cannot hold a grant", async () => {
    const p = await funded();
    const exchange = await publish(p, simpleDraft({ acquisition: { mode: "issued" } }));
    const context = unwrap(await p.context.resolve(cartContext({ subject: undefined })));
    const verdict = unwrap(await p.decisions.eligibility.evaluate({ exchange, context }));
    assert.match(verdict.primaryReason!, /identified subject/);
  });
});

describe("conflict rules", () => {
  test("exclusivity blocks everything, in either direction", async () => {
    const a = stackingOnly("a", { exclusive: true });
    const b = stackingOnly("b", {});
    assert.ok(conflictBetween(a, b));
    assert.ok(conflictBetween(b, a));
  });

  test("a shared group is a conflict unless both whitelist the other", async () => {
    const a = stackingOnly("a", { groups: ["g"] });
    const b = stackingOnly("b", { groups: ["g"] });
    assert.match(conflictBetween(a, b)!, /stacking group 'g'/);

    const a2 = stackingOnly("a", { groups: ["g"], combinesWith: ["b"] });
    const b2 = stackingOnly("b", { groups: ["g"], combinesWith: ["a"] });
    assert.equal(conflictBetween(a2, b2), null);

    const oneSided = stackingOnly("a", { groups: ["g"], combinesWith: ["b"] });
    assert.ok(conflictBetween(oneSided, b), "a one-sided whitelist is not enough");
  });

  test("different groups do not conflict", async () => {
    assert.equal(conflictBetween(stackingOnly("a", { groups: ["x"] }), stackingOnly("b", { groups: ["y"] })), null);
  });

  test("an explicit exclude wins", async () => {
    assert.match(conflictBetween(stackingOnly("a", { excludes: ["b"] }), stackingOnly("b", {}))!, /excludes/);
  });

  test("application order is priority descending then id ascending", async () => {
    const order = applicationOrder([
      stackingOnly("z", {}, 10),
      stackingOnly("a", {}, 10),
      stackingOnly("m", {}, 99),
    ]);
    assert.deepEqual(order.map((x) => x.id), ["m", "a", "z"]);
  });
});

describe("stacking outcomes", () => {
  async function twoOffers(secondApplication: "sequential" | "parallel") {
    const p = await funded();
    await publish(p, simpleDraft({ name: "A 10%", priority: 100, stacking: { groups: ["a"], application: "sequential" } }));
    await publish(
      p,
      simpleDraft({
        name: "B 10%",
        priority: 50,
        stacking: { groups: ["b"], application: secondApplication },
        benefits: [{ id: "d", type: "percentage", params: { rate: "10" }, effect: "price_reduction" }],
      }),
    );
    const context = unwrap(await p.context.resolve(cartContext()));
    return unwrap(await p.decisions.decide({ context }));
  }

  test("sequential benefits compound rather than add", async () => {
    const decision = await twoOffers("sequential");
    // 10% of 100 = 10, then 10% of the remaining 90 = 9. Total 19, not 20.
    assert.equal(toDecimal(decision.payableReduction), "19.00");
    assert.equal(toDecimal(decision.remainingPayable), "81.00");
  });

  test("parallel benefits both compute against the original base", async () => {
    const decision = await twoOffers("parallel");
    assert.equal(toDecimal(decision.payableReduction), "20.00");
  });

  test("the best compatible subset wins and the losers say why", async () => {
    const p = await funded();
    await publish(p, simpleDraft({ name: "small", benefits: [{ id: "d", type: "flat", params: { amount: "5.00" }, effect: "price_reduction" }], stacking: { groups: ["g"], application: "sequential" } }));
    await publish(p, simpleDraft({ name: "big", benefits: [{ id: "d", type: "flat", params: { amount: "25.00" }, effect: "price_reduction" }], stacking: { groups: ["g"], application: "sequential" } }));
    const context = unwrap(await p.context.resolve(cartContext()));
    const decision = unwrap(await p.decisions.decide({ context }));

    assert.equal(decision.applied.length, 1);
    assert.equal(decision.applied[0]!.name, "big");
    assert.equal(decision.displaced.length, 1);
    assert.match(decision.displaced[0]!.reason, /stacking group/);
    assert.equal(decision.searchMode, "exhaustive");
  });

  test("a decision with no candidates is an empty, valid decision", async () => {
    const p = await funded();
    const context = unwrap(await p.context.resolve(cartContext()));
    const decision = unwrap(await p.decisions.decide({ context }));
    assert.equal(decision.applied.length, 0);
    assert.equal(decision.payableReduction.minor, 0n);
    assert.equal(toDecimal(decision.remainingPayable), "100.00");
  });

  test("the decision hash is stable for identical inputs", async () => {
    const first = await twoOffers("sequential");
    const second = await twoOffers("sequential");
    assert.equal(first.hash, second.hash);
    assert.notEqual(first.hash, (await twoOffers("parallel")).hash);
  });
});

describe("objectives", () => {
  async function field() {
    const p = await funded();
    await publish(p, simpleDraft({ name: "twenty", benefits: [{ id: "d", type: "flat", params: { amount: "20.00" }, effect: "price_reduction" }], stacking: { groups: ["g"], application: "sequential" } }));
    await publish(p, simpleDraft({ name: "five", benefits: [{ id: "d", type: "flat", params: { amount: "5.00" }, effect: "price_reduction" }], stacking: { groups: ["g"], application: "sequential" } }));
    return { p, context: unwrap(await p.context.resolve(cartContext())) };
  }

  test("max_subject_value takes the largest", async () => {
    const { p, context } = await field();
    assert.equal(unwrap(await p.decisions.decide({ context })).applied[0]!.name, "twenty");
  });

  test("min_cost takes the smallest that still applies something", async () => {
    const { p, context } = await field();
    const decision = unwrap(await p.decisions.decide({ context, objective: "min_cost" }));
    assert.equal(decision.applied[0]!.name, "five");
  });

  test("an unknown objective is a typed error", async () => {
    const { p, context } = await field();
    assert.equal((await p.decisions.decide({ context, objective: "nope" })).ok, false);
  });
});

describe("candidate gathering", () => {
  test("a private exchange still applies; it is only hidden from discovery", async () => {
    const p = await funded();
    const exchange = await publish(p, simpleDraft({ visibility: "private" }));
    const context = unwrap(await p.context.resolve(cartContext()));

    const decision = unwrap(await p.decisions.decide({ context }));
    assert.equal(decision.applied.length, 1, "private exchanges must still be decided on");

    const discovered = unwrap(await p.discovery.discover({ context }));
    assert.equal(discovered.some((d) => d.valueExchangeId === exchange.id), false, "but must not be listed");
  });

  test("an explicit candidate list bypasses the sweep entirely", async () => {
    const p = await funded();
    const a = await publish(p, simpleDraft({ name: "A" }));
    await publish(p, simpleDraft({ name: "B" }));
    const context = unwrap(await p.context.resolve(cartContext()));
    const decision = unwrap(await p.decisions.decide({ context, candidateIds: [a.id] }));
    assert.equal(decision.candidatesConsidered, 1);
  });
});
