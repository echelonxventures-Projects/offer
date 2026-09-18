/**
 * The adapters every storage-sensitive test runs against.
 *
 * Adding one means adding a line here, and the whole conformance and
 * concurrency suite covers it immediately. That is the point of the ports: an
 * adapter is not "done" because it compiles, it is done when it passes this
 * list.
 *
 * `create` is async because connecting is. A store that returns before its
 * schema exists fails on its first write, for a reason nobody would guess.
 *
 * **Postgres runs only when GOIP_TEST_POSTGRES is set** to a connection URL.
 * It is skipped otherwise rather than failing, because a contributor without a
 * server should still be able to run the suite - but a skipped adapter is
 * announced, so nobody mistakes silence for coverage.
 */
import type { PlatformStore } from "../src/adapters/store.ts";
import { MemoryPlatformStore } from "../src/adapters/memory-store.ts";
import { SqlitePlatformStore } from "../src/adapters/sqlite-store.ts";
import { SqlPlatformStore } from "../src/adapters/sql/store.ts";
import { NodeSqliteClient } from "../src/adapters/sql/sqlite-client.ts";
import { POSTGRES_DIALECT, SQLITE_DIALECT } from "../src/adapters/sql/dialect.ts";
import { TestPostgresClient, parsePostgresUrl } from "./_postgres-driver.ts";

export interface AdapterUnderTest {
  readonly name: string;
  create(): Promise<PlatformStore>;
}

export const POSTGRES_URL = process.env.GOIP_TEST_POSTGRES;

let schemaCounter = 0;

/**
 * A Postgres store in its own schema.
 *
 * Every test gets a private namespace, so a suite that runs them concurrently
 * cannot have one test's funding source satisfy another's assertion. Dropping
 * it afterwards is left to the server going away with the test database.
 */
async function postgresStore(url: string): Promise<PlatformStore> {
  const client = await TestPostgresClient.connect(parsePostgresUrl(url));
  schemaCounter += 1;
  const schema = `goip_test_${process.pid}_${schemaCounter}`;
  await client.script(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.script(`CREATE SCHEMA ${schema}`);
  await client.script(`SET search_path TO ${schema}`);
  return SqlPlatformStore.open({ client, dialect: POSTGRES_DIALECT });
}

export const ADAPTERS: AdapterUnderTest[] = [
  { name: "memory", create: async () => new MemoryPlatformStore() },
  { name: "sqlite", create: async () => new SqlitePlatformStore({ location: ":memory:" }) },
  {
    name: "sql/sqlite",
    create: () => SqlPlatformStore.open({ client: new NodeSqliteClient(":memory:"), dialect: SQLITE_DIALECT }),
  },
  ...(POSTGRES_URL === undefined
    ? []
    : [{ name: "sql/postgres", create: () => postgresStore(POSTGRES_URL) }]),
];

if (POSTGRES_URL === undefined) {
  console.log("  note: sql/postgres adapter skipped - set GOIP_TEST_POSTGRES to a connection URL to include it");
}
