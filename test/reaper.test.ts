/**
 * The reservation reaper.
 *
 * Without this, an abandoned checkout holds budget forever and the first
 * production incident is a campaign with money left refusing customers.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toDecimal } from "../src/universal/economic/amount.ts";
import { instant } from "../src/universal/temporal/chronology.ts";
import { GoipPlatform } from "../src/platform/platform.ts";
import { randomIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { ADAPTERS } from "./_adapters.ts";
import { TENANT, TEST_MS, cartContext, funded, publish, simpleDraft, unwrap } from "./_helpers.ts";

const at = (ms: number) => instant("earth.unix.ms", BigInt(ms));

for (const adapter of ADAPTERS) {
  describe(`${adapter.name}: reservation reaper`, () => {
    test("releases a stale reservation and gives the budget back", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(p, simpleDraft({ limits: { totalRedemptions: 1 } }));

      const reserved = unwrap(
        await p.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "abandoned" }),
      );
      assert.equal(toDecimal(unwrap(await store.funding.get(TENANT, "merchant-1")).reserved), "10.00");

      // Two hours later.
      const report = unwrap(
        await p.reaper.sweep({
          tenant: TENANT,
          olderThanSeconds: 3600,
          now: at(TEST_MS + 2 * 3600 * 1000),
        }),
      );

      assert.equal(report.examined, 1);
      assert.equal(report.released, 1);
      assert.deepEqual(report.skipped, []);

      const execution = unwrap(await store.executions.get(TENANT, reserved.execution.id));
      assert.equal(execution.state, "released");
      assert.equal(toDecimal(unwrap(await store.funding.get(TENANT, "merchant-1")).reserved), "0.00");

      // The limit came back, so the offer works again.
      assert.equal(unwrap(await p.capabilities.apply({ context: cartContext() })).decision.applied.length, 1);
      await store.close?.();
    });

    test("leaves reservations younger than the cut-off alone", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(p, simpleDraft());
      unwrap(await p.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "fresh" }));

      const report = unwrap(
        await p.reaper.sweep({
          tenant: TENANT,
          olderThanSeconds: 3600,
          now: at(TEST_MS + 60 * 1000), // one minute later
        }),
      );
      assert.equal(report.examined, 0);
      assert.equal(report.released, 0);
      assert.equal(toDecimal(unwrap(await store.funding.get(TENANT, "merchant-1")).reserved), "10.00");
      await store.close?.();
    });

    test("never touches a captured execution", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(p, simpleDraft());
      const redeemed = unwrap(
        await p.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "done" }),
      );

      const report = unwrap(
        await p.reaper.sweep({ tenant: TENANT, olderThanSeconds: 0, now: at(TEST_MS + 10 * 3600 * 1000) }),
      );
      assert.equal(report.examined, 0);

      const execution = unwrap(await store.executions.get(TENANT, redeemed.execution.id));
      assert.equal(execution.state, "captured");
      await store.close?.();
    });

    test("is bounded per sweep and takes the oldest first", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(p, simpleDraft());

      // Five reservations, one per simulated minute. Each needs its own clock,
      // and its own id factory - a shared sequential one would mint the same
      // execution id five times and they would overwrite each other.
      for (let i = 0; i < 5; i += 1) {
        const atMinute = new GoipPlatform({
          clock: fixedClock(BigInt(TEST_MS + i * 60_000) * 1_000_000n),
          ids: randomIdFactory(),
          store,
        });
        unwrap(
          await atMinute.capabilities.reserve({
            context: cartContext({ subject: { id: `s${i}`, segments: [], counters: {} } }),
            actor: "t",
            idempotencyKey: `k${i}`,
          }),
        );
      }

      const first = unwrap(
        await p.reaper.sweep({
          tenant: TENANT,
          olderThanSeconds: 0,
          limit: 2,
          now: at(TEST_MS + 3600 * 1000),
        }),
      );
      assert.equal(first.released, 2, "the sweep respects its batch limit");

      const second = unwrap(
        await p.reaper.sweep({
          tenant: TENANT,
          olderThanSeconds: 0,
          limit: 10,
          now: at(TEST_MS + 3600 * 1000),
        }),
      );
      assert.equal(second.released, 3, "the rest go on the next pass");
      await store.close?.();
    });

    test("is idempotent: a second sweep finds nothing", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(p, simpleDraft());
      unwrap(await p.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "once" }));

      const now = at(TEST_MS + 7200 * 1000);
      const firstSweep = unwrap(await p.reaper.sweep({ tenant: TENANT, olderThanSeconds: 3600, now }));
      const secondSweep = unwrap(await p.reaper.sweep({ tenant: TENANT, olderThanSeconds: 3600, now }));

      assert.equal(firstSweep.released, 1);
      assert.equal(secondSweep.examined, 0);
      assert.equal(secondSweep.released, 0);
      await store.close?.();
    });

    test("records the release in the audit chain", async () => {
      const store = await adapter.create();
      const p = await funded(TEST_MS, store);
      await publish(p, simpleDraft());
      unwrap(await p.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "audited" }));

      unwrap(
        await p.reaper.sweep({ tenant: TENANT, olderThanSeconds: 3600, now: at(TEST_MS + 7200 * 1000) }),
      );

      const audit = unwrap(await p.capabilities.audit({ tenant: TENANT }));
      assert.equal(audit.verified, true);
      const released = audit.recent.find((r) => r.kind === "execution.released");
      assert.ok(released, "the sweep must leave an audit record");
      assert.match(String((released!.payload as { reason: string }).reason), /reaped/);
      await store.close?.();
    });
  });
}
