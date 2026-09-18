/**
 * Bundle versioning and decision replay.
 *
 * The gap this closes: a decision is a pure function of its context *and the
 * registries loaded when it was made*. The context was recorded; the registries
 * were not. So re-running a decision from months ago could legitimately differ,
 * and nothing would say why — which is exactly the moment an investigation
 * draws the wrong conclusion from a true observation.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeBundleVersion, compareBundles } from "../src/platform/bundle.ts";
import { replayDecision } from "../src/audit/replay.ts";
import { Registry } from "../src/registry/registry.ts";
import { instant } from "../src/universal/temporal/chronology.ts";
import { TENANT, TEST_MS, cartContext, funded, publish, simpleDraft, unwrap } from "./_helpers.ts";

describe("bundle versions", () => {
  test("are deterministic and independent of registration order", () => {
    const a = new Registry<{ key: string; label: string }>("r")
      .register({ key: "b", label: "B" })
      .register({ key: "a", label: "A" });
    const b = new Registry<{ key: string; label: string }>("r")
      .register({ key: "a", label: "A" })
      .register({ key: "b", label: "B" });

    assert.equal(computeBundleVersion({ r: a }).hash, computeBundleVersion({ r: b }).hash);
  });

  test("change when an entry is added or removed", () => {
    const registry = new Registry<{ key: string; label: string }>("r").register({ key: "a", label: "A" });
    const before = computeBundleVersion({ r: registry });

    registry.register({ key: "b", label: "B" });
    const after = computeBundleVersion({ r: registry });

    assert.notEqual(before.hash, after.hash);
    assert.deepEqual(compareBundles(before, after), [{ registry: "r", before: 1, after: 2 }]);
  });

  test("do NOT change when behaviour changes behind the same key", () => {
    // This is the honest limit, and the reason the version is evidence rather
    // than proof. Functions have no stable serialisation, so editing a handler
    // without touching its key is invisible here; the deployment's own build
    // identifier is what covers it.
    const registry = new Registry<{ key: string; label: string; rate: number }>("r").register({
      key: "a",
      label: "A",
      rate: 10,
    });
    const before = computeBundleVersion({ r: registry as never });

    registry.override({ key: "a", label: "A", rate: 99 });
    assert.equal(computeBundleVersion({ r: registry as never }).hash, before.hash);
  });

  test("a registry mutation bumps its revision, so the cache notices", async () => {
    const platform = await funded();
    const first = platform.bundleVersion();
    const cached = platform.bundleVersion();
    assert.equal(first.hash, cached.hash);

    platform.deps.profiles.register({ key: "acme.new", label: "New profile" });

    const after = platform.bundleVersion();
    assert.notEqual(after.hash, first.hash, "a runtime registration must invalidate the cached version");
    assert.deepEqual(compareBundles(first, after), [
      { registry: "domain-profile", before: first.registries["domain-profile"]!, after: after.registries["domain-profile"]! },
    ]);
  });

  test("the platform reports which registries it holds and how many entries", async () => {
    const platform = await funded();
    const bundle = platform.bundleVersion();
    assert.equal(bundle.id.length, 16);
    assert.ok(bundle.entries > 200);
    assert.ok(bundle.registries["benefit-type"]! >= 8);
  });
});

describe("decisions carry their bundle", () => {
  test("every decision records the bundle that produced it", async () => {
    const platform = await funded();
    await publish(platform, simpleDraft());
    const quote = unwrap(await platform.capabilities.apply({ context: cartContext() }));

    assert.equal(quote.decision.bundle, platform.bundleVersion().id);
  });

  test("the reservation audit record carries it too", async () => {
    const platform = await funded();
    await publish(platform, simpleDraft());
    unwrap(await platform.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k" }));

    const audit = unwrap(await platform.capabilities.audit({ tenant: TENANT }));
    const reserved = audit.recent.find((record) => record.kind === "execution.reserved")!;
    assert.equal((reserved.payload as { bundle: string }).bundle, platform.bundleVersion().id);
  });
});

describe("replay", () => {
  async function decided() {
    const platform = await funded();
    const exchange = await publish(platform, simpleDraft());
    const context = cartContext();
    const quote = unwrap(await platform.capabilities.apply({ context }));
    return { platform, exchange, context, decision: quote.decision };
  }

  test("reproduces a decision exactly, under the same bundle", async () => {
    const { platform, context, decision } = await decided();

    const replay = unwrap(await replayDecision(platform, { decision, context }));

    assert.equal(replay.reproduced, true);
    assert.equal(replay.replayedHash, decision.hash);
    assert.equal(replay.bundleMatches, true);
    assert.match(replay.conclusion, /Reproduced exactly, under the same registry bundle/);
  });

  test("pins the clock to the recorded instant, not to today", async () => {
    const { platform, context, decision } = await decided();

    // A weekend-only window. Replayed against "now" it would be evaluated on
    // whatever day the replay runs, and the result would be meaningless.
    const replay = unwrap(
      await replayDecision(platform, {
        decision,
        context: { ...context, instant: undefined } as typeof context,
      }),
    );
    assert.equal(replay.replayed.at, decision.at);
    assert.equal(replay.reproduced, true);
  });

  test("reports a changed bundle without calling it a fault", async () => {
    const { platform, context, decision } = await decided();

    // Something unrelated is registered after the decision was made.
    platform.deps.profiles.register({ key: "acme.later", label: "Registered later" });

    const replay = unwrap(await replayDecision(platform, { decision, context }));

    assert.equal(replay.bundleMatches, false);
    assert.notEqual(replay.currentBundle, replay.originalBundle);
    assert.equal(replay.reproduced, true, "an unrelated registration must not change the outcome");
    assert.match(replay.conclusion, /although the registry bundle has changed/);
  });

  test("a bundle change that DOES alter the outcome is reported as expected, not as a fault", async () => {
    const { platform, context, decision } = await decided();

    // An objective is added and the offer's terms change underneath the replay.
    const exchanges = unwrap(await platform.store.exchanges.find(TENANT));
    const changed = {
      ...exchanges[0]!,
      benefits: [{ id: "d", type: "percentage", params: { rate: "50" }, effect: "price_reduction" }],
    };
    unwrap(await platform.store.exchanges.put(changed));
    platform.deps.profiles.register({ key: "acme.shifted", label: "Shifted" });

    const replay = unwrap(await replayDecision(platform, { decision, context }));

    assert.equal(replay.reproduced, false);
    assert.equal(replay.bundleMatches, false);
    assert.match(replay.conclusion, /expected rather than evidence of a fault/);
  });

  test("a mismatch under an UNCHANGED bundle is flagged for investigation", async () => {
    const { platform, context, decision } = await decided();

    // The offer changed but the registries did not, so there is no benign
    // explanation and the conclusion says so.
    const exchanges = unwrap(await platform.store.exchanges.find(TENANT));
    unwrap(
      await platform.store.exchanges.put({
        ...exchanges[0]!,
        benefits: [{ id: "d", type: "percentage", params: { rate: "40" }, effect: "price_reduction" }],
      }),
    );

    const replay = unwrap(await replayDecision(platform, { decision, context }));

    assert.equal(replay.reproduced, false);
    assert.equal(replay.bundleMatches, true);
    assert.match(replay.conclusion, /Investigate/);
  });

  test("a context that cannot be resolved is an error, not a false negative", async () => {
    const { platform, decision } = await decided();
    const result = await replayDecision(platform, {
      decision,
      context: { tenant: TENANT, place: "nowhere-at-all", unit: "USD" },
    });
    assert.equal(result.ok, false, "an unresolvable context must not be reported as 'did not reproduce'");
  });

  test("replaying a redeemed decision matches the hash in the audit chain", async () => {
    const platform = await funded();
    await publish(platform, simpleDraft());
    const context = cartContext();
    const redeemed = unwrap(
      await platform.capabilities.redeem({ context, actor: "checkout", idempotencyKey: "k" }),
    );

    const audit = unwrap(await platform.capabilities.audit({ tenant: TENANT }));
    const reserved = audit.recent.find((record) => record.kind === "execution.reserved")!;
    const recordedHash = (reserved.payload as { decisionHash: string }).decisionHash;

    const replay = unwrap(await replayDecision(platform, { decision: redeemed.decision, context }));

    assert.equal(replay.replayedHash, recordedHash, "the chain, the decision and the replay all agree");
    assert.equal(audit.verified, true);
  });
});

describe("replay determinism", () => {
  test("the same context at the same instant always gives the same hash", async () => {
    const run = async () => {
      const platform = await funded();
      await publish(platform, simpleDraft());
      const quote = unwrap(
        await platform.capabilities.apply({
          context: { ...cartContext(), instant: instant("earth.unix.ms", BigInt(TEST_MS)) },
        }),
      );
      return quote.decision.hash;
    };
    assert.equal(await run(), await run());
  });
});

describe("what a bundle difference is allowed to claim", () => {
  test("a changed bundle reports no differences rather than an empty list of them", async () => {
    const platform = await funded();
    await publish(platform, simpleDraft());
    const context = cartContext();
    const quote = unwrap(await platform.capabilities.apply({ context }));

    // Something unrelated is registered, so the bundle moves on.
    platform.registries["decision-objective"]!.register({
      key: "never-used",
      label: "Never used",
      description: "Registered only to move the bundle.",
      score: () => 0n,
    } as never);

    const replay = unwrap(await replayDecision(platform, { decision: quote.decision, context }));

    assert.equal(replay.bundleMatches, false, "the bundle did change");
    assert.equal(
      replay.bundleDifferences,
      undefined,
      "a bundle id is a hash; it cannot be un-hashed into the keys that made it. " +
        "An empty array would say 'the bundles differ and nothing differs'.",
    );
  });

  test("supplying the recorded keys names what moved", async () => {
    const platform = await funded();
    await publish(platform, simpleDraft());
    const context = cartContext();
    const quote = unwrap(await platform.capabilities.apply({ context }));

    const recordedRegistryKeys = Object.fromEntries(
      Object.entries(platform.registries).map(([name, registry]) => [name, registry.keys()]),
    );

    platform.registries["decision-objective"]!.register({
      key: "late-arrival",
      label: "Late arrival",
      description: "Registered after the decision was made.",
      score: () => 0n,
    } as never);

    const replay = unwrap(
      await replayDecision(platform, { decision: quote.decision, context, recordedRegistryKeys }),
    );

    const objective = replay.bundleDifferences?.find((d) => d.registry === "decision-objective");
    assert.ok(objective, "the decision-objective registry moved and is named");
    assert.deepEqual(objective.added, ["late-arrival"]);
    assert.equal(objective.removed, undefined);
    assert.equal(replay.reproduced, true, "an unrelated registration does not change the decision");
  });
});
