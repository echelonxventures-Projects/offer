/**
 * Example 13 - the same platform, a different database.
 *
 * Every other example runs on the in-memory store, which is fine for a demo and
 * proves nothing about durability. This one shows what changes when a
 * deployment moves to a real SQL database: the store, and nothing else.
 *
 * It runs on SQLite with no setup at all. Set GOIP_TEST_POSTGRES to a
 * connection URL and the identical code runs on PostgreSQL instead - the point
 * being that the capability calls below do not know or care which.
 */
import { GoipPlatform } from "../src/platform/platform.ts";
import { SqlPlatformStore } from "../src/adapters/sql/store.ts";
import { NodeSqliteClient } from "../src/adapters/sql/sqlite-client.ts";
import { POSTGRES_DIALECT, SQLITE_DIALECT, dialectRegistry } from "../src/adapters/sql/dialect.ts";
import { schemaStatements } from "../src/adapters/sql/schema.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { DEMO_INSTANT_MS, TENANT, heading, money, must, row, section } from "./_bootstrap.ts";
import { simpleOffer } from "./_fixtures.ts";

heading("EXAMPLE 13 - SQL: one store, one schema, two databases");

/* ---------------------------------------------------------------- */
section("1. what a dialect actually is");

const dialects = dialectRegistry();
row("registered dialects", dialects.keys().join(", "));
for (const dialect of dialects.list()) {
  row(`  ${dialect.key} money column`, dialect.types.money);
  row(`  ${dialect.key} placeholder`, dialect.placeholder(1));
  row(`  ${dialect.key} opens a write`, dialect.beginWrite);
}

console.log(`
   Five differences, and that is the whole list. SQLite's only integer type is
   64-bit, which caps one funding source at ~9.2e18 minor units; Postgres uses
   NUMERIC(38,0) and has no such ceiling, without giving up the conditional
   UPDATE that makes reservation atomic. Both, rather than one or the other.`);

/* ---------------------------------------------------------------- */
section("2. one schema, substituted per dialect");

const sqliteDdl = schemaStatements(SQLITE_DIALECT);
const postgresDdl = schemaStatements(POSTGRES_DIALECT);
row("statements (sqlite)", String(sqliteDdl.length));
row("statements (postgres)", String(postgresDdl.length));
row("same number of statements", String(sqliteDdl.length === postgresDdl.length));

const fundingTable = (statements: string[]) =>
  statements.find((statement) => statement.includes("CREATE TABLE IF NOT EXISTS funding_source")) ?? "";
row("sqlite budget column", /budget_minor\s+(\S+)/.exec(fundingTable(sqliteDdl))?.[1] ?? "?");
row("postgres budget column", /budget_minor\s+(\S+(?:\(\d+,\d+\))?)/.exec(fundingTable(postgresDdl))?.[1] ?? "?");

console.log(`
   There is deliberately no second copy of that DDL. Two copies drift - one
   gains an index the other does not, and two adapters meant to be the same
   store quietly stop being it. Substituting four type names is a much smaller
   price than that.`);

/* ---------------------------------------------------------------- */
section("3. opening a store");

const postgresUrl = process.env.GOIP_TEST_POSTGRES;
let store;
let which: string;

if (postgresUrl === undefined) {
  which = "sqlite (set GOIP_TEST_POSTGRES to run this on postgres instead)";
  store = await SqlPlatformStore.open({
    client: new NodeSqliteClient(":memory:"),
    dialect: SQLITE_DIALECT,
  });
} else {
  // The driver is a port, so this is the deployment's ten lines, not the
  // platform's. In production it would wrap `pg` or `postgres.js`.
  const { TestPostgresClient, parsePostgresUrl } = await import("../test/_postgres-driver.ts");
  const client = await TestPostgresClient.connect(parsePostgresUrl(postgresUrl));
  which = "postgres";
  store = await SqlPlatformStore.open({ client, dialect: POSTGRES_DIALECT });
}
row("running on", which);

const platform = new GoipPlatform({
  clock: fixedClock(BigInt(DEMO_INSTANT_MS) * 1_000_000n),
  ids: sequentialIdFactory(),
  store,
});
const caps = platform.capabilities;

/* ---------------------------------------------------------------- */
section("4. the same capability calls, whichever database that was");

must(
  await caps.fund({
    tenant: TENANT, actor: "ops", sourceId: "merchant-acme", label: "Acme budget",
    party: { kind: "merchant", id: "acme" }, unit: "USD", budgetDecimal: "1000.00",
  }),
  "fund",
);

const offer = must(
  await caps.create({ tenant: TENANT, actor: "ops", draft: simpleOffer("Everyday 10% off") }),
  "create",
);
must(await caps.publish({ tenant: TENANT, actor: "ops", valueExchangeId: offer.id, approvedBy: "finance" }), "publish");

const basket = (subject: string) => ({
  tenant: TENANT, unit: "USD", channel: "web", subject: { id: subject },
  cart: {
    lines: [{
      id: "l1", sku: "WIDGET", quantity: 1,
      unitPrice: { unit: "USD", minor: 10_000n, scale: 2 },
      categories: ["tools"], merchant: "acme",
    }],
  },
});

const redeemed = must(
  await caps.redeem({
    context: basket("shopper-1"), actor: "checkout", idempotencyKey: "order-1", candidateIds: [offer.id],
  }),
  "redeem",
);
row("saving applied", money(redeemed.decision.payableReduction));

const settled = must(await caps.settle({ tenant: TENANT }), "settle");
row("ledger balanced", String(settled.balanced));
for (const position of settled.positions) {
  row(`  ${position.accountId}`, `${position.netMinor} ${position.unit}`);
}

const audited = must(await caps.audit({ tenant: TENANT }), "audit");
row("audit chain verified", String(audited.verified));

/* ---------------------------------------------------------------- */
section("5. concurrency, on whichever database this is");

const limited = must(
  await caps.create({
    tenant: TENANT, actor: "ops",
    draft: { ...simpleOffer("One only"), name: "One only", limits: { totalRedemptions: 1 } },
  }),
  "create limited",
);
must(await caps.publish({ tenant: TENANT, actor: "ops", valueExchangeId: limited.id, approvedBy: "finance" }), "publish limited");

const attempts = await Promise.all(
  Array.from({ length: 10 }, (_, i) =>
    caps.reserve({
      context: basket(`racer-${i}`), actor: "checkout",
      idempotencyKey: `race-${i}`, candidateIds: [limited.id],
    }),
  ),
);
const admitted = attempts.filter((attempt) => attempt.ok).length;
row("concurrent attempts", "10");
row("admitted", `${admitted} (the limit is 1)`);

console.log(`
   The headroom test lives in the WHERE clause of the write itself, so there is
   no window between checking and writing. That is the pattern every port of
   this adapter copies, and it is what the concurrency suite measures on both
   databases rather than assuming.`);

await store.close?.();

section("what this example does not show");

console.log(`
   A production Postgres driver. The platform ships a driver *port*, and a
   deployment brings 'pg' or 'postgres.js' in about ten lines - because
   depending on one would end the zero-dependency promise for every deployment,
   including the ones that only ever use SQLite.

   Also missing: migrations. Opening a store runs CREATE TABLE IF NOT EXISTS
   and nothing versions the schema. Pass createSchema: false and run
   schemaStatements(dialect) through whatever migration tool you already have.`);
