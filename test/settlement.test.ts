/**
 * Funding allocation, ledger integrity and payout.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { allocateFunding } from "../src/ledger/settlement.ts";
import { assertBalanced } from "../src/ledger/ledger.ts";
import { reconcile, requestPayout, verifyLedger } from "../src/ledger/payout.ts";
import { fromDecimal, toDecimal, zero } from "../src/universal/economic/amount.ts";
import { EconomicAuthority } from "../src/universal/economic/authority.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import type { FundingSource, FundingModel } from "../src/model/funding.ts";
import type { LedgerEntry } from "../src/ledger/ledger.ts";
import { unwrap } from "../src/kernel/result.ts";

const source = (id: string, budget?: string, spent = "0.00"): FundingSource => ({
  id,
  tenant: "t",
  label: id,
  party: { kind: "merchant", id },
  unit: "USD",
  ...(budget === undefined ? {} : { budget: fromDecimal("USD", budget, 2) }),
  reserved: zero("USD", 2),
  spent: fromDecimal("USD", spent, 2),
});

const model = (strategy: "proportional" | "waterfall"): FundingModel => ({
  key: strategy, label: strategy, strategy,
});

const sources = (...list: FundingSource[]) => new Map(list.map((s) => [s.id, s]));

describe("proportional funding", () => {
  test("splits by weight and loses nothing to rounding", async () => {
    const allocations = unwrap(
      allocateFunding({
        cost: fromDecimal("USD", "100.00", 2),
        spec: { model: "proportional", splits: [{ sourceId: "a", weight: 2 }, { sourceId: "b", weight: 1 }] },
        sources: sources(source("a"), source("b")),
        model: model("proportional"),
      }),
    );
    assert.deepEqual(allocations.map((a) => toDecimal(a.amount)), ["66.67", "33.33"]);
    assert.equal(allocations.reduce((t, a) => t + a.amount.minor, 0n), 10_000n);
  });

  test("an odd penny always lands somewhere, never nowhere", async () => {
    for (const decimal of ["0.01", "0.02", "10.01", "999.97"]) {
      const allocations = unwrap(
        allocateFunding({
          cost: fromDecimal("USD", decimal, 2),
          spec: { model: "proportional", splits: [{ sourceId: "a" }, { sourceId: "b" }, { sourceId: "c" }] },
          sources: sources(source("a"), source("b"), source("c")),
          model: model("proportional"),
        }),
      );
      const total = allocations.reduce((t, a) => t + a.amount.minor, 0n);
      assert.equal(total, fromDecimal("USD", decimal, 2).minor, decimal);
    }
  });

  test("a cap moves the shortfall to a source with headroom", async () => {
    const allocations = unwrap(
      allocateFunding({
        cost: fromDecimal("USD", "100.00", 2),
        spec: {
          model: "proportional",
          splits: [{ sourceId: "a", cap: { decimal: "10.00" } }, { sourceId: "b" }],
        },
        sources: sources(source("a"), source("b")),
        model: model("proportional"),
      }),
    );
    assert.deepEqual(allocations.map((a) => toDecimal(a.amount)), ["10.00", "90.00"]);
    assert.equal(allocations[0]!.limitedBy, "cap");
  });

  test("an unfundable cost fails rather than half-funding", async () => {
    const result = allocateFunding({
      cost: fromDecimal("USD", "100.00", 2),
      spec: { model: "proportional", splits: [{ sourceId: "a", cap: { decimal: "10.00" } }] },
      sources: sources(source("a")),
      model: model("proportional"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "INSUFFICIENT_FUNDS");
  });

  test("an already-spent budget reduces the headroom", async () => {
    const result = allocateFunding({
      cost: fromDecimal("USD", "100.00", 2),
      spec: { model: "proportional", splits: [{ sourceId: "a" }] },
      sources: sources(source("a", "150.00", "80.00")),
      model: model("proportional"),
    });
    assert.equal(result.ok, false, "only 70.00 of the 150.00 budget is left");
  });
});

describe("waterfall funding", () => {
  test("fills each source in order up to its cap", async () => {
    const allocations = unwrap(
      allocateFunding({
        cost: fromDecimal("USD", "100.00", 2),
        spec: {
          model: "waterfall",
          splits: [{ sourceId: "a", cap: { decimal: "30.00" } }, { sourceId: "b", cap: { decimal: "50.00" } }, { sourceId: "c" }],
        },
        sources: sources(source("a"), source("b"), source("c")),
        model: model("waterfall"),
      }),
    );
    assert.deepEqual(allocations.map((a) => toDecimal(a.amount)), ["30.00", "50.00", "20.00"]);
  });

  test("a budget limit acts like a cap", async () => {
    const allocations = unwrap(
      allocateFunding({
        cost: fromDecimal("USD", "100.00", 2),
        spec: { model: "waterfall", splits: [{ sourceId: "a" }, { sourceId: "b" }] },
        sources: sources(source("a", "25.00"), source("b")),
        model: model("waterfall"),
      }),
    );
    assert.deepEqual(allocations.map((a) => toDecimal(a.amount)), ["25.00", "75.00"]);
    assert.equal(allocations[0]!.limitedBy, "budget");
  });
});

describe("funding validation", () => {
  test("rejects a source in the wrong unit", async () => {
    const eur: FundingSource = { ...source("a"), unit: "EUR" };
    const result = allocateFunding({
      cost: fromDecimal("USD", "10.00", 2),
      spec: { model: "single", splits: [{ sourceId: "a" }] },
      sources: sources(eur),
      model: model("proportional"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "UNIT_MISMATCH");
  });

  test("rejects an unknown source and an empty spec", async () => {
    const base = { cost: fromDecimal("USD", "10.00", 2), sources: sources(), model: model("proportional") };
    assert.equal(allocateFunding({ ...base, spec: { model: "single", splits: [{ sourceId: "ghost" }] } }).ok, false);
    assert.equal(allocateFunding({ ...base, spec: { model: "single", splits: [] } }).ok, false);
  });

  test("a zero cost allocates nothing at all", async () => {
    const allocations = unwrap(
      allocateFunding({
        cost: zero("USD", 2),
        spec: { model: "single", splits: [{ sourceId: "a" }] },
        sources: sources(source("a")),
        model: model("proportional"),
      }),
    );
    assert.deepEqual(allocations, []);
  });
});

describe("ledger integrity", () => {
  const entry = (accountId: string, direction: "debit" | "credit", decimal: string, unit = "USD"): LedgerEntry => ({
    id: `e-${accountId}-${direction}`,
    tenant: "t",
    reality: "production",
    transactionId: "txn-1",
    accountId,
    direction,
    amount: fromDecimal(unit, decimal, unit === "POINTS" ? 0 : 2),
    at: "0",
    reference: { kind: "test", id: "1" },
  });

  test("a balanced transaction is accepted", async () => {
    assert.equal(assertBalanced([entry("a", "debit", "10.00"), entry("b", "credit", "10.00")]).ok, true);
  });

  test("an unbalanced transaction is rejected, naming the unit", async () => {
    const result = assertBalanced([entry("a", "debit", "10.00"), entry("b", "credit", "9.00")]);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /does not balance in USD/);
  });

  test("units must balance independently of one another", async () => {
    const mixed = [
      entry("a", "debit", "10.00"),
      entry("b", "credit", "10.00"),
      entry("c", "debit", "50", "POINTS"),
    ];
    assert.equal(assertBalanced(mixed).ok, false, "POINTS does not balance even though USD does");
  });

  test("negative amounts are refused; direction carries the sign", async () => {
    const negative = { ...entry("a", "debit", "10.00"), amount: fromDecimal("USD", "-10.00", 2) };
    assert.equal(assertBalanced([negative, entry("b", "credit", "10.00")]).ok, false);
  });

  test("a single-sided transaction is refused", async () => {
    assert.equal(assertBalanced([entry("a", "debit", "10.00")]).ok, false);
  });

  test("reconciliation nets by account and unit", async () => {
    const entries = [
      entry("a", "debit", "10.00"),
      entry("b", "credit", "10.00"),
      entry("a", "credit", "4.00"),
    ];
    const positions = reconcile(entries);
    assert.equal(positions.find((p) => p.accountId === "a")!.netMinor, 600n);
    assert.equal(positions.find((p) => p.accountId === "b")!.netMinor, -1000n);
    assert.equal(verifyLedger(entries).ok, false, "these do not net to zero, and that is reported");
  });
});

describe("payout", () => {
  const economic = new EconomicAuthority();
  const ids = sequentialIdFactory();

  test("draws down a credit balance and stays balanced", async () => {
    const positions = [{ accountId: "pay:affiliate:x:USD", unit: "USD", netMinor: -5_000n, entries: 1 }];
    const payout = unwrap(
      requestPayout(
        {
          tenant: "t", reality: "production", fromAccountId: "pay:affiliate:x:USD",
          destination: { kind: "bank", reference: "acct" },
          amount: fromDecimal("USD", "30.00", 2), at: "0", ids, economic,
        },
        positions,
      ),
    );
    assert.equal(payout.entries.length, 2);
    assert.equal(assertBalanced(payout.entries).ok, true);
  });

  test("refuses to overdraw", async () => {
    const positions = [{ accountId: "pay:affiliate:x:USD", unit: "USD", netMinor: -1_000n, entries: 1 }];
    const result = requestPayout(
      {
        tenant: "t", reality: "production", fromAccountId: "pay:affiliate:x:USD",
        destination: { kind: "bank", reference: "acct" },
        amount: fromDecimal("USD", "30.00", 2), at: "0", ids, economic,
      },
      positions,
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "INSUFFICIENT_FUNDS");
  });

  test("refuses a non-transferable unit however large the balance", async () => {
    const positions = [{ accountId: "liab:points:s:POINTS", unit: "POINTS", netMinor: -999_999n, entries: 1 }];
    const result = requestPayout(
      {
        tenant: "t", reality: "production", fromAccountId: "liab:points:s:POINTS",
        destination: { kind: "bank", reference: "acct" },
        amount: { unit: "POINTS", minor: 10n, scale: 0 }, at: "0", ids, economic,
      },
      positions,
    );
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /not transferable/);
  });

  test("refuses a non-positive amount", async () => {
    const result = requestPayout(
      {
        tenant: "t", reality: "production", fromAccountId: "a",
        destination: { kind: "bank", reference: "acct" },
        amount: zero("USD", 2), at: "0", ids, economic,
      },
      [],
    );
    assert.equal(result.ok, false);
  });
});
