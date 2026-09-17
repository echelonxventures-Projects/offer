/**
 * Example 2 - cashback stacking with a discount.
 *
 * The point of this example is the `application` flag. The discount applies
 * sequentially and shrinks the base. The cashback applies in parallel and does
 * not, because a customer promised "5% back" does not expect it computed on a
 * price they never saw. Same engine, same record shape, one field different.
 */
import { TENANT, demoPlatform, heading, money, must, row, section } from "./_bootstrap.ts";
import { cashback, promotionDraft } from "./_fixtures.ts";

const platform = demoPlatform();
const caps = platform.capabilities;

heading("EXAMPLE 2 - CASHBACK: sequential vs parallel stacking");

must(await caps.fund({ tenant: TENANT, actor: "ops", sourceId: "merchant-acme", label: "Acme budget", party: { kind: "merchant", id: "acme" }, unit: "INR", budgetDecimal: "100000.00" }), "fund merchant");
must(await caps.fund({ tenant: TENANT, actor: "ops", sourceId: "bank-northern", label: "Northern Bank card offer", party: { kind: "bank", id: "northern" }, unit: "INR", budgetDecimal: "100000.00" }), "fund bank");

const promo = must(await caps.create({ tenant: TENANT, actor: "campaigns", draft: promotionDraft() }), "create promo");
must(await caps.publish({ tenant: TENANT, actor: "campaigns", valueExchangeId: promo.id, approvedBy: "finance" }), "publish promo");

const cash = must(await caps.create({ tenant: TENANT, actor: "campaigns", draft: cashback() }), "create cashback");
must(await caps.publish({ tenant: TENANT, actor: "campaigns", valueExchangeId: cash.id, approvedBy: "finance" }), "publish cashback");

const context = {
  tenant: TENANT,
  unit: "INR",
  place: "earth.in.mh.mumbai",
  channel: "web",
  subject: { id: "subject-2", segments: ["card-holder"], counters: { "orders.lifetime": 12 } },
  cart: {
    lines: [
      { id: "l1", sku: "PHONE-X", quantity: 1, unitPrice: { unit: "INR", minor: 4_000_000n, scale: 2 }, categories: ["electronics"], merchant: "acme" },
    ],
  },
};

const quote = must(await caps.apply({ context }), "apply");

section("result");
row("basket", money(quote.context.cart!.subtotal));
row("payable reduction", money(quote.decision.payableReduction));
row("payable now", money(quote.decision.remainingPayable));
for (const granted of quote.decision.granted) row("granted (deferred)", money(granted));

section("application order and base");
for (const applied of quote.decision.applied) {
  row(`${applied.order}. ${applied.name}`, `computed on ${money(applied.appliedTo)}`);
  for (const c of applied.resolution.computations) {
    row(`   ${c.effect}`, `${c.detail} -> ${money(c.value)}`);
  }
}

section("the point");
console.log("   The 10% discount computed on 40000.00 -> 4000.00, leaving 36000.00.");
console.log("   The 5% cashback still computed on 40000.00 -> 2000.00, not on 36000.00,");
console.log("   because its stacking.application is 'parallel'. Had it been sequential");
console.log("   the customer would have received 1800.00 and nobody could explain why.");

section("redeem and read the liability");
const redeemed = must(await caps.redeem({ context, actor: "checkout", idempotencyKey: "order-2001" }), "redeem");
for (const entry of redeemed.entries) {
  row(entry.direction, `${entry.accountId} ${money(entry.amount)}`);
}

const settled = must(await caps.settle({ tenant: TENANT }), "settle");
row("ledger balanced", String(settled.balanced));
section("positions");
for (const p of settled.positions) row(p.accountId, `${p.netMinor} minor ${p.unit}`);
console.log("\n   The negative balance on liab:wallet:subject-2:INR is what the platform");
console.log("   now owes the customer. It matures in 30 days and is payable from there.\n");
