/**
 * Example 7 - durability, and why the ports changed shape.
 *
 * Two things are demonstrated here, and the second matters more:
 *
 *   1. State survives a restart. The platform writes to a SQLite file, the
 *      process-local object is closed, a completely new platform opens the same
 *      file, and the budget, the counters and the audit chain are all still
 *      there.
 *
 *   2. Concurrency is handled by the store, not hoped for. Twenty simultaneous
 *      reservations against a limit of one admit exactly one - because the
 *      limit check lives inside the write, not in application code.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoipPlatform } from "../src/platform/platform.ts";
import { SqlPlatformStore } from "../src/adapters/sql/store.ts";
import { NodeSqliteClient } from "../src/adapters/sql/sqlite-client.ts";
import { SQLITE_DIALECT } from "../src/adapters/sql/dialect.ts";
import { randomIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { DEMO_INSTANT_MS, TENANT, heading, money, must, row, section } from "./_bootstrap.ts";
import { simpleOffer } from "./_fixtures.ts";

const directory = mkdtempSync(join(tmpdir(), "goip-"));
const file = join(directory, "goip.db");

// The same store the generic SQL adapter uses, on a file. Opening is async
// because connecting is, so each session awaits it.
const open = async (atMs = DEMO_INSTANT_MS) => {
  const store = await SqlPlatformStore.open({
    client: new NodeSqliteClient(file),
    dialect: SQLITE_DIALECT,
  });
  return new GoipPlatform({
    clock: fixedClock(BigInt(atMs) * 1_000_000n),
    ids: randomIdFactory(),
    store,
  });
};

heading("EXAMPLE 7 - DURABILITY: survive a restart, and hold a limit under load");
row("database", file);

/* ---------------------------------------------------------------- */
section("session 1: author, fund, redeem");

let platform = await open();
let caps = platform.capabilities;

must(
  await caps.fund({
    tenant: TENANT,
    actor: "ops",
    sourceId: "merchant-acme",
    label: "Acme budget",
    party: { kind: "merchant", id: "acme" },
    unit: "USD",
    budgetDecimal: "1000.00",
  }),
  "fund",
);

const created = must(
  await caps.create({ tenant: TENANT, actor: "ops", draft: simpleOffer("Durable 10% off") }),
  "create",
);
must(
  await caps.publish({ tenant: TENANT, actor: "ops", valueExchangeId: created.id, approvedBy: "finance" }),
  "publish",
);

const context = {
  tenant: TENANT,
  unit: "USD",
  channel: "web",
  subject: { id: "subject-1" },
  cart: {
    lines: [
      {
        id: "l1",
        sku: "WIDGET",
        quantity: 1,
        unitPrice: { unit: "USD", minor: 20_000n, scale: 2 },
        categories: ["tools"],
        merchant: "acme",
      },
    ],
  },
};

const redeemed = must(await caps.redeem({ context, actor: "checkout", idempotencyKey: "order-1" }), "redeem");
row("discount", money(redeemed.decision.payableReduction));
row("execution", `${redeemed.execution.id} (${redeemed.execution.state})`);
row("audit head", must(await caps.audit({ tenant: TENANT }), "audit").head.slice(0, 24) + "...");

await platform.store.close?.();
row("session 1", "closed");

/* ---------------------------------------------------------------- */
section("session 2: a brand-new platform opens the same file");

platform = await open();
caps = platform.capabilities;

const source = must(await platform.store.funding.get(TENANT, "merchant-acme"), "read funding");
row("budget spent", money(source.spent));
row("budget left", money({ ...source.budget!, minor: source.budget!.minor - source.spent.minor }));

const reloaded = must(await platform.store.executions.get(TENANT, redeemed.execution.id), "read execution");
row("execution survived", `${reloaded.id} (${reloaded.state})`);

const audit = must(await caps.audit({ tenant: TENANT }), "audit");
row("audit records", String(audit.records));
row("chain still verifies", String(audit.verified));

const settled = must(await caps.settle({ tenant: TENANT }), "settle");
row("ledger balanced", String(settled.balanced));

section("idempotency survives the restart too");
const retried = must(
  await caps.redeem({ context, actor: "checkout", idempotencyKey: "order-1" }),
  "retry after restart",
);
row("same execution", String(retried.execution.id === redeemed.execution.id));
row("budget spent (unchanged)", money(must(await platform.store.funding.get(TENANT, "merchant-acme"), "f").spent));

/* ---------------------------------------------------------------- */
section("concurrency: 20 simultaneous reservations, limit of 1");

const limited = must(
  await caps.create({
    tenant: TENANT,
    actor: "ops",
    draft: { ...simpleOffer("Last one left"), limits: { totalRedemptions: 1 } },
  }),
  "create limited",
);
must(
  await caps.publish({ tenant: TENANT, actor: "ops", valueExchangeId: limited.id, approvedBy: "finance" }),
  "publish limited",
);

const attempts = await Promise.all(
  Array.from({ length: 20 }, (_, i) =>
    caps.reserve({
      context: { ...context, subject: { id: `racer-${i}` } },
      actor: "load",
      idempotencyKey: `race-${i}`,
      candidateIds: [limited.id],
    }),
  ),
);

const admitted = attempts.filter((a) => a.ok).length;
const refused = attempts.filter((a) => !a.ok);
row("admitted", String(admitted));
row("refused", String(refused.length));
row("refusal reason", refused[0] && !refused[0].ok ? refused[0].error.message : "-");

console.log(`\n   Exactly ${admitted} of 20 succeeded. The limit is enforced inside the write,`);
console.log("   not by reading a counter and hoping nothing else read it too. The old");
console.log("   `mutate(counters => ...)` port could not have produced this number.\n");

await platform.store.close?.();
rmSync(directory, { recursive: true, force: true });
