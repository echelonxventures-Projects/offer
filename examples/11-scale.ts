/**
 * Example 11 - scale, and the two defects that were hiding inside it.
 *
 * Phase 5 was supposed to be about volume. The audit that opened it found that
 * the two things carrying the most risk were not really about volume at all.
 *
 *  1. Reconciliation folded the entire ledger from genesis, every time - and
 *     the health check does that every minute, so the check designed to catch
 *     problems was on its way to becoming one.
 *  2. A decision recorded the context it was made from, but not the registries
 *     it was made under. So a replay could legitimately differ with nothing
 *     saying why, which is exactly when an investigation goes wrong.
 *
 * This shows both, with the numbers printed rather than asserted in prose.
 */
import { GoipPlatform } from "../src/platform/platform.ts";
import { replayDecision } from "../src/audit/replay.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { instant } from "../src/universal/temporal/chronology.ts";
import { DEMO_INSTANT_MS, TENANT, heading, money, must, row, section } from "./_bootstrap.ts";
import { simpleOffer } from "./_fixtures.ts";

const platform = new GoipPlatform({
  clock: fixedClock(BigInt(DEMO_INSTANT_MS) * 1_000_000n),
  ids: sequentialIdFactory(),
});
const caps = platform.capabilities;

heading("EXAMPLE 11 - SCALE: bounded reconciliation, and replaying a dispute");

must(
  await caps.fund({
    tenant: TENANT, actor: "ops", sourceId: "merchant-acme", label: "Acme budget",
    party: { kind: "merchant", id: "acme" }, unit: "USD", budgetDecimal: "50000.00",
  }),
  "fund",
);

const offer = must(
  await caps.create({ tenant: TENANT, actor: "ops", draft: simpleOffer("Everyday 10% off") }),
  "create",
);
must(
  await caps.publish({ tenant: TENANT, actor: "ops", valueExchangeId: offer.id, approvedBy: "finance" }),
  "publish",
);

const basket = (subject: string) => ({
  tenant: TENANT,
  unit: "USD",
  channel: "web",
  subject: { id: subject },
  cart: {
    lines: [{
      id: "l1", sku: "WIDGET", quantity: 1,
      unitPrice: { unit: "USD", minor: 10_000n, scale: 2 },
      categories: ["tools"], merchant: "acme",
    }],
  },
});

/* ---------------------------------------------------------------- */
section("1. a day of traffic, reconciled the expensive way");

for (let i = 0; i < 40; i += 1) {
  must(
    await caps.redeem({
      context: basket(`shopper-${i}`), actor: "checkout",
      idempotencyKey: `order-${i}`, candidateIds: [offer.id],
    }),
    `redeem ${i}`,
  );
}

const cold = must(await caps.settle({ tenant: TENANT }), "settle cold");
row("ledger entries folded", String(cold.foldedEntries));
row("balanced", String(cold.balanced));
row("current through entry", String(cold.throughSeq));

console.log(`
   With no snapshot, this folds every entry ever written. The ledger only
   grows, so this reading gets slower every day and never faster.`);

/* ---------------------------------------------------------------- */
section("2. the maintenance job records a snapshot");

const snapshot = must(
  await platform.reconciliation.snapshot(TENANT, instant("earth.unix.ms", BigInt(DEMO_INSTANT_MS))),
  "snapshot",
);
row("positions recorded", String(snapshot.positions.length));
row("trusted through entry", String(snapshot.throughSeq));

const warm = must(await caps.settle({ tenant: TENANT }), "settle warm");
row("ledger entries folded now", String(warm.foldedEntries));
row("same answer", String(warm.balanced === cold.balanced && warm.throughSeq === cold.throughSeq));

console.log(`
   Zero. The same answer, derived from the same entries, without reading them.
   A snapshot is never authoritative - delete every one and the balances are
   identical, because they are recomputed. What it must never do is record an
   imbalance, because later folds start after it and would inherit the hole
   forever. snapshot() verifies first and refuses.`);

/* ---------------------------------------------------------------- */
section("3. more traffic, and the fold stays bounded");

for (let i = 100; i < 110; i += 1) {
  must(
    await caps.redeem({
      context: basket(`shopper-${i}`), actor: "checkout",
      idempotencyKey: `order-${i}`, candidateIds: [offer.id],
    }),
    `redeem ${i}`,
  );
}

const incremental = must(await caps.settle({ tenant: TENANT }), "settle incremental");
row("entries folded", `${incremental.foldedEntries} (only what arrived since the snapshot)`);
row("balanced", String(incremental.balanced));

for (const position of incremental.positions) {
  row(position.accountId, `${position.netMinor} ${position.unit} (${position.entries} entries)`);
}

console.log(`
   foldedEntries is reported rather than inferred. If it climbs, the snapshot
   job is not keeping up - and the fix is intervalSeconds on ledger.snapshot,
   which is configuration, not a redesign.`);

/* ---------------------------------------------------------------- */
section("4. a customer disputes what they were charged");

const disputedContext = basket("shopper-disputed");
const disputed = must(
  await caps.redeem({
    context: disputedContext, actor: "checkout",
    idempotencyKey: "order-disputed", candidateIds: [offer.id],
  }),
  "disputed order",
);

row("decision", disputed.decision.id);
row("saving applied", money(disputed.decision.payableReduction));
row("rules bundle", disputed.decision.bundle);

const first = must(
  await replayDecision(platform, { decision: disputed.decision, context: disputedContext }),
  "replay",
);
row("reproduced", String(first.reproduced));
row("conclusion", first.conclusion);

/* ---------------------------------------------------------------- */
section("5. six months later, the registries have moved on");

// Capture what the deployment would have stored in a bundle manifest.
const recordedRegistryKeys = Object.fromEntries(
  Object.entries(platform.registries).map(([name, registry]) => [name, registry.keys()]),
);

platform.registries["decision-objective"]!.register({
  key: "max_margin",
  label: "Maximise margin",
  description: "A new objective, added long after the disputed order.",
  score: () => 0n,
} as never);

const later = must(
  await replayDecision(platform, {
    decision: disputed.decision,
    context: disputedContext,
    recordedRegistryKeys,
  }),
  "replay later",
);

row("reproduced", String(later.reproduced));
row("same bundle", String(later.bundleMatches));
row("conclusion", later.conclusion);
for (const difference of later.bundleDifferences ?? []) {
  row(`  ${difference.registry}`, `+${(difference.added ?? []).join(", ")}`);
}

console.log(`
   Two separate facts, kept separate: the decision still reproduces byte for
   byte, AND the rules changed in a way that did not affect it. That is why
   'bundle' is recorded but not hashed. When it was inside the hashed body,
   every decision failed to reproduce whenever any registry changed - even a
   registration with nothing to do with it - collapsing two genuinely different
   questions into one.

   Only one of the four conclusions is a fault: did not reproduce, same bundle.
   The platform says which one it is rather than returning a boolean and
   leaving the investigator to guess.`);

/* ---------------------------------------------------------------- */
section("what this example does not show");

console.log(`
   Sharded counters, edge decisioning, read replicas, ledger partitioning and
   multi-region are all still unbuilt. They are capacity work, not defects, and
   the roadmap lists them as not done rather than claiming them.

   The honest summary: reading the ledger is now bounded. Storing it is not.`);
