/**
 * Example 4 - affiliate commission, attribution and payout.
 *
 * A commission is not a discount: the buyer gets nothing, a third party is
 * owed. It therefore applies in parallel (it must not compete with the customer's
 * offers) and it credits a payable rather than reducing the price.
 *
 * This example also walks the full money path to the end: commission -> payable
 * balance -> payout off the platform.
 */
import { TENANT, demoPlatform, heading, money, must, row, section } from "./_bootstrap.ts";
import { affiliateCommission } from "../src/profiles/builders.ts";

const platform = demoPlatform();
const caps = platform.capabilities;

heading("EXAMPLE 4 - AFFILIATE: attribution, commission, payout");

must(await caps.fund({ tenant: TENANT, actor: "ops", sourceId: "marketplace-budget", label: "Marketplace affiliate budget", party: { kind: "marketplace", id: "bazaar" }, unit: "INR", budgetDecimal: "250000.00" }), "fund");

const draft = affiliateCommission({
  name: "Standard affiliate 8%",
  description: "8% of order value to the attributed partner.",
  percent: "8",
  attributionModel: "position_based",
  lookbackDays: 30,
  owner: "partnerships@demo",
  funding: { model: "single", splits: [{ sourceId: "marketplace-budget" }] },
});
const commission = must(await caps.create({ tenant: TENANT, actor: "partnerships", draft }), "create");
must(await caps.publish({ tenant: TENANT, actor: "partnerships", valueExchangeId: commission.id, approvedBy: "finance" }), "publish");
row("visibility", commission.visibility);
row("effect", commission.benefits[0]!.effect);

section("the customer journey");
const touches: { party: { kind: string; id: string }; kind: "view" | "click" | "assist"; label: string }[] = [
  { party: { kind: "creator", id: "creator-nina" }, kind: "view", label: "saw a review video" },
  { party: { kind: "affiliate", id: "affiliate-dealsite" }, kind: "click", label: "clicked a deals-site link" },
  { party: { kind: "partner", id: "partner-cashbackapp" }, kind: "assist", label: "opened via a cashback app" },
];
for (const t of touches) {
  const recorded = must(
    await caps.track({ tenant: TENANT, kind: t.kind, party: t.party, subjectId: "subject-7", valueExchangeId: commission.id, channel: "web" }),
    "track",
  );
  row(`${t.party.kind}:${t.party.id}`, `${recorded.kind} - ${t.label}`);
}

section("redeem: the order lands");
const context = {
  tenant: TENANT,
  unit: "INR",
  place: "earth.in.mh.mumbai",
  channel: "web",
  subject: { id: "subject-7", counters: { "orders.lifetime": 4 } },
  cart: {
    lines: [
      { id: "l1", sku: "HEADPHONES-PRO", quantity: 1, unitPrice: { unit: "INR", minor: 1_250_000n, scale: 2 }, categories: ["electronics"], merchant: "bazaar" },
    ],
  },
};

const redeemed = must(
  await caps.redeem({
    context,
    actor: "checkout",
    idempotencyKey: "order-4001",
    // The commission is owed to the attributed party, not to the buyer.
    payee: { kind: "affiliate", id: "affiliate-dealsite" },
  }),
  "redeem",
);
row("order value", money(redeemed.context.cart!.subtotal));
row("customer pays", money(redeemed.decision.remainingPayable));
row("commission accrued", redeemed.decision.granted.map(money).join(", ") || "-");
for (const entry of redeemed.entries) row(entry.direction, `${entry.accountId} ${money(entry.amount)}`);

section("who gets the credit");
for (const model of ["last_touch", "first_touch", "linear", "position_based", "time_decay"]) {
  const attributed = must(
    await caps.attribute({
      tenant: TENANT,
      subjectId: "subject-7",
      valueExchangeId: commission.id,
      model,
      value: { unit: "INR", decimal: "1000.00" },
    }),
    `attribute ${model}`,
  );
  const summary = attributed.shares
    .map((s) => `${s.party.id.replace(/^(affiliate|creator|partner)-/, "")} ${(s.basisPoints / 100).toFixed(1)}%`)
    .join("  ");
  row(model, summary);
}
const linear = must(
  await caps.attribute({ tenant: TENANT, subjectId: "subject-7", valueExchangeId: commission.id, model: "linear", value: { unit: "INR", decimal: "1000.00" } }),
  "attribute linear",
);
row("linear, in basis points", linear.shares.map((s) => s.basisPoints).join(" + ") + " = " + linear.shares.reduce((t, s) => t + s.basisPoints, 0));
row("linear, in money", linear.shares.map((s) => money(s.amount!)).join(" + "));
console.log("   The percentages above are rounded for display; the basis points and the");
console.log("   money are exact and always sum to the whole. That is the allocator's job.");

section("pay the affiliate");
const payable = `pay:affiliate:affiliate-dealsite:INR`;
const before = must(await caps.settle({ tenant: TENANT }), "settle");
row("owed", before.positions.filter((p) => p.accountId === payable).map((p) => `${-p.netMinor} minor INR`).join("") || "0");

const paid = must(
  await caps.pay({
    tenant: TENANT,
    fromAccountId: payable,
    destination: { kind: "bank_transfer", reference: "HDFC****4471" },
    unit: "INR",
    decimal: "1000.00",
    memo: "September affiliate settlement",
  }),
  "pay",
);
row("payout", paid.payoutId);
for (const entry of paid.entries) row(entry.direction, `${entry.accountId} ${money(entry.amount)}`);

const after = must(await caps.settle({ tenant: TENANT }), "settle after");
row("ledger still balanced", String(after.balanced));

section("paying in a unit that cannot be paid");
const refused = await caps.pay({
  tenant: TENANT,
  fromAccountId: "liab:points:subject-7:POINTS",
  destination: { kind: "bank_transfer", reference: "HDFC****4471" },
  unit: "POINTS",
  decimal: "500",
});
row("refused", refused.ok ? "no (wrong!)" : refused.error.message);
console.log("");
