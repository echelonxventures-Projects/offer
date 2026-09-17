/**
 * Example 6 - stacking, conflict and objectives.
 *
 * Five offers compete for one basket. Two are in the same group and may not
 * both apply. One is exclusive and shuts everything else out if it wins. The
 * engine searches every compatible subset and picks by the chosen objective -
 * and the answer changes with the objective, which is the whole point of making
 * the objective a registry entry rather than a hard-coded preference.
 */
import { TENANT, demoPlatform, heading, money, must, row, section } from "./_bootstrap.ts";
import type { ValueExchangeDraft } from "../src/model/value-exchange.ts";

const platform = demoPlatform();
const caps = platform.capabilities;

heading("EXAMPLE 6 - STACKING: conflict groups, exclusivity, objectives");

must(await caps.fund({ tenant: TENANT, actor: "ops", sourceId: "merchant-acme", label: "Acme budget", party: { kind: "merchant", id: "acme" }, unit: "USD", budgetDecimal: "100000.00" }), "fund");

const base = (name: string, over: Partial<ValueExchangeDraft>): ValueExchangeDraft => ({
  profile: "promotion",
  name,
  visibility: "public",
  acquisition: { mode: "automatic" },
  benefits: [],
  funding: { model: "single", splits: [{ sourceId: "merchant-acme" }] },
  limits: {},
  stacking: { application: "sequential" },
  priority: 0,
  governance: { owner: "campaigns@demo" },
  metadata: {},
  ...over,
});

const drafts: ValueExchangeDraft[] = [
  base("A. 20% off everything", {
    benefits: [{ id: "b", type: "percentage", params: { rate: "20" }, effect: "price_reduction" }],
    stacking: { groups: ["sitewide"], application: "sequential" },
    priority: 90,
  }),
  base("B. $30 off everything", {
    benefits: [{ id: "b", type: "flat", params: { amount: "30.00" }, effect: "price_reduction" }],
    stacking: { groups: ["sitewide"], application: "sequential" },
    priority: 80,
  }),
  base("C. Free shipping", {
    benefits: [{ id: "b", type: "flat", params: { amount: "9.99" }, effect: "fee_waiver" }],
    stacking: { groups: ["shipping"], application: "sequential" },
    priority: 40,
  }),
  base("D. 2% back in points", {
    profile: "loyalty",
    benefits: [{ id: "b", type: "points_accrual", params: { points: 2, per: 1 }, effect: "points_grant", unit: "POINTS" }],
    stacking: { groups: ["loyalty"], application: "parallel" },
    priority: 30,
  }),
  base("E. 35% off, nothing else applies", {
    benefits: [{ id: "b", type: "percentage", params: { rate: "35" }, effect: "price_reduction" }],
    stacking: { exclusive: true, application: "sequential" },
    priority: 95,
  }),
];

section("the field");
for (const draft of drafts) {
  const created = must(await caps.create({ tenant: TENANT, actor: "campaigns", draft }), `create ${draft.name}`);
  must(await caps.publish({ tenant: TENANT, actor: "campaigns", valueExchangeId: created.id, approvedBy: "finance" }), "publish");
  const s = created.stacking;
  row(draft.name, s.exclusive ? "exclusive" : `group [${(s.groups ?? []).join(",")}], ${s.application}`);
}

const context = {
  tenant: TENANT,
  unit: "USD",
  place: "earth.us.ny",
  channel: "web",
  subject: { id: "subject-9", counters: { "orders.lifetime": 2 } },
  cart: {
    lines: [
      { id: "l1", sku: "JACKET", quantity: 1, unitPrice: { unit: "USD", minor: 12_000n, scale: 2 }, categories: ["apparel"], merchant: "acme" },
      { id: "l2", sku: "SOCKS", quantity: 3, unitPrice: { unit: "USD", minor: 800n, scale: 2 }, categories: ["apparel"], merchant: "acme" },
    ],
  },
};

section("default objective: maximise subject value");
const best = must(await caps.apply({ context }), "apply");
row("basket", money(best.context.cart!.subtotal));
row("chosen", best.decision.applied.map((a) => a.name).join(" + ") || "nothing");
row("payable reduction", money(best.decision.payableReduction));
row("payable", money(best.decision.remainingPayable));
for (const g of best.decision.granted) row("granted", money(g));
row("search", `${best.decision.searchMode}, ${best.decision.combinationsConsidered} compatible combination(s)`);

section("why the others lost");
for (const note of best.decision.displaced) {
  row(note.valueExchangeId, note.conflictsWith ? `${note.reason}` : note.reason);
}

section("the same basket under different objectives");
const compared = must(
  await caps.compare({
    context,
    objectives: ["max_subject_value", "max_payable_reduction", "min_cost", "max_applied"],
  }),
  "compare",
);
for (const { objective, decision } of compared) {
  row(objective, `${money(decision.payableReduction)} off via ${decision.applied.map((a) => a.name.slice(0, 2)).join("+") || "nothing"}`);
}
console.log("\n   Same inputs, four defensible answers. Which one is correct is a commercial");
console.log("   question, so the platform makes it a parameter rather than a decision.\n");

section("what the exclusive offer would have done");
const onlyE = must(
  await caps.apply({ context, candidateIds: [must(await platform.store.exchanges.find(TENANT), "find").find((x) => x.name.startsWith("E."))!.id] }),
  "apply E alone",
);
row("E alone", `${money(onlyE.decision.payableReduction)} off`);
console.log("");
