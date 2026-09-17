/**
 * Example 5 - the same platform, off Earth.
 *
 * This is the example that tests the architectural claim rather than the
 * business one. Nothing below registers a new benefit type, a new engine or a
 * new code path. It registers *data*: a spatial subtree, an economic unit that
 * already exists, and a calendar whose fields are sols rather than weekdays.
 *
 * The offer then runs through exactly the same eligibility, stacking, funding
 * and ledger code as the coupon in example 1.
 */
import { TENANT, demoPlatform, heading, money, must, row, section } from "./_bootstrap.ts";
import { instant } from "../src/universal/temporal/chronology.ts";

const platform = demoPlatform();
const caps = platform.capabilities;

heading("EXAMPLE 5 - OFF-WORLD: no Earth assumptions anywhere in the core");

section("what had to be added: data, not code");
platform.spatial.nodes
  .register({ key: "mars.olympus.sector-7.hab-3", label: "Habitat 3", kind: "site", parent: "mars.olympus.sector-7" })
  .register({ key: "luna.alpha.dome-1", label: "Dome 1", kind: "site", parent: "luna.alpha", jurisdiction: "LUNA-ACC" });
platform.spatial.invalidate();
row("spatial nodes added", "2 (registry entries)");
row("economic unit", "MARS_CREDIT - already in the default registry, scale 4");
row("calendar", "mars.msd - fields are sol and millisol, not year/month/day");
row("engines changed", "none");

section("the Martian clock");
const earthNow = must(platform.temporal.now(), "now");
const marsNow = must(platform.temporal.convert(earthNow, "mars.sol.msd"), "convert to MSD");
const marsFields = must(platform.temporal.fields(marsNow, "mars.msd"), "mars fields");
row("Earth instant", `${earthNow.tick} ms since Unix epoch`);
row("Mars instant", `${marsNow.tick} millisols since MSD epoch`);
row("Mars calendar", `sol ${marsFields.sol}, millisol ${marsFields.millisol}, Mars year ${marsFields.marsYear}`);
row("a rule could say", "'every third sol' - there is no week to refer to");

section("an offer denominated in Mars credits");
must(await caps.fund({ tenant: TENANT, actor: "ops", sourceId: "colony-authority", label: "Olympus colonial authority", party: { kind: "government", id: "mars-oa" }, unit: "MARS_CREDIT", budgetDecimal: "500000.0000" }), "fund");

const exchange = must(
  await caps.create({
    tenant: TENANT,
    actor: "colony.admin",
    draft: {
      profile: "government_benefit",
      name: "Habitat oxygen ration rebate",
      description: "25% rebate on life-support consumables, every third sol, in Olympus Territory.",
      visibility: "public",
      acquisition: { mode: "automatic" },
      benefits: [{ id: "rebate", type: "percentage", params: { rate: "25" }, effect: "price_reduction", target: { categories: ["life-support"] } }],
      funding: { model: "single", splits: [{ sourceId: "colony-authority" }] },
      scope: { spatial: { include: ["mars.olympus"] } },
      limits: { totalBudget: { unit: "MARS_CREDIT", decimal: "500000.0000" } },
      stacking: { application: "sequential" },
      priority: 10,
      governance: { owner: "colony.admin@olympus" },
      metadata: { statute: "OT-LS-11" },
      window: {
        from: instant("mars.sol.msd", 0n),
        calendar: "mars.msd",
        // Every third sol. On Earth this field would be dayOfWeek; the engine
        // does not know or care which calendar published the field.
        constraints: [{ field: "sol", modulo: 3, remainder: marsFields.sol! % 3 }],
      },
    },
  }),
  "create",
);
must(await caps.publish({ tenant: TENANT, actor: "colony.admin", valueExchangeId: exchange.id, approvedBy: "colony.council" }), "publish");

const marsContext = {
  tenant: TENANT,
  unit: "MARS_CREDIT",
  place: "mars.olympus.sector-7.hab-3",
  channel: "pos",
  instant: marsNow,
  calendar: "mars.msd",
  subject: { id: "colonist-118" },
  cart: {
    lines: [
      { id: "l1", sku: "O2-CANISTER", quantity: 4, unitPrice: { unit: "MARS_CREDIT", minor: 125_0000n, scale: 4 }, categories: ["life-support"], merchant: "olympus-supply" },
      { id: "l2", sku: "COFFEE-SYNTH", quantity: 1, unitPrice: { unit: "MARS_CREDIT", minor: 30_0000n, scale: 4 }, categories: ["luxury"], merchant: "olympus-supply" },
    ],
  },
};

const quote = must(await caps.apply({ context: marsContext }), "apply on Mars");
row("basket", money(quote.context.cart!.subtotal));
row("rebate", money(quote.decision.payableReduction));
row("colonist pays", money(quote.decision.remainingPayable));
row("targeting", "only the life-support lines; the synthetic coffee is full price");

section("the same offer, seen from the Moon");
const lunar = must(
  await caps.apply({ context: { ...marsContext, place: "luna.alpha.dome-1", subject: { id: "colonist-118" } } }),
  "apply on Luna",
);
row("rebate", money(lunar.decision.payableReduction));
row("refused because", lunar.decision.rejected[0]?.reason ?? "-");

section("and on a wrong sol");
const wrongSol = must(
  await caps.apply({
    context: { ...marsContext, instant: { chronology: "mars.sol.msd", tick: marsNow.tick + 1000n } },
  }),
  "apply next sol",
);
row("rebate", money(wrongSol.decision.payableReduction));
row("refused because", wrongSol.decision.rejected[0]?.reason ?? "-");

section("redeem, and check the books in Mars credits");
const redeemed = must(await caps.redeem({ context: marsContext, actor: "hab-terminal", idempotencyKey: "mars-1" }), "redeem");
for (const entry of redeemed.entries) row(entry.direction, `${entry.accountId} ${money(entry.amount)}`);
const settled = must(await caps.settle({ tenant: TENANT }), "settle");
row("ledger balanced", String(settled.balanced));
console.log("\n   Four decimal places, a non-Earth calendar, a non-Earth place, and the");
console.log("   identical decision path. Nothing in src/engines mentions any of it.\n");
