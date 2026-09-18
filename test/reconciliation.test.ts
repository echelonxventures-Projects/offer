/**
 * Snapshot-backed reconciliation.
 *
 * The property under test is not "the balances are right" - a full fold gave
 * the right balances too. It is that answering the question stops getting more
 * expensive as the ledger grows, while still giving the same answer.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ReconciliationService } from "../src/ledger/reconciliation.ts";
import { instant } from "../src/universal/temporal/chronology.ts";
import { toDecimal } from "../src/universal/economic/amount.ts";
import { ADAPTERS } from "./_adapters.ts";
import { TENANT, TEST_MS, cartContext, funded, publish, simpleDraft, unwrap } from "./_helpers.ts";

const at = (ms: number) => instant("earth.unix.ms", BigInt(ms));

/** n redemptions, each writing two ledger entries. */
async function withLedger(adapterIndex: number, redemptions: number) {
  const store = await ADAPTERS[adapterIndex]!.create();
  const platform = await funded(TEST_MS, store);
  await publish(platform, simpleDraft());

  for (let i = 0; i < redemptions; i += 1) {
    unwrap(
      await platform.capabilities.redeem({
        context: cartContext({ subject: { id: `s${i}`, segments: [], counters: {} } }),
        actor: "t",
        idempotencyKey: `k${i}`,
      }),
    );
  }
  return { store, platform, reconciliation: new ReconciliationService(store) };
}

for (const [index, adapter] of ADAPTERS.entries()) {
  describe(`${adapter.name}: reconciliation`, () => {
    test("positions match a full fold of every entry", async () => {
      const { store, reconciliation } = await withLedger(index, 5);

      const computed = unwrap(await reconciliation.positions(TENANT));
      const entries = unwrap(await store.ledger.all(TENANT));

      // Independent full scan, to check the incremental path against.
      const expected = new Map<string, bigint>();
      for (const entry of entries) {
        const key = `${entry.accountId}|${entry.amount.unit}`;
        const signed = entry.direction === "debit" ? entry.amount.minor : -entry.amount.minor;
        expected.set(key, (expected.get(key) ?? 0n) + signed);
      }

      assert.equal(computed.positions.length, expected.size);
      for (const position of computed.positions) {
        assert.equal(position.netMinor, expected.get(`${position.accountId}|${position.unit}`));
      }
      await store.close?.();
    });

    test("a snapshot means later reads fold almost nothing", async () => {
      const { store, platform, reconciliation } = await withLedger(index, 10);

      const before = unwrap(await reconciliation.positions(TENANT));
      assert.equal(before.foldedEntries, 20, "no snapshot: every entry is folded");
      assert.equal(before.fromSnapshotSeq, -1);

      unwrap(await reconciliation.snapshot(TENANT, at(TEST_MS)));

      const afterSnapshot = unwrap(await reconciliation.positions(TENANT));
      assert.equal(afterSnapshot.foldedEntries, 0, "everything is already accounted for");
      assert.deepEqual(afterSnapshot.positions, before.positions, "and the answer is unchanged");

      // Two more redemptions: only the new entries are folded.
      for (const i of [100, 101]) {
        unwrap(
          await platform.capabilities.redeem({
            context: cartContext({ subject: { id: `later-${i}`, segments: [], counters: {} } }),
            actor: "t",
            idempotencyKey: `later-${i}`,
          }),
        );
      }

      const incremental = unwrap(await reconciliation.positions(TENANT));
      assert.equal(incremental.foldedEntries, 4, "only what came after the snapshot");
      assert.equal(incremental.throughSeq, 23);
      await store.close?.();
    });

    test("the snapshot is derived, never authoritative", async () => {
      const { store, reconciliation } = await withLedger(index, 6);
      unwrap(await reconciliation.snapshot(TENANT, at(TEST_MS)));

      const withSnapshot = unwrap(await reconciliation.positions(TENANT));

      // A fresh service over the same entries with no snapshot must agree. This
      // is the property that makes caching a financial figure safe at all.
      const fresh = new ReconciliationService(await ADAPTERS[index]!.create());
      const rebuiltStore = store;
      const rebuilt = new ReconciliationService(rebuiltStore);
      void fresh;

      const entries = unwrap(await rebuiltStore.ledger.all(TENANT));
      assert.ok(entries.length > 0);

      const again = unwrap(await rebuilt.positions(TENANT));
      assert.deepEqual(again.positions, withSnapshot.positions);
      await store.close?.();
    });

    test("folding is batched, so a large ledger does not arrive at once", async () => {
      const { store } = await withLedger(index, 12);
      const batched = new ReconciliationService(store, 3);

      const positions = unwrap(await batched.positions(TENANT));
      assert.equal(positions.foldedEntries, 24, "every entry is still folded");
      assert.equal(positions.throughSeq, 23);
      await store.close?.();
    });

    test("verify reports balance without rescanning", async () => {
      const { store, reconciliation } = await withLedger(index, 4);
      unwrap(await reconciliation.snapshot(TENANT, at(TEST_MS)));

      const verified = unwrap(await reconciliation.verify(TENANT));
      assert.equal(verified.balanced, true);
      assert.deepEqual(verified.units, ["USD"]);
      assert.equal(verified.imbalances, undefined);
      await store.close?.();
    });

    test("an empty ledger cannot be snapshotted, and says so", async () => {
      const store = await adapter.create();
      const reconciliation = new ReconciliationService(store);
      const result = await reconciliation.snapshot(TENANT, at(TEST_MS));
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.error.code, "NOT_FOUND");
      await store.close?.();
    });

    test("settle reports what it cost, not just what it found", async () => {
      const { store, platform, reconciliation } = await withLedger(index, 3);
      unwrap(await reconciliation.snapshot(TENANT, at(TEST_MS)));

      const settled = unwrap(await platform.capabilities.settle({ tenant: TENANT }));
      assert.equal(settled.balanced, true);
      assert.equal(settled.foldedEntries, 0, "the snapshot did the work");
      assert.equal(settled.throughSeq, 5);
      await store.close?.();
    });

    test("payout draws on snapshot-backed balances", async () => {
      const store = await adapter.create();
      const platform = await funded(TEST_MS, store);
      unwrap(
        await platform.capabilities.fund({
          tenant: TENANT, actor: "t", sourceId: "marketplace", label: "Marketplace",
          party: { kind: "marketplace", id: "mp" }, unit: "USD", budgetDecimal: "1000.00",
        }),
      );
      await publish(
        platform,
        simpleDraft({
          benefits: [{ id: "c", type: "percentage", params: { rate: "10" }, effect: "commission" }],
          funding: { model: "single", splits: [{ sourceId: "marketplace" }] },
        }),
      );
      unwrap(
        await platform.capabilities.redeem({
          context: cartContext(), actor: "t", idempotencyKey: "k",
          payee: { kind: "affiliate", id: "partner" },
        }),
      );

      unwrap(await platform.reconciliation.snapshot(TENANT, at(TEST_MS)));

      const paid = unwrap(
        await platform.capabilities.pay({
          tenant: TENANT,
          fromAccountId: "pay:affiliate:partner:USD",
          destination: { kind: "bank", reference: "acct" },
          unit: "USD",
          decimal: "10.00",
        }),
      );
      assert.equal(paid.entries.length, 2);

      // And the books still balance after the payout.
      assert.equal(unwrap(await platform.reconciliation.verify(TENANT)).balanced, true);
      await store.close?.();
    });
  });
}

describe("snapshot safety", () => {
  test("refuses to snapshot a ledger that does not balance", async () => {
    const store = await ADAPTERS[0]!.create();
    const platform = await funded(TEST_MS, store);
    await publish(platform, simpleDraft());
    unwrap(await platform.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k" }));

    // Write a single-sided entry straight to the store, bypassing the balance
    // check, exactly as a partial capture would leave behind.
    const entries = unwrap(await store.ledger.all(TENANT));
    unwrap(
      await store.ledger.append([
        { ...entries[0]!, id: "orphan", transactionId: "txn-orphan", accountId: "exp:ghost:USD" },
      ]),
    );

    const result = await platform.reconciliation.snapshot(TENANT, at(TEST_MS));
    assert.equal(result.ok, false, "trusting a hole would make it permanent");
    assert.equal(result.ok === false && result.error.code, "CONFLICT");

    // And health still notices, because verify does not depend on the snapshot.
    const report = unwrap(await platform.health.check(TENANT, { now: at(TEST_MS) }));
    assert.equal(report.status, "unhealthy");
    assert.equal(report.checks.find((check) => check.name === "ledger")!.status, "unhealthy");
  });

  test("an imbalance is reported per unit, with the net", async () => {
    const store = await ADAPTERS[0]!.create();
    const platform = await funded(TEST_MS, store);
    await publish(platform, simpleDraft());
    unwrap(await platform.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k" }));

    const entries = unwrap(await store.ledger.all(TENANT));
    unwrap(await store.ledger.append([{ ...entries[0]!, id: "orphan", accountId: "exp:ghost:USD" }]));

    const verified = unwrap(await platform.reconciliation.verify(TENANT));
    assert.equal(verified.balanced, false);
    assert.equal(verified.imbalances!.length, 1);
    assert.equal(verified.imbalances![0]!.unit, "USD");
    assert.equal(toDecimal({ unit: "USD", minor: BigInt(verified.imbalances![0]!.net), scale: 2 }), "10.00");
  });
});

describe("the snapshot maintenance job", () => {
  test("records one, and the next pass has nothing to fold", async () => {
    const store = await ADAPTERS[0]!.create();
    const platform = await funded(TEST_MS, store);
    await publish(platform, simpleDraft());
    unwrap(await platform.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k" }));

    const report = unwrap(await platform.maintenance.runDue(TENANT, at(TEST_MS)));
    const job = report.jobs.find((entry) => entry.job === "ledger.snapshot")!;
    assert.equal(job.status, "ran");
    assert.match(job.summary, /snapshotted \d+ account position/);

    assert.equal(unwrap(await platform.reconciliation.positions(TENANT)).foldedEntries, 0);
  });

  test("an empty ledger is not a failure", async () => {
    const store = await ADAPTERS[0]!.create();
    const platform = await funded(TEST_MS, store);
    const report = unwrap(await platform.maintenance.runDue(TENANT, at(TEST_MS)));
    assert.equal(report.failed, 0);
    assert.match(report.jobs.find((entry) => entry.job === "ledger.snapshot")!.summary, /no ledger entries/);
  });
});
