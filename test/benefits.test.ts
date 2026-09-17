/**
 * Benefit handlers and the resolution engine.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BenefitResolutionEngine, selectLines } from "../src/engines/benefit-resolution.ts";
import { toDecimal } from "../src/universal/economic/amount.ts";
import type { BenefitSpec } from "../src/model/benefit.ts";
import { platform, cartContext, simpleDraft, funded, publish, TENANT, unwrap, usd } from "./_helpers.ts";

async function resolveWith(benefits: BenefitSpec[], contextOver = {}) {
  const p = await funded();
  const exchange = await publish(p, simpleDraft({ benefits }));
  const context = unwrap(await p.context.resolve(cartContext(contextOver)));
  const engine = new BenefitResolutionEngine(p.deps);
  return { p, context, engine, resolve: () => engine.resolve({ exchange, context }) };
}

const spec = (over: Partial<BenefitSpec>): BenefitSpec => ({
  id: "b",
  type: "percentage",
  params: { rate: "10" },
  effect: "price_reduction",
  ...over,
});

describe("percentage and flat", () => {
  test("percentage of the whole basket", async () => {
    const { resolve } = await resolveWith([spec({})]);
    const result = unwrap(resolve());
    assert.equal(toDecimal(result.payableReduction), "10.00");
  });

  test("a flat discount never exceeds the base it applies to", async () => {
    const { resolve } = await resolveWith([spec({ type: "flat", params: { amount: "500.00" } })]);
    const result = unwrap(resolve());
    assert.equal(toDecimal(result.payableReduction), "100.00", "clipped to the basket total");
    assert.match(result.computations[0]!.detail, /limited to base/);
  });

  test("a cap reduces the value and re-spreads the allocations to match", async () => {
    const { resolve } = await resolveWith([spec({ params: { rate: "50" }, cap: { decimal: "12.00" } })]);
    const result = unwrap(resolve());
    const computation = result.computations[0]!;
    assert.equal(toDecimal(computation.value), "12.00");
    assert.equal(computation.capped, true);
    const allocated = computation.allocations.reduce((t, a) => t + a.amount.minor, 0n);
    assert.equal(allocated, computation.value.minor, "allocations must still sum to the value");
  });
});

describe("targeting", () => {
  test("restricts the base to the matching lines", async () => {
    const { resolve } = await resolveWith([spec({ params: { rate: "50" }, target: { categories: ["toys"] } })]);
    // Only the 40.00 gadget line is in 'toys'.
    assert.equal(toDecimal(unwrap(resolve()).payableReduction), "20.00");
  });

  test("selects cheapest or most expensive, and caps the line count", async () => {
    const lines = [
      { id: "a", sku: "A", quantity: 1, unitPrice: usd(1_000n), categories: ["x"] },
      { id: "b", sku: "B", quantity: 1, unitPrice: usd(5_000n), categories: ["x"] },
      { id: "c", sku: "C", quantity: 1, unitPrice: usd(3_000n), categories: ["x"] },
    ];
    assert.deepEqual(selectLines(lines, { select: "cheapest", maxLines: 2 }).map((l) => l.id), ["a", "c"]);
    assert.deepEqual(selectLines(lines, { select: "most_expensive", maxLines: 1 }).map((l) => l.id), ["b"]);
    assert.deepEqual(selectLines(lines, { skus: ["?"] }).map((l) => l.id), ["a", "b", "c"]);
    assert.deepEqual(selectLines(lines, { categories: ["nope"] }), []);
  });
});

describe("tiered and volume", () => {
  test("tiered picks the highest threshold that the base meets", async () => {
    const tiers = [
      { min: "50.00", rate: "5" },
      { min: "100.00", rate: "15" },
      { min: "500.00", rate: "25" },
    ];
    const { resolve } = await resolveWith([spec({ type: "tiered", params: { tiers } })]);
    assert.equal(toDecimal(unwrap(resolve()).payableReduction), "15.00");
  });

  test("tiered yields nothing when no threshold is met", async () => {
    const { resolve } = await resolveWith([spec({ type: "tiered", params: { tiers: [{ min: "500.00", rate: "25" }] } })]);
    const result = unwrap(resolve());
    assert.equal(result.payableReduction.minor, 0n);
    assert.match(result.computations[0]!.detail, /no tier threshold met/);
  });

  test("volume thresholds count items, not money", async () => {
    const tiers = [
      { minQuantity: 2, rate: "10" },
      { minQuantity: 10, rate: "30" },
    ];
    const { resolve } = await resolveWith([spec({ type: "volume", params: { tiers } })]);
    assert.equal(toDecimal(unwrap(resolve()).payableReduction), "10.00");
  });
});

describe("fixed price and free quantity", () => {
  test("fixed_price charges the difference per unit", async () => {
    // WIDGET is 30.00 x2; fixing it at 25.00 saves 10.00.
    const { resolve } = await resolveWith([
      spec({ type: "fixed_price", params: { price: "25.00" }, target: { skus: ["WIDGET"] } }),
    ]);
    assert.equal(toDecimal(unwrap(resolve()).payableReduction), "10.00");
  });

  test("fixed_price never charges a negative difference", async () => {
    const { resolve } = await resolveWith([
      spec({ type: "fixed_price", params: { price: "999.00" }, target: { skus: ["WIDGET"] } }),
    ]);
    assert.equal(unwrap(resolve()).payableReduction.minor, 0n);
  });

  test("free_quantity gives away the cheapest units", async () => {
    const context = {
      cart: {
        lines: [
          { id: "l1", sku: "A", quantity: 2, unitPrice: usd(1_000n), categories: ["x"], merchant: "m1" },
          { id: "l2", sku: "B", quantity: 2, unitPrice: usd(5_000n), categories: ["x"], merchant: "m1" },
        ],
      },
    };
    // 4 units, buy 2 get 1 free -> one group of 3, so 1 free unit, the cheapest.
    const { resolve } = await resolveWith([spec({ type: "free_quantity", params: { buy: 2, free: 1 } })], context);
    const result = unwrap(resolve());
    assert.equal(toDecimal(result.payableReduction), "10.00");
    assert.match(result.computations[0]!.detail, /1 unit\(s\) free/);
  });
});

describe("points and non-monetary effects", () => {
  test("points accrue in their own unit and do not reduce the payable", async () => {
    const { resolve } = await resolveWith([
      spec({ type: "points_accrual", params: { points: 2, per: 1 }, effect: "points_grant", unit: "POINTS" }),
    ]);
    const result = unwrap(resolve());
    assert.equal(result.payableReduction.minor, 0n, "points must not reduce the price");
    assert.equal(result.granted.length, 1);
    assert.equal(result.granted[0]!.unit, "POINTS");
    assert.equal(result.granted[0]!.minor, 200n, "100 whole USD at 2 points each");
  });

  test("ranking counts only value in the interaction's own unit", async () => {
    const { resolve } = await resolveWith([
      spec({ type: "points_accrual", params: { points: 2, per: 1 }, effect: "points_grant", unit: "POINTS" }),
    ]);
    assert.equal(unwrap(resolve()).rankingValue.minor, 0n);
  });

  test("item_grant carries its payload and its cost", async () => {
    const { resolve } = await resolveWith([
      spec({ type: "item_grant", params: { sku: "FREE-MUG", quantity: 2, value: "4.50" }, effect: "item_grant" }),
    ]);
    const computation = unwrap(resolve()).computations[0]!;
    assert.equal(toDecimal(computation.value), "9.00");
    assert.deepEqual(computation.grant, { sku: "FREE-MUG", quantity: 2 });
  });

  test("a 'base' benefit may not declare a foreign unit", async () => {
    // 10% of a USD basket is USD. Claiming it is POINTS is meaningless without
    // an exchange rate, so it is refused rather than silently ignored.
    const { resolve } = await resolveWith([
      spec({ type: "percentage", params: { rate: "10" }, effect: "price_reduction", unit: "POINTS" }),
    ]);
    const result = resolve();
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "INVALID_REQUEST");
    assert.match(result.ok === false ? result.error.message : "", /computes in the interaction unit/);
  });

  test("a 'declared' benefit mints value in the unit it names", async () => {
    const { resolve } = await resolveWith([
      spec({ type: "flat", params: { amount: "250" }, effect: "points_grant", unit: "POINTS" }),
    ]);
    const result = unwrap(resolve());
    assert.equal(result.payableReduction.minor, 0n);
    assert.equal(result.granted[0]!.unit, "POINTS");
    assert.equal(result.granted[0]!.minor, 250n);
  });
});

describe("unknown registrations", () => {
  test("governance refuses to publish an unregistered benefit type", async () => {
    const p = await funded();
    const created = unwrap(
      await p.capabilities.create({ tenant: TENANT, actor: "author", draft: simpleDraft({ benefits: [spec({ type: "acme.magic" })] }) }),
    );
    const published = await p.capabilities.publish({ tenant: TENANT, actor: "author", valueExchangeId: created.id, approvedBy: "approver" });
    assert.equal(published.ok, false);
    assert.equal(published.ok === false && published.error.code, "GOVERNANCE_REJECTED");
  });

  test("and the resolution engine refuses it too, if governance is bypassed", async () => {
    const p = await funded();
    const created = unwrap(
      await p.capabilities.create({ tenant: TENANT, actor: "author", draft: simpleDraft({ benefits: [spec({ type: "acme.magic" })] }) }),
    );
    const context = unwrap(await p.context.resolve(cartContext()));
    const result = new BenefitResolutionEngine(p.deps).resolve({ exchange: created, context });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "UNKNOWN_REGISTRY_ENTRY");
  });
});
