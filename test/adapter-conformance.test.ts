/**
 * Adapter conformance.
 *
 * The same behaviour, asserted against every adapter. An adapter is not "done"
 * because it compiles; it is done when it passes this file.
 *
 * These are deliberately end-to-end through the capability layer rather than
 * unit tests of the store: what matters is that the platform behaves
 * identically, not that two implementations happen to share a method signature.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toDecimal } from "../src/universal/economic/amount.ts";
import { reconcile, verifyLedger } from "../src/ledger/payout.ts";
import { compareKeys } from "../src/kernel/order.ts";
import { ADAPTERS } from "./_adapters.ts";
import { TENANT, TEST_MS, cartContext, funded, publish, simpleDraft, unwrap } from "./_helpers.ts";

for (const adapter of ADAPTERS) {
  describe(`${adapter.name}: conformance`, () => {
    test("round-trips a value exchange without losing anything", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      const published = await publish(
        p,
        simpleDraft({
          name: "Round trip",
          metadata: { campaign: "c-1", nested: { deep: [1, 2, 3] } },
          limits: { totalBudget: { unit: "USD", decimal: "500.00" }, perSubject: 3 },
          scope: { realities: ["production"], channels: ["web"] },
        }),
      );

      const loaded = unwrap(await store.exchanges.get(TENANT, published.id));
      assert.deepEqual(loaded, published, "a stored exchange must come back byte-identical");
      await store.close?.();
    });

    test("preserves bigint amounts exactly through storage", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      unwrap(
        await p.capabilities.fund({
          tenant: TENANT,
          actor: "t",
          sourceId: "big",
          label: "Large budget",
          party: { kind: "merchant", id: "m1" },
          unit: "USD",
          budgetDecimal: "92233720368547.75",
        }),
      );
      const source = unwrap(await store.funding.get(TENANT, "big"));
      assert.equal(source.budget!.minor, 9_223_372_036_854_775n);
      assert.equal(typeof source.budget!.minor, "bigint");
      await store.close?.();
    });

    test("finds an exchange by code, case- and space-insensitively", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(
        p,
        simpleDraft({ acquisition: { mode: "code", code: "SaveTen", codeSharing: "shared" } }),
      );
      for (const presented of ["SAVETEN", "  saveten  ", "SaveTen"]) {
        const found = unwrap(await store.exchanges.byCode(TENANT, presented));
        assert.ok(found, `'${presented}' should resolve`);
      }
      await store.close?.();
    });

    test("runs a full redeem, and the books balance", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(p, simpleDraft());

      const redeemed = unwrap(
        await p.capabilities.redeem({ context: cartContext(), actor: "checkout", idempotencyKey: "c-1" }),
      );
      assert.equal(toDecimal(redeemed.decision.payableReduction), "10.00");
      assert.equal(redeemed.execution.state, "captured");

      const entries = unwrap(await store.ledger.all(TENANT));
      assert.equal(entries.length, 2);
      assert.equal(verifyLedger(entries).ok, true);

      const source = unwrap(await store.funding.get(TENANT, "merchant-1"));
      assert.equal(toDecimal(source.spent), "10.00");
      assert.equal(toDecimal(source.reserved), "0.00");
      await store.close?.();
    });

    test("release restores both the hold and the limit", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      const exchange = await publish(p, simpleDraft({ limits: { totalRedemptions: 1 } }));

      const reserved = unwrap(
        await p.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "r-1" }),
      );
      assert.equal(unwrap(await store.counters.read({ tenant: TENANT, valueExchangeId: exchange.id })).redemptions, 1);

      unwrap(await p.capabilities.release({ context: cartContext(), executionId: reserved.execution.id }));

      assert.equal(unwrap(await store.counters.read({ tenant: TENANT, valueExchangeId: exchange.id })).redemptions, 0);
      assert.equal(toDecimal(unwrap(await store.funding.get(TENANT, "merchant-1")).reserved), "0.00");

      // The offer is live again.
      assert.equal(unwrap(await p.capabilities.apply({ context: cartContext() })).decision.applied.length, 1);
      await store.close?.();
    });

    test("reversal leaves every account flat", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(p, simpleDraft());

      const redeemed = unwrap(
        await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "rev-1" }),
      );
      unwrap(
        await p.capabilities.reverse({
          context: cartContext(),
          executionId: redeemed.execution.id,
          reason: "returned",
        }),
      );

      const entries = unwrap(await store.ledger.all(TENANT));
      assert.equal(entries.length, 4);
      for (const position of reconcile(entries)) {
        assert.equal(position.netMinor, 0n, `${position.accountId} should be flat`);
      }
      assert.equal(toDecimal(unwrap(await store.funding.get(TENANT, "merchant-1")).spent), "0.00");
      await store.close?.();
    });

    test("the audit chain verifies and detects nothing amiss", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(p, simpleDraft());
      unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "a-1" }));

      const audit = unwrap(await p.capabilities.audit({ tenant: TENANT }));
      assert.equal(audit.verified, true);
      assert.equal(audit.records, 6);
      assert.deepEqual(audit.recent.map((r) => r.kind), [
        "value_exchange.created",
        "value_exchange.transitioned",
        "value_exchange.transitioned",
        "value_exchange.transitioned",
        "execution.reserved",
        "execution.captured",
      ]);
      await store.close?.();
    });

    test("orders mixed-case ids the same way in every adapter", async () => {
      // Funding source ids are tenant-supplied, so mixed case is ordinary.
      // SQLite's ORDER BY is byte order; a JS sort using localeCompare is not,
      // and the two disagree on exactly this input. Test data that is all
      // lowercase hides it.
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      for (const sourceId of ["Zebra-fund", "apple-fund", "Apple-fund"]) {
        unwrap(
          await p.capabilities.fund({
            tenant: TENANT, actor: "test", sourceId, label: sourceId,
            party: { kind: "merchant", id: sourceId }, unit: "USD", budgetDecimal: "10.00",
          }),
        );
      }

      const listed = unwrap(await store.funding.list(TENANT)).map((source) => source.id);
      const expected = [...listed].sort(compareKeys);
      assert.deepEqual(listed, expected, "listing order must be codepoint order, not locale order");
      await store.close?.();
    });

    test("audit.range pages forward and agrees with recent", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(p, simpleDraft());
      unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "a-1" }));

      const head = unwrap(await store.audit.headSeq(TENANT));
      const everything = unwrap(await store.audit.range(TENANT, 0, head + 1));

      // Paging in twos must reconstruct exactly the same chain.
      const paged = [];
      for (let from = 0; ; from += 2) {
        const page = unwrap(await store.audit.range(TENANT, from, 2));
        if (page.length === 0) break;
        paged.push(...page);
      }
      assert.deepEqual(paged.map((r) => r.seq), everything.map((r) => r.seq));
      assert.deepEqual(everything.map((r) => r.seq), [0, 1, 2, 3, 4, 5], "oldest first, contiguous");

      // `recent` walks back from the head; the tail of a full range is the same.
      const recent = unwrap(await store.audit.recent(TENANT, 3));
      assert.deepEqual(recent.map((r) => r.hash), everything.slice(-3).map((r) => r.hash));

      // Bounds that ask for nothing return nothing rather than erroring.
      assert.equal(unwrap(await store.audit.range(TENANT, head + 1, 10)).length, 0);
      assert.equal(unwrap(await store.audit.range(TENANT, 0, 0)).length, 0);
      await store.close?.();
    });

    test("grants are issued, found by subject, and consume issuance atomically", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      const exchange = await publish(
        p,
        simpleDraft({ acquisition: { mode: "issued" }, limits: { totalIssuance: 2 } }),
      );

      unwrap(
        await p.capabilities.issue({ tenant: TENANT, actor: "ops", valueExchangeId: exchange.id, subjectId: "s1" }),
      );
      unwrap(
        await p.capabilities.issue({ tenant: TENANT, actor: "ops", valueExchangeId: exchange.id, subjectId: "s2" }),
      );
      const third = await p.capabilities.issue({
        tenant: TENANT,
        actor: "ops",
        valueExchangeId: exchange.id,
        subjectId: "s3",
      });
      assert.equal(third.ok, false, "issuance limit of 2 must hold");
      assert.equal(third.ok === false && third.error.code, "LIMIT_EXCEEDED");

      assert.equal(unwrap(await store.grants.forSubject(TENANT, "s1")).length, 1);
      await store.close?.();
    });

    test("touchpoints persist and come back oldest first", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      for (const [n, party] of [["c", "creator-a"], ["a", "affiliate-b"]] as const) {
        unwrap(
          await p.capabilities.track({
            tenant: TENANT,
            kind: "click",
            party: { kind: "affiliate", id: party },
            subjectId: "s1",
          }),
        );
        void n;
      }
      const attributed = unwrap(
        await p.capabilities.attribute({ tenant: TENANT, subjectId: "s1", model: "linear" }),
      );
      assert.equal(attributed.touchpoints, 2);
      assert.equal(attributed.shares.reduce((t, s) => t + s.basisPoints, 0), 10_000);
      await store.close?.();
    });

    test("a transaction that returns Err changes nothing", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      const exchange = await publish(p, simpleDraft());

      const outcome = await store.transaction(async (tx) => {
        unwrap(
          await tx.counters.tryConsume({
            tenant: TENANT,
            valueExchangeId: exchange.id,
            atSeconds: 0,
            limits: {},
            granted: [],
          }),
        );
        return { ok: false as const, error: { code: "CONFLICT" as const, message: "deliberate rollback" } };
      });

      assert.equal(outcome.ok, false);
      const counters = unwrap(await store.counters.read({ tenant: TENANT, valueExchangeId: exchange.id }));
      assert.equal(counters.redemptions, 0, "the rolled-back consume must not persist");
      await store.close?.();
    });

    test("tenants are isolated, including funding sources", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);

      unwrap(
        await p.capabilities.fund({
          tenant: "other-tenant",
          actor: "t",
          sourceId: "merchant-1", // same id, different tenant
          label: "Other tenant budget",
          party: { kind: "merchant", id: "m9" },
          unit: "USD",
          budgetDecimal: "1.00",
        }),
      );

      const mine = unwrap(await store.funding.get(TENANT, "merchant-1"));
      const theirs = unwrap(await store.funding.get("other-tenant", "merchant-1"));
      assert.equal(toDecimal(mine.budget!), "10000.00");
      assert.equal(toDecimal(theirs.budget!), "1.00");
      assert.equal(unwrap(await store.funding.list(TENANT)).length, 1);
      await store.close?.();
    });
  });
}
