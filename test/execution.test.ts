/**
 * Execution: reservations, capture, release, reversal, idempotency and limits.
 * This is where money and over-redemption live, so the tests are blunt.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toDecimal } from "../src/universal/economic/amount.ts";
import { verifyLedger, reconcile } from "../src/ledger/payout.ts";
import { availableOf } from "../src/ledger/settlement.ts";
import { TENANT, cartContext, funded, publish, simpleDraft, unwrap } from "./_helpers.ts";

describe("two-phase execution", () => {
  test("reserve holds budget and writes nothing to the ledger", async () => {
    const p = await funded();
    await publish(p, simpleDraft());
    const reserved = unwrap(await p.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "k1" }));

    assert.equal(reserved.execution.state, "reserved");
    const source = unwrap(await p.store.funding.get(TENANT, "merchant-1"));
    assert.equal(toDecimal(source.reserved), "10.00");
    assert.equal(toDecimal(source.spent), "0.00");
    assert.equal(unwrap(await p.store.ledger.all(TENANT)).length, 0, "nothing is posted until capture");
  });

  test("capture converts the hold into spend and posts balanced entries", async () => {
    const p = await funded();
    await publish(p, simpleDraft());
    const redeemed = unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k1" }));

    assert.equal(redeemed.execution.state, "captured");
    const source = unwrap(await p.store.funding.get(TENANT, "merchant-1"));
    assert.equal(toDecimal(source.reserved), "0.00");
    assert.equal(toDecimal(source.spent), "10.00");
    assert.equal(toDecimal(availableOf(source)!), "9990.00");
    assert.equal(verifyLedger(unwrap(await p.store.ledger.all(TENANT))).ok, true);
  });

  test("release gives back the hold and the consumed limit", async () => {
    const p = await funded();
    await publish(p, simpleDraft({ limits: { totalRedemptions: 1 } }));
    const reserved = unwrap(await p.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "k1" }));

    const afterReserve = unwrap(
      await p.store.counters.read({ tenant: TENANT, valueExchangeId: reserved.decision.applied[0]!.valueExchangeId }),
    );
    assert.equal(afterReserve.redemptions, 1);

    const released = unwrap(await p.capabilities.release({ context: cartContext(), executionId: reserved.execution.id }));
    assert.equal(released.state, "released");
    assert.equal(toDecimal(unwrap(await p.store.funding.get(TENANT, "merchant-1")).reserved), "0.00");
    const afterRelease = unwrap(
      await p.store.counters.read({ tenant: TENANT, valueExchangeId: reserved.decision.applied[0]!.valueExchangeId }),
    );
    assert.equal(afterRelease.redemptions, 0);

    // And the offer is available again.
    const after = unwrap(await p.capabilities.apply({ context: cartContext() }));
    assert.equal(after.decision.applied.length, 1);
  });

  test("reversal posts contra entries and leaves the ledger net zero", async () => {
    const p = await funded();
    await publish(p, simpleDraft());
    const redeemed = unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k1" }));
    unwrap(await p.capabilities.reverse({ context: cartContext(), executionId: redeemed.execution.id, reason: "returned" }));

    const entries = unwrap(await p.store.ledger.all(TENANT));
    assert.equal(entries.length, 4, "two original, two contra");
    assert.equal(verifyLedger(entries).ok, true);
    for (const position of reconcile(entries)) {
      assert.equal(position.netMinor, 0n, `${position.accountId} should be flat after reversal`);
    }
    assert.equal(toDecimal(unwrap(await p.store.funding.get(TENANT, "merchant-1")).spent), "0.00");
  });

  test("a released execution cannot be captured, and a captured one cannot be released", async () => {
    const p = await funded();
    await publish(p, simpleDraft());
    const reserved = unwrap(await p.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "k1" }));
    unwrap(await p.capabilities.release({ context: cartContext(), executionId: reserved.execution.id }));

    const context = unwrap(await p.context.resolve(cartContext()));
    assert.equal((await p.executions.capture(TENANT, reserved.execution.id, context)).ok, false);
    assert.equal((await p.capabilities.release({ context: cartContext(), executionId: reserved.execution.id })).ok, false);
  });
});

describe("idempotency", () => {
  test("the same key never consumes budget twice", async () => {
    const p = await funded();
    await publish(p, simpleDraft());
    const first = unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "order-1" }));
    const second = unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "order-1" }));

    assert.equal(first.execution.id, second.execution.id);
    assert.equal(toDecimal(unwrap(await p.store.funding.get(TENANT, "merchant-1")).spent), "10.00");
    assert.equal(unwrap(await p.store.ledger.all(TENANT)).length, 2, "capture must not post twice");
  });

  test("a different key is a different execution", async () => {
    const p = await funded();
    await publish(p, simpleDraft());
    const a = unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "order-1" }));
    const b = unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "order-2" }));
    assert.notEqual(a.execution.id, b.execution.id);
    assert.equal(toDecimal(unwrap(await p.store.funding.get(TENANT, "merchant-1")).spent), "20.00");
  });
});

describe("limits", () => {
  test("a total redemption cap stops the next redemption", async () => {
    const p = await funded();
    await publish(p, simpleDraft({ limits: { totalRedemptions: 2 } }));
    unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "1" }));
    unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "2" }));

    const third = unwrap(await p.capabilities.apply({ context: cartContext() }));
    assert.equal(third.decision.applied.length, 0);
    assert.match(third.decision.rejected[0]!.reason, /limit\.total_redemptions/);
  });

  test("a per-subject cap is scoped to that subject", async () => {
    const p = await funded();
    await publish(p, simpleDraft({ limits: { perSubject: 1 } }));
    unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "1" }));

    const same = unwrap(await p.capabilities.apply({ context: cartContext() }));
    assert.equal(same.decision.applied.length, 0);

    const other = unwrap(
      await p.capabilities.apply({ context: cartContext({ subject: { id: "s2", segments: [], counters: {} } }) }),
    );
    assert.equal(other.decision.applied.length, 1);
  });

  test("a total budget refuses the redemption that would exceed it", async () => {
    // Phase 1 tightened this. The old check asked "are we already over?", which
    // let a 15.00 budget fund 20.00 of grants and only blocked the one after.
    // It now asks "would this take us over?", so the budget is a real bound.
    const p = await funded();
    await publish(p, simpleDraft({ limits: { totalBudget: { unit: "USD", decimal: "15.00" } } }));

    // Each redemption grants 10.00 against a 15.00 budget.
    unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "1" }));

    const second = await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "2" });
    assert.equal(second.ok, false, "10.00 + 10.00 would exceed a 15.00 budget");
    assert.equal(second.ok === false && second.error.code, "LIMIT_EXCEEDED");
    assert.match(second.ok === false ? second.error.message : "", /limit\.total_budget/);

    // And nothing was consumed by the refusal.
    const spent = unwrap(await p.store.funding.get(TENANT, "merchant-1")).spent;
    assert.equal(toDecimal(spent), "10.00");
  });

  test("a budget that is exactly exhausted still permits the redemption that exhausts it", async () => {
    const p = await funded();
    await publish(p, simpleDraft({ limits: { totalBudget: { unit: "USD", decimal: "20.00" } } }));

    unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "1" }));
    unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "2" }));

    // 20.00 of 20.00 granted: the boundary is inclusive.
    const third = await p.capabilities.apply({ context: cartContext() });
    assert.equal(unwrap(third).decision.applied.length, 0);
    assert.match(unwrap(third).decision.rejected[0]!.reason, /limit\.total_budget/);
  });

  test("an exhausted funding source refuses the reservation rather than half-funding it", async () => {
    const p = await funded();
    unwrap(
      await p.capabilities.fund({
        tenant: TENANT, actor: "t", sourceId: "tiny", label: "Tiny", party: { kind: "merchant", id: "m1" },
        unit: "USD", budgetDecimal: "5.00",
      }),
    );
    await publish(p, simpleDraft({ funding: { model: "single", splits: [{ sourceId: "tiny" }] } }));
    const result = await p.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "1" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "INSUFFICIENT_FUNDS");
    assert.equal(toDecimal(unwrap(await p.store.funding.get(TENANT, "tiny")).reserved), "0.00", "no partial hold left behind");
  });
});

describe("realities", () => {
  test("a non-binding reality runs the whole path and posts nothing", async () => {
    const p = await funded();
    await publish(p, simpleDraft({ scope: { realities: ["production", "sandbox"] } }));
    const redeemed = unwrap(
      await p.capabilities.redeem({ context: cartContext({ reality: "sandbox" }), actor: "t", idempotencyKey: "s1" }),
    );

    assert.equal(redeemed.execution.state, "captured");
    assert.equal(toDecimal(redeemed.decision.payableReduction), "10.00", "the decision is fully computed");
    assert.equal(unwrap(await p.store.ledger.all(TENANT)).length, 0, "but nothing reaches the ledger");
  });

  test("simulate refuses to run in a binding reality", async () => {
    const p = await funded();
    const result = await p.capabilities.simulate({ context: cartContext(), reality: "production" });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /binding/);
  });

  test("an exchange scoped to production is invisible in sandbox", async () => {
    const p = await funded();
    await publish(p, simpleDraft({ scope: { realities: ["production"] } }));
    const sandbox = unwrap(await p.capabilities.apply({ context: cartContext({ reality: "sandbox" }) }));
    assert.equal(sandbox.decision.applied.length, 0);
  });
});

describe("guards", () => {
  test("reserving a decision that applied nothing is refused", async () => {
    const p = await funded();
    const result = await p.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "k" });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /applied nothing/);
  });

  test("combined benefits may never drive the payable below zero", async () => {
    const p = await funded();
    // Two parallel 60% discounts would take 120% off the basket.
    for (const name of ["a", "b"]) {
      await publish(
        p,
        simpleDraft({
          name,
          benefits: [{ id: "d", type: "percentage", params: { rate: "60" }, effect: "price_reduction" }],
          stacking: { groups: [name], application: "parallel" },
        }),
      );
    }
    const context = unwrap(await p.context.resolve(cartContext()));
    const result = await p.decisions.decide({ context });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "ILLEGAL_STATE");
  });
});
