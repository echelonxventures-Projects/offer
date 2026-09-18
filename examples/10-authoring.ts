/**
 * Example 10 - authoring safely.
 *
 * The worst production failure this platform can have is not a crash. It is an
 * offer that was published with a condition that cannot be evaluated, which
 * means it silently applies to nobody — and nobody finds out until somebody
 * asks why the campaign did nothing.
 *
 * This walks the authoring loop that prevents it.
 */
import { GoipPlatform } from "../src/platform/platform.ts";
import { explainOffer, explainPreview, renderExplanation } from "../src/authoring/explain.ts";
import { largestBenefit } from "../src/authoring/preview.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { DEMO_INSTANT_MS, TENANT, heading, money, must, row, section } from "./_bootstrap.ts";
import { simpleOffer } from "./_fixtures.ts";
import type { ValueExchangeDraft } from "../src/model/value-exchange.ts";

const platform = new GoipPlatform({
  clock: fixedClock(BigInt(DEMO_INSTANT_MS) * 1_000_000n),
  ids: sequentialIdFactory(),
});
const caps = platform.capabilities;

heading("EXAMPLE 10 - AUTHORING: catching the failure that is otherwise silent");

must(
  await caps.fund({
    tenant: TENANT, actor: "ops", sourceId: "merchant-acme", label: "Acme budget",
    party: { kind: "merchant", id: "acme" }, unit: "USD", budgetDecimal: "50000.00",
  }),
  "fund",
);

/* ---------------------------------------------------------------- */
section("1. an author writes an offer, and gets it subtly wrong");

// The intent: 15% off for customers who have ordered before. The mistake:
// comparing the customer's id - a string - against a number.
const broken: ValueExchangeDraft = {
  ...simpleOffer("Returning customer 15%"),
  name: "Returning customer 15%",
  benefits: [{ id: "d", type: "percentage", params: { rate: "15" }, effect: "price_reduction" }],
  conditions: { op: "gte", left: { path: "subject.id" }, right: { literal: 1 } },
};

const firstCheck = must(await caps.validate({ tenant: TENANT, draft: broken }), "validate");
row("policy", firstCheck.report.passed ? "passes" : "fails");
row("preview", firstCheck.preview!.passed ? "passes" : "FAILS");
console.log();
console.log(renderExplanation(explainPreview(firstCheck.preview!), "     "));
console.log("\n   Policy passed. It is funded, owned, bounded and uses registered types.");
console.log("   Only preview catches this, because only preview runs the condition.");

section("2. publishing it anyway is refused");
const created = must(await caps.create({ tenant: TENANT, actor: "author", draft: broken }), "create");
const refused = await caps.publish({
  tenant: TENANT, actor: "author", valueExchangeId: created.id, approvedBy: "approver",
});
row("publish", refused.ok ? "allowed (wrong)" : `refused: ${refused.error.code}`);

/* ---------------------------------------------------------------- */
section("3. the author fixes it");

// `orders.lifetime` is a counter - a number - so the comparison is sound.
const fixed: ValueExchangeDraft = {
  ...broken,
  conditions: {
    op: "gte",
    left: { fn: "subject.counter", args: [{ literal: "orders.lifetime" }] },
    right: { literal: 1 },
  },
};

const secondCheck = must(await caps.validate({ tenant: TENANT, draft: fixed }), "validate");
row("preview", secondCheck.preview!.passed ? "passes" : "fails");
row("coverage", `${secondCheck.preview!.appliesTo} of ${secondCheck.preview!.samplesRun} sample contexts`);
for (const outcome of secondCheck.preview!.outcomes) {
  row(`  ${outcome.applies ? "✓" : "✗"} ${outcome.sample}`, outcome.applies ? money(outcome.value!) : String(outcome.reason));
}

section("and preview has something to say about the shape of it");
for (const finding of secondCheck.preview!.findings) {
  row(`  [${finding.severity}]`, finding.message);
}
const worst = largestBenefit(secondCheck.preview!);
row("largest benefit seen", worst ? money(worst) : "none");
console.log("   The findings above are informational: not qualifying for an anonymous");
console.log("   visitor is expected for a targeted offer. What is worth noticing is the");
console.log("   750.00 against the high-value sample - 15% of a large basket, uncapped.");

/* ---------------------------------------------------------------- */
section("4. published, once it evaluates");

const sound = must(await caps.create({ tenant: TENANT, actor: "author", draft: fixed }), "create");
const published = must(
  await caps.publish({ tenant: TENANT, actor: "author", valueExchangeId: sound.id, approvedBy: "approver" }),
  "publish",
);
row("state", published.state);

/* ---------------------------------------------------------------- */
section("5. a revision, and what an approver needs to see");

const revised: ValueExchangeDraft = {
  ...fixed,
  benefits: [{ id: "d", type: "percentage", params: { rate: "25" }, effect: "price_reduction" }],
  limits: { totalRedemptions: 100_000 },
};

const diff = must(
  await caps.compareVersions({ tenant: TENANT, valueExchangeId: published.id, draft: revised }),
  "diff",
);
row("summary", diff.summary);
for (const change of diff.changes) {
  row(`  ${change.path}`, `${change.exposure} — ${change.note}`);
}
console.log("   A textual diff shows two small edits of similar size. This shows that");
console.log("   one raises what the campaign can cost and the other caps it, and that");
console.log("   the net needs review - which is the only question an approver has.");

/* ---------------------------------------------------------------- */
section("6. and when a customer asks why they did not get it");

const newCustomer = {
  tenant: TENANT,
  unit: "USD",
  channel: "web",
  subject: { id: "first-timer", counters: { "orders.lifetime": 0 } },
  cart: {
    lines: [{ id: "l1", sku: "WIDGET", quantity: 1, unitPrice: { unit: "USD", minor: 10_000n, scale: 2 }, categories: ["tools"], merchant: "acme" }],
  },
};

const quote = must(await caps.apply({ context: newCustomer }), "apply");
const rejected = quote.decision.rejected[0];
if (rejected) {
  console.log(renderExplanation(explainOffer(quote.decision, rejected.valueExchangeId), "     "));
}
console.log("\n   No log needed. The decision already carries the check that failed and");
console.log("   the predicate that decided it; this only renders them.\n");
