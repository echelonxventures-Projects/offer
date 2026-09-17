/**
 * Exact arithmetic. These are the tests that matter most: every other number in
 * the platform is derived from these operations, so a rounding error here is a
 * rounding error everywhere.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ROUNDING_MODES,
  add,
  allocate,
  clamp,
  compare,
  divideRound,
  fromDecimal,
  multiplyRate,
  percent,
  subtract,
  sum,
  toDecimal,
  zero,
} from "../src/universal/economic/amount.ts";
import { EconomicAuthority } from "../src/universal/economic/authority.ts";
import { defineRate } from "../src/universal/economic/exchange.ts";
import { unwrap } from "../src/kernel/result.ts";

describe("decimal parsing and rendering", () => {
  test("round-trips at the unit scale", async () => {
    for (const [decimal, scale] of [["12.34", 2], ["0.001", 3], ["100", 0], ["-5.50", 2]] as const) {
      const amount = fromDecimal("X", decimal, scale);
      assert.equal(toDecimal(amount), Number(decimal).toFixed(scale));
    }
  });

  test("refuses precision the unit cannot hold", async () => {
    assert.throws(() => fromDecimal("USD", "1.005", 2), /more precision than unit scale/);
  });

  test("accepts trailing zeros beyond scale", async () => {
    assert.equal(fromDecimal("USD", "1.2300", 2).minor, 123n);
  });
});

describe("rounding", () => {
  test("half_even breaks ties toward even, half_up away from zero", async () => {
    assert.equal(divideRound(5n, 2n, "half_even"), 2n);
    assert.equal(divideRound(7n, 2n, "half_even"), 4n);
    assert.equal(divideRound(5n, 2n, "half_up"), 3n);
  });

  test("floor and ceiling respect sign, down and up respect magnitude", async () => {
    assert.equal(divideRound(-5n, 2n, "floor"), -3n);
    assert.equal(divideRound(-5n, 2n, "ceiling"), -2n);
    assert.equal(divideRound(-5n, 2n, "down"), -2n);
    assert.equal(divideRound(-5n, 2n, "up"), -3n);
  });

  test("every mode agrees when the division is exact", async () => {
    for (const mode of ROUNDING_MODES) {
      assert.equal(divideRound(10n, 5n, mode), 2n, mode);
      assert.equal(divideRound(-10n, 5n, mode), -2n, mode);
    }
  });

  test("percentages are exact rationals, not floats", async () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; this must not be affected.
    const amount = fromDecimal("USD", "0.30", 2);
    assert.equal(multiplyRate(amount, percent("10"), "half_even").minor, 3n);
    // 12.5% of 12.34 is 1.5425, which half_even takes to 1.54.
    assert.equal(multiplyRate(fromDecimal("USD", "12.34", 2), percent("12.5"), "half_even").minor, 154n);
  });
});

describe("addition and comparison", () => {
  test("refuses to mix units", async () => {
    const result = add(fromDecimal("USD", "1.00", 2), fromDecimal("EUR", "1.00", 2));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "UNIT_MISMATCH");
  });

  test("refuses the same unit at two scales", async () => {
    const result = add({ unit: "USD", minor: 100n, scale: 2 }, { unit: "USD", minor: 100n, scale: 3 });
    assert.equal(result.ok, false);
  });

  test("sums and clamps", async () => {
    const total = unwrap(sum(zero("USD", 2), [fromDecimal("USD", "1.11", 2), fromDecimal("USD", "2.22", 2)]));
    assert.equal(toDecimal(total), "3.33");
    const clamped = unwrap(clamp(total, fromDecimal("USD", "0.00", 2), fromDecimal("USD", "2.00", 2)));
    assert.equal(toDecimal(clamped), "2.00");
  });

  test("orders correctly across the sign boundary", async () => {
    assert.equal(unwrap(compare(fromDecimal("USD", "-1.00", 2), fromDecimal("USD", "1.00", 2))), -1);
    assert.equal(unwrap(compare(fromDecimal("USD", "1.00", 2), fromDecimal("USD", "1.00", 2))), 0);
  });
});

describe("allocation", () => {
  test("never creates or destroys value", async () => {
    const cases: [string, bigint[]][] = [
      ["0.01", [1n, 1n, 1n]],
      ["100.00", [1n, 1n, 1n]],
      ["12.34", [7n, 2n, 1n]],
      ["0.07", [1n, 1n, 1n, 1n, 1n, 1n]],
      ["999.99", [1n]],
    ];
    for (const [decimal, weights] of cases) {
      const amount = fromDecimal("USD", decimal, 2);
      const parts = unwrap(allocate(amount, weights));
      const total = parts.reduce((t, p) => t + p.minor, 0n);
      assert.equal(total, amount.minor, `${decimal} split ${weights.length} ways`);
      assert.equal(parts.length, weights.length);
    }
  });

  test("hands the remainder to the largest weight first, deterministically", async () => {
    const parts = unwrap(allocate(fromDecimal("USD", "1.00", 2), [5n, 3n, 2n]));
    assert.deepEqual(parts.map((p) => p.minor), [50n, 30n, 20n]);

    const uneven = unwrap(allocate(fromDecimal("USD", "0.10", 2), [1n, 1n, 1n]));
    assert.deepEqual(uneven.map((p) => p.minor), [4n, 3n, 3n]);
  });

  test("handles negative amounts without leaking a unit", async () => {
    const parts = unwrap(allocate({ unit: "USD", minor: -10n, scale: 2 }, [1n, 1n, 1n]));
    assert.equal(parts.reduce((t, p) => t + p.minor, 0n), -10n);
  });

  test("rejects degenerate weights", async () => {
    assert.equal(allocate(fromDecimal("USD", "1.00", 2), []).ok, false);
    assert.equal(allocate(fromDecimal("USD", "1.00", 2), [0n, 0n]).ok, false);
    assert.equal(allocate(fromDecimal("USD", "1.00", 2), [-1n, 2n]).ok, false);
  });
});

describe("economic authority", () => {
  test("validates an amount against its registered scale", async () => {
    const authority = new EconomicAuthority();
    assert.equal(authority.validate({ unit: "USD", minor: 1n, scale: 2 }).ok, true);
    assert.equal(authority.validate({ unit: "USD", minor: 1n, scale: 4 }).ok, false);
    assert.equal(authority.validate({ unit: "NOPE", minor: 1n, scale: 2 }).ok, false);
  });

  test("converts across scales exactly and records the rate", async () => {
    const authority = new EconomicAuthority();
    authority.rates.register(defineRate({ from: "POINTS", to: "USD", numerator: 1, denominator: 100 }));
    const converted = unwrap(authority.convert({ unit: "POINTS", minor: 2500n, scale: 0 }, "USD"));
    assert.equal(toDecimal(converted.amount), "25.00");
    assert.equal(converted.rate.from, "POINTS");
  });

  test("inverts a rate rather than demanding both directions", async () => {
    const authority = new EconomicAuthority();
    authority.rates.register(defineRate({ from: "POINTS", to: "USD", numerator: 1, denominator: 100 }));
    const back = unwrap(authority.convert(fromDecimal("USD", "25.00", 2), "POINTS"));
    assert.equal(back.amount.minor, 2500n);
  });

  test("refuses to convert a non-exchangeable unit", async () => {
    const authority = new EconomicAuthority();
    // SEAT is an entitlement: not exchangeable by its unit class.
    const result = authority.convert({ unit: "SEAT", minor: 1n, scale: 0 }, "USD");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "UNIT_MISMATCH");
  });

  test("refuses a conversion with no rate at all", async () => {
    const authority = new EconomicAuthority();
    assert.equal(authority.convert(fromDecimal("USD", "1.00", 2), "EUR").ok, false);
  });
});

describe("subtraction", () => {
  test("produces negatives rather than clamping silently", async () => {
    const result = unwrap(subtract(fromDecimal("USD", "1.00", 2), fromDecimal("USD", "3.00", 2)));
    assert.equal(result.minor, -200n);
  });
});
