/**
 * Example 3 - a government fuel subsidy.
 *
 * Same record, same engines, nothing about it is "coupon-shaped":
 *   - issued to named subjects rather than acquired by code
 *   - scoped by jurisdiction rather than by store
 *   - funded by two parties in a waterfall: the state pays first, up to its
 *     per-transaction cap, and the retailer absorbs the rest
 *   - capped at two claims per subject per rolling 30 days
 */
import { TENANT, demoPlatform, heading, money, must, row, section } from "./_bootstrap.ts";
import { governmentBenefit } from "../src/profiles/builders.ts";

const platform = demoPlatform();
const caps = platform.capabilities;

heading("EXAMPLE 3 - GOVERNMENT SUBSIDY: multi-party waterfall funding");

section("fund");
must(await caps.fund({ tenant: TENANT, actor: "ops", sourceId: "state-bihar", label: "Bihar fuel subsidy scheme", party: { kind: "government", id: "in-br" }, unit: "INR", budgetDecimal: "1000000.00" }), "fund state");
must(await caps.fund({ tenant: TENANT, actor: "ops", sourceId: "retailer-fuel", label: "Retailer contribution", party: { kind: "merchant", id: "fuelco" }, unit: "INR", budgetDecimal: "500000.00" }), "fund retailer");

section("create");
const draft = governmentBenefit({
  name: "Bihar cooking fuel subsidy",
  description: "30% off domestic cooking fuel for enrolled households in Bihar.",
  percentOff: "30",
  jurisdictions: ["IN-BR"],
  perSubjectPerMonth: 2,
  owner: "welfare.dept@bihar.gov.in",
  funding: {
    // Waterfall: the state absorbs up to 150.00 per transaction, the retailer
    // covers whatever the subsidy costs beyond that.
    model: "waterfall",
    splits: [
      { sourceId: "state-bihar", cap: { decimal: "150.00" } },
      { sourceId: "retailer-fuel" },
    ],
  },
  limits: { totalBudget: { unit: "INR", decimal: "1000000.00" } },
  metadata: { scheme: "BR-LPG-2026", legalBasis: "Bihar Gazette 2026/114" },
});

const subsidy = must(await caps.create({ tenant: TENANT, actor: "welfare.dept", draft }), "create");
must(await caps.publish({ tenant: TENANT, actor: "welfare.dept", valueExchangeId: subsidy.id, approvedBy: "finance.dept" }), "publish");
row("id", subsidy.id);
row("acquisition", subsidy.acquisition.mode);
row("visibility", subsidy.visibility);

section("issue to an enrolled household");
const grant = must(
  await caps.issue({ tenant: TENANT, actor: "enrolment-desk", valueExchangeId: subsidy.id, subjectId: "household-4471", maxUses: 24 }),
  "issue",
);
row("grant", `${grant.id} (${grant.state}), ${grant.uses}/${grant.maxUses} used`);

const basket = (lines: number) => ({
  tenant: TENANT,
  unit: "INR",
  place: "earth.in.br.patna",
  channel: "pos",
  subject: { id: "household-4471", attributes: { jurisdiction: "IN-BR" } },
  cart: {
    lines: [
      { id: "l1", sku: "LPG-14KG", quantity: lines, unitPrice: { unit: "INR", minor: 90_000n, scale: 2 }, categories: ["fuel"], merchant: "fuelco" },
    ],
  },
});

section("claim 1");
const first = must(await caps.redeem({ context: basket(1), actor: "pos", idempotencyKey: "claim-1" }), "claim 1");
row("basket", money(first.context.cart!.subtotal));
row("subsidy", money(first.decision.payableReduction));
row("household pays", money(first.decision.remainingPayable));
for (const benefit of first.execution.benefits) {
  for (const f of benefit.funding) {
    row(`  funded by ${f.party.kind}:${f.party.id}`, `${money(f.amount)}${f.limitedBy ? ` (limited by ${f.limitedBy})` : ""}`);
  }
}
console.log("   The subsidy is 270.00. The state's per-transaction cap is 150.00, so the");
console.log("   retailer absorbs the remaining 120.00 - exactly as the scheme intends.");

section("claim 2 (still within the monthly limit)");
const second = must(await caps.redeem({ context: basket(2), actor: "pos", idempotencyKey: "claim-2" }), "claim 2");
row("subsidy", money(second.decision.payableReduction));

section("claim 3 (over the limit of 2 per 30 days)");
const third = must(await caps.apply({ context: basket(1) }), "claim 3 quote");
row("subsidy", money(third.decision.payableReduction));
row("refused because", third.decision.rejected[0]?.reason ?? "-");

section("a household in the wrong jurisdiction");
const elsewhere = must(
  await caps.apply({
    context: {
      ...basket(1),
      place: "earth.in.mh.mumbai",
      subject: { id: "household-9999", attributes: { jurisdiction: "IN-MH" } },
    },
  }),
  "wrong jurisdiction",
);
row("subsidy", money(elsewhere.decision.payableReduction));
row("refused because", elsewhere.decision.rejected[0]?.reason ?? "-");

section("scheme spend to date");
const forecast = must(await caps.forecast({ tenant: TENANT }), "forecast");
for (const f of forecast) {
  row(f.sourceId, `committed ${money(f.committed)}, ${f.utilisationPercent ?? "-"}% of budget used`);
}
console.log("");
