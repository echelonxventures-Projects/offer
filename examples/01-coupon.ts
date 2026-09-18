/**
 * Example 1 - a coupon, end to end.
 *
 * Author it, publish it through governance, quote it against a basket, redeem
 * it, and read the ledger and the audit chain afterwards. This is the shortest
 * complete path through the platform.
 */
import { DEMO_INSTANT_MS, TENANT, demoPlatform, heading, money, must, row, section } from "./_bootstrap.ts";
import { coupon } from "../src/profiles/builders.ts";
import { all, gte, money as moneyTerm, path, withinPlace } from "../src/rules/ast.ts";
import { instant } from "../src/universal/temporal/chronology.ts";

const platform = demoPlatform();
const caps = platform.capabilities;

heading("EXAMPLE 1 - COUPON: author, publish, quote, redeem, settle");

/* 1. A merchant puts money behind the offer. Nothing can be authored without
      a funder, because the governance engine will refuse to publish it. */
section("fund");
const fund = must(
  await caps.fund({
    tenant: TENANT,
    actor: "ops@demo",
    sourceId: "merchant-acme",
    label: "Acme promotional budget",
    party: { kind: "merchant", id: "acme" },
    unit: "INR",
    budgetDecimal: "50000.00",
  }),
  "fund",
);
row("source", `${fund.label} (${fund.id})`);
row("budget", money(fund.budget!));

/* 2. Author the coupon. Note this is a profile builder returning a draft; the
      platform stores the same ValueExchange record it stores for everything. */
section("create");
const draft = coupon({
  name: "Weekend 15% off groceries",
  description: "15% off, capped, in-store in India, weekends only.",
  code: "WEEKEND15",
  percentOff: "15",
  cap: "200.00",
  perSubject: 2,
  owner: "campaigns@demo",
  funding: { model: "single", splits: [{ sourceId: "merchant-acme" }] },
  spatial: { include: ["earth.in"] },
  channels: ["pos", "web"],
  limits: { minimumBase: { unit: "INR", decimal: "500.00" }, totalRedemptions: 1000 },
  window: {
    from: instant("earth.unix.ms", BigInt(Date.UTC(2026, 0, 1))),
    to: instant("earth.unix.ms", BigInt(Date.UTC(2027, 0, 1))),
    calendar: "gregorian",
    constraints: [{ field: "dayOfWeek", in: [6, 7] }],
  },
  conditions: all(
    gte(path("cart.subtotal"), moneyTerm("INR", "500.00")),
    withinPlace(["earth.in"]),
  ),
});

const exchange = must(await caps.create({ tenant: TENANT, actor: "campaigns@demo", draft }), "create");
row("id", exchange.id);
row("profile", exchange.profile);
row("state", exchange.state);

/* 3. Governance reviews it before it can go live. */
section("govern");
const { report: review } = must(await caps.validate({ tenant: TENANT, valueExchangeId: exchange.id }), "validate");
row("policies run", String(review.policiesRun));
row("passed", String(review.passed));
for (const v of review.violations) row(`  ${v.severity}`, `${v.policy}: ${v.message}`);

const published = must(
  await caps.publish({ tenant: TENANT, actor: "campaigns@demo", valueExchangeId: exchange.id, approvedBy: "finance@demo" }),
  "publish",
);
row("state", published.state);

/* 4. Quote it against a real basket. Nothing is committed. */
section("apply (quote)");
const context = {
  tenant: TENANT,
  unit: "INR",
  place: "earth.in.br.patna.store-01",
  channel: "pos",
  correlationId: "demo-corr-1",
  subject: { id: "subject-1", segments: ["new-customer"], counters: { "orders.lifetime": 3 } },
  cart: {
    lines: [
      { id: "l1", sku: "TEA-500", quantity: 2, unitPrice: { unit: "INR", minor: 24_900n, scale: 2 }, categories: ["grocery"], merchant: "acme" },
      { id: "l2", sku: "RICE-5KG", quantity: 1, unitPrice: { unit: "INR", minor: 59_900n, scale: 2 }, categories: ["grocery"], merchant: "acme" },
    ],
  },
};

const quote = must(await caps.apply({ context, codes: ["WEEKEND15"] }), "apply");
row("basket", money(quote.context.cart!.subtotal));
row("discount", money(quote.decision.payableReduction));
row("payable", money(quote.decision.remainingPayable));
row("applied", quote.decision.applied.map((a) => a.name).join(", ") || "nothing");
row("search", `${quote.decision.searchMode}, ${quote.decision.combinationsConsidered} combination(s)`);

section("why: the eligibility trace");
for (const applied of quote.decision.applied) {
  for (const c of applied.resolution.computations) row(c.benefitId, `${c.detail} -> ${money(c.value)}`);
}

/* 5. Quote again without the code. It should not apply. */
section("apply without the code");
const noCode = must(await caps.apply({ context }), "apply without code");
row("discount", money(noCode.decision.payableReduction));
row("rejected because", noCode.decision.rejected[0]?.reason ?? "-");

/* 6. Redeem: reserve and capture in one step. */
section("redeem");
const redeemed = must(
  await caps.redeem({ context, codes: ["WEEKEND15"], actor: "pos-terminal-7", idempotencyKey: "order-1001" }),
  "redeem",
);
row("execution", `${redeemed.execution.id} (${redeemed.execution.state})`);
row("ledger entries", String(redeemed.entries.length));
for (const entry of redeemed.entries) {
  row(`  ${entry.direction}`, `${entry.accountId} ${money(entry.amount)} - ${entry.memo}`);
}

section("idempotency");
const again = must(
  await caps.redeem({ context, codes: ["WEEKEND15"], actor: "pos-terminal-7", idempotencyKey: "order-1001" }),
  "redeem again",
);
row("same execution id", String(again.execution.id === redeemed.execution.id));

/* 7. Where did the money come from, and do the books balance? */
section("settle");
const settled = must(await caps.settle({ tenant: TENANT }), "settle");
row("ledger balanced", String(settled.balanced));
for (const p of settled.positions) row(p.accountId, `${p.netMinor} minor ${p.unit} (${p.entries} entries)`);

const budgetAfter = must(await platform.store.funding.get(TENANT, "merchant-acme"), "read funding");
row("budget spent", money(budgetAfter.spent));
row("budget left", money({ ...budgetAfter.budget!, minor: budgetAfter.budget!.minor - budgetAfter.spent.minor }));

/* 8. The audit chain. */
section("audit");
const audit = must(await caps.audit({ tenant: TENANT }), "audit");
row("records", String(audit.records));
row("chain verified", String(audit.verified));
row("head", audit.head.slice(0, 32) + "...");
for (const record of audit.recent) row(`  #${record.seq}`, `${record.kind} by ${record.actor}`);

console.log(`\n(all timestamps are the fixed demo instant: ${new Date(DEMO_INSTANT_MS).toISOString()})\n`);
