/**
 * The Phase 1 exit criterion.
 *
 * "Two concurrent reservations against a limit of one - exactly one succeeds,
 * every time, under load."
 *
 * These tests are the reason the storage ports were reshaped. The old
 * `CounterStore.mutate(counters => ...)` interface could not pass them against
 * any adapter that genuinely interleaves, because the limit check and the write
 * were separated by an await. Every test here fires real concurrent calls
 * through the full capability layer, not through a mocked store.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toDecimal } from "../src/universal/economic/amount.ts";
import { ADAPTERS } from "./_adapters.ts";
import { TENANT, TEST_MS, cartContext, funded, publish, simpleDraft, unwrap } from "./_helpers.ts";

/** Distinct subjects, so per-subject limits do not mask the shared one. */
const subject = (n: number) => ({
  subject: { id: `s${n}`, segments: [], counters: {} },
});

for (const adapter of ADAPTERS) {
  describe(`${adapter.name}: concurrent redemption`, () => {
    test("a total redemption limit of 1 admits exactly one of 25 concurrent reservations", async () => {
      const store = adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(p, simpleDraft({ limits: { totalRedemptions: 1 } }));

      const attempts = 25;
      const results = await Promise.all(
        Array.from({ length: attempts }, (_, i) =>
          p.capabilities.reserve({
            context: cartContext(subject(i)),
            actor: "load",
            idempotencyKey: `key-${i}`,
          }),
        ),
      );

      const succeeded = results.filter((r) => r.ok);
      const refused = results.filter((r) => !r.ok);

      assert.equal(succeeded.length, 1, `expected exactly 1 of ${attempts} to succeed`);
      assert.equal(refused.length, attempts - 1);
      for (const failure of refused) {
        assert.equal(failure.ok === false && failure.error.code, "LIMIT_EXCEEDED");
      }

      // And the counter agrees with reality.
      const counters = unwrap(
        await store.counters.read({
          tenant: TENANT,
          valueExchangeId: unwrap(succeeded[0]!).decision.applied[0]!.valueExchangeId,
        }),
      );
      assert.equal(counters.redemptions, 1);

      await store.close?.();
    });

    test("a per-subject limit of 1 admits one reservation per subject, concurrently", async () => {
      const store = adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(p, simpleDraft({ limits: { perSubject: 1 } }));

      // Three subjects, four attempts each, all at once.
      const calls = [0, 1, 2].flatMap((s) =>
        Array.from({ length: 4 }, (_, attempt) =>
          p.capabilities.reserve({
            context: cartContext(subject(s)),
            actor: "load",
            idempotencyKey: `s${s}-a${attempt}`,
          }),
        ),
      );
      const results = await Promise.all(calls);

      assert.equal(results.filter((r) => r.ok).length, 3, "one per subject, no more");
      await store.close?.();
    });

    test("a budget that covers one benefit funds exactly one of many concurrent reservations", async () => {
      const store = adapter.create();
      const p = await funded(TEST_MS, store);
      // Headroom for a single 10.00 discount and no more.
      unwrap(
        await p.capabilities.fund({
          tenant: TENANT,
          actor: "test",
          sourceId: "tight",
          label: "Tight budget",
          party: { kind: "merchant", id: "m1" },
          unit: "USD",
          budgetDecimal: "10.00",
        }),
      );
      await publish(p, simpleDraft({ funding: { model: "single", splits: [{ sourceId: "tight" }] } }));

      const results = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          p.capabilities.reserve({
            context: cartContext(subject(i)),
            actor: "load",
            idempotencyKey: `b-${i}`,
          }),
        ),
      );

      assert.equal(results.filter((r) => r.ok).length, 1);
      for (const failure of results.filter((r) => !r.ok)) {
        assert.equal(failure.ok === false && failure.error.code, "INSUFFICIENT_FUNDS");
      }

      // Exactly 10.00 held, never 20.00.
      const source = unwrap(await store.funding.get(TENANT, "tight"));
      assert.equal(toDecimal(source.reserved), "10.00");
      assert.equal(toDecimal(source.spent), "0.00");

      await store.close?.();
    });

    test("the same idempotency key fired concurrently yields one execution", async () => {
      const store = adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(p, simpleDraft());

      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          p.capabilities.redeem({ context: cartContext(), actor: "load", idempotencyKey: "order-same" }),
        ),
      );

      const ids = new Set(results.filter((r) => r.ok).map((r) => unwrap(r).execution.id));
      assert.equal(ids.size, 1, "all concurrent retries must converge on one execution");

      // And the budget was consumed once.
      const source = unwrap(await store.funding.get(TENANT, "merchant-1"));
      assert.equal(toDecimal(source.spent), "10.00");

      await store.close?.();
    });

    test("a failed reservation leaves no budget held", async () => {
      const store = adapter.create();
      const p = await funded(TEST_MS, store);
      unwrap(
        await p.capabilities.fund({
          tenant: TENANT,
          actor: "test",
          sourceId: "small",
          label: "Small",
          party: { kind: "merchant", id: "m1" },
          unit: "USD",
          budgetDecimal: "4.00",
        }),
      );
      await publish(p, simpleDraft({ funding: { model: "single", splits: [{ sourceId: "small" }] } }));

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          p.capabilities.reserve({ context: cartContext(subject(i)), actor: "load", idempotencyKey: `f-${i}` }),
        ),
      );
      assert.equal(results.filter((r) => r.ok).length, 0, "4.00 cannot fund a 10.00 discount");

      const source = unwrap(await store.funding.get(TENANT, "small"));
      assert.equal(toDecimal(source.reserved), "0.00", "no partial hold survives a failed reservation");

      // Limits must not have been consumed either: the transaction rolled back.
      const exchanges = unwrap(await store.exchanges.find(TENANT, { state: "active" }));
      const counters = unwrap(
        await store.counters.read({ tenant: TENANT, valueExchangeId: exchanges[0]!.id }),
      );
      assert.equal(counters.redemptions, 0, "a rolled-back reservation must not consume a limit");

      await store.close?.();
    });
  });
}

/**
 * Negative control.
 *
 * A concurrency test that passes because nothing actually interleaved proves
 * nothing. This reproduces the shape the old `CounterStore.mutate(fn)` port
 * had - read, check in application code, write - with an await between the read
 * and the write, exactly as a remote store would have. It must over-admit.
 *
 * If this test ever starts passing its own limit, the harness has stopped
 * interleaving and every test above it has quietly become vacuous.
 */
describe("negative control: the interface Phase 1 removed", () => {
  test("read-check-write over-admits under the same concurrency", async () => {
    let redemptions = 0;
    const limit = 1;

    const naiveReserve = async (): Promise<boolean> => {
      const seen = redemptions; // read
      await Promise.resolve(); // any I/O boundary at all
      if (seen >= limit) return false; // check
      redemptions = seen + 1; // write
      return true;
    };

    const admitted = (await Promise.all(Array.from({ length: 25 }, () => naiveReserve()))).filter(Boolean);

    assert.ok(
      admitted.length > limit,
      `expected the naive pattern to over-admit, but it admitted ${admitted.length}`,
    );
  });

  test("the same shape with an exclusive section admits exactly the limit", async () => {
    const { Mutex } = await import("../src/adapters/mutex.ts");
    const lock = new Mutex();
    let redemptions = 0;
    const limit = 1;

    const guardedReserve = (): Promise<boolean> =>
      lock.run(async () => {
        const seen = redemptions;
        await Promise.resolve();
        if (seen >= limit) return false;
        redemptions = seen + 1;
        return true;
      });

    const admitted = (await Promise.all(Array.from({ length: 25 }, () => guardedReserve()))).filter(Boolean);
    assert.equal(admitted.length, limit);
  });
});
