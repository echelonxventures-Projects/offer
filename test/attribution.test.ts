import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AttributionEngine, attributionModelRegistry } from "../src/attribution/attribution.ts";
import type { Touchpoint } from "../src/attribution/touchpoint.ts";
import { MemoryPlatformStore } from "../src/adapters/memory-store.ts";
import { fromDecimal, toDecimal } from "../src/universal/economic/amount.ts";
import { unwrap } from "../src/kernel/result.ts";

const touch = (id: string, party: string, at: number): Touchpoint => ({
  id,
  tenant: "t",
  subjectId: "s1",
  kind: "click",
  party: { kind: "affiliate", id: party },
  at: String(at),
});

const journey = [touch("t1", "a", 1000), touch("t2", "b", 2000), touch("t3", "c", 3000)];

async function engine(seed: readonly Touchpoint[] = journey): Promise<AttributionEngine> {
  const store = new MemoryPlatformStore();
  const e = new AttributionEngine(attributionModelRegistry(), store.touchpoints);
  for (const t of seed) unwrap(await e.record(t));
  return e;
}

describe("attribution models", () => {
  const cases: [string, number[]][] = [
    ["last_touch", [0, 0, 10_000]],
    ["first_touch", [10_000, 0, 0]],
    ["linear", [3334, 3333, 3333]],
    ["position_based", [4000, 2000, 4000]],
  ];

  for (const [model, expected] of cases) {
    test(`${model} divides credit as specified`, async () => {
      const e = await engine();
      const shares = unwrap(e.attribute(model, { touchpoints: journey }));
      assert.deepEqual(shares.map((s) => s.basisPoints), expected);
    });
  }

  test("every model's basis points sum to exactly 10000", async () => {
    const e = await engine();
    for (const model of attributionModelRegistry().keys()) {
      for (const length of [1, 2, 3, 5, 7]) {
        const subset = Array.from({ length }, (_, i) => touch(`x${i}`, `p${i}`, i * 100));
        const shares = unwrap(e.attribute(model, { touchpoints: subset }));
        const total = shares.reduce((t, s) => t + s.basisPoints, 0);
        assert.equal(total, 10_000, `${model} with ${length} touchpoint(s)`);
      }
    }
  });

  test("money is divided exactly, with no cent invented or lost", async () => {
    const e = await engine();
    for (const model of attributionModelRegistry().keys()) {
      const value = fromDecimal("USD", "100.00", 2);
      const shares = unwrap(e.attribute(model, { touchpoints: journey, value }));
      const total = shares.reduce((t, s) => t + (s.amount?.minor ?? 0n), 0n);
      assert.equal(total, value.minor, model);
    }
  });

  test("time_decay weights later touches more heavily", async () => {
    const e = await engine();
    const shares = unwrap(e.attribute("time_decay", { touchpoints: journey }));
    assert.ok(shares[2]!.basisPoints > shares[1]!.basisPoints);
    assert.ok(shares[1]!.basisPoints > shares[0]!.basisPoints);
  });

  test("a single touchpoint takes everything under every model", async () => {
    const e = await engine();
    for (const model of attributionModelRegistry().keys()) {
      const shares = unwrap(e.attribute(model, { touchpoints: [journey[0]!] }));
      assert.equal(shares[0]!.basisPoints, 10_000, model);
    }
  });

  test("an empty journey attributes nothing rather than failing", async () => {
    const e = await engine();
    assert.deepEqual(unwrap(e.attribute("linear", { touchpoints: [] })), []);
  });

  test("an unknown model is a typed error", async () => {
    const e = await engine();
    assert.equal(e.attribute("telepathy", { touchpoints: journey }).ok, false);
  });
});

describe("journeys", () => {
  test("are returned oldest first regardless of insertion order", async () => {
    const e = await engine([touch("late", "c", 3000), touch("early", "a", 1000)]);
    const found = unwrap(await e.journey({ tenant: "t", subjectId: "s1", nowTick: 5000n }));
    assert.deepEqual(found.map((t) => t.id), ["early", "late"]);
  });

  test("the lookback window excludes older touches", async () => {
    const e = await engine();
    // now = 3500ms, lookback 2s -> cutoff 1500ms, so t1 at 1000 drops out.
    const found = unwrap(await e.journey({ tenant: "t", subjectId: "s1", nowTick: 3500n, lookbackSeconds: 2 }));
    assert.deepEqual(found.map((t) => t.id), ["t2", "t3"]);
  });

  test("tenants do not see one another's journeys", async () => {
    const e = await engine();
    const found = unwrap(await e.journey({ tenant: "other", subjectId: "s1", nowTick: 5000n }));
    assert.equal(found.length, 0);
  });

  test("touchpoints survive in the store, not in engine memory", async () => {
    const store = new MemoryPlatformStore();
    const first = new AttributionEngine(attributionModelRegistry(), store.touchpoints);
    unwrap(await first.record(touch("t1", "a", 1000)));

    // A second engine over the same store sees the same history.
    const second = new AttributionEngine(attributionModelRegistry(), store.touchpoints);
    const found = unwrap(await second.journey({ tenant: "t", subjectId: "s1", nowTick: 5000n }));
    assert.deepEqual(found.map((t) => t.id), ["t1"]);
  });

  test("money shares are readable amounts", async () => {
    const e = await engine();
    const shares = unwrap(e.attribute("linear", { touchpoints: journey, value: fromDecimal("USD", "10.00", 2) }));
    assert.deepEqual(shares.map((s) => toDecimal(s.amount!)), ["3.34", "3.33", "3.33"]);
  });
});
