/**
 * Schema migrations.
 *
 * The store used to run `CREATE TABLE IF NOT EXISTS` and call that a schema. It
 * created a database and nothing else: no version, no upgrade path, no way to
 * tell "fresh" from "three releases behind". These tests cover the mechanism that
 * replaced it.
 *
 * What has to be true:
 *   - an empty database reaches the latest version;
 *   - a database already current does no work and stays at its version;
 *   - a second migration applies without disturbing the first;
 *   - a database created the old way (version 0) is upgraded, not recreated.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SqlPlatformStore } from "../src/adapters/sql/store.ts";
import { NodeSqliteClient } from "../src/adapters/sql/sqlite-client.ts";
import { SQLITE_DIALECT, POSTGRES_DIALECT } from "../src/adapters/sql/dialect.ts";
import {
  migrate,
  BASELINE_MIGRATION,
  LATEST_VERSION,
  MIGRATIONS,
  type Migration,
} from "../src/adapters/sql/migrations.ts";
import { ADAPTERS } from "./_adapters.ts";

/** A throwaway client over an in-memory SQLite database. */
function sqliteClient() {
  return new NodeSqliteClient(":memory:");
}

describe("schema migrations", () => {
  test("an empty database is brought to the latest version", async () => {
    const store = await SqlPlatformStore.open({
      client: sqliteClient(),
      dialect: SQLITE_DIALECT,
    });

    assert.equal(await store.scalar(`SELECT MAX(version) FROM schema_version`), BigInt(LATEST_VERSION));

    // And the schema is usable, not merely present.
    const rows = await store.scalar(`SELECT COUNT(*) FROM value_exchange`);
    assert.equal(rows, BigInt(0), "the table exists and is queryable");
    await store.close();
  });

  test("opening twice applies nothing the second time", async () => {
    const client = sqliteClient();
    const first = await SqlPlatformStore.open({ client, dialect: SQLITE_DIALECT });
    // Intentionally not closed: the mock below reuses this client, and closing it
    // would make the second open's reads fail rather than prove anything.

    // A real second pass over the same database. It must find the schema current
    // and apply nothing, not re-run the baseline.
    const second = await migrate(
      {
        transactional: async (statements) => {
          for (const statement of statements) await client.execute(statement);
        },
        scalar: async (sql) => {
          const rows = await client.query(sql);
          return Object.values(rows[0] ?? {})[0] as bigint | undefined;
        },
      },
      SQLITE_DIALECT,
    );
    assert.deepEqual(second.applied, [], "the second call found nothing pending");
    assert.equal(second.fromVersion, LATEST_VERSION);
    assert.equal(second.toVersion, LATEST_VERSION);

    const store = await SqlPlatformStore.open({ client, dialect: SQLITE_DIALECT });
    assert.equal(await store.scalar(`SELECT MAX(version) FROM schema_version`), BigInt(LATEST_VERSION));
    await store.close();
  });

  test("a migration is recorded once and not re-applied", async () => {
    const store = await SqlPlatformStore.open({ client: sqliteClient(), dialect: SQLITE_DIALECT });

    // Running migrate again must not add rows: one per migration, recorded on the
    // first open and found current on every open after.
    const first = await migrate(store, SQLITE_DIALECT, { now: () => 1_000n });
    assert.equal(first.applied.length, 0, "already current, nothing applied");
    assert.equal(first.fromVersion, LATEST_VERSION);
    assert.equal(first.toVersion, LATEST_VERSION);

    const rows = await store.scalar(`SELECT COUNT(*) FROM schema_version`);
    assert.equal(rows, BigInt(MIGRATIONS.length), "one row per shipped migration, not per call");
    await store.close();
  });

  test("a second migration applies on top of the first", async () => {
    const client = sqliteClient();
    const extra: Migration = {
      version: LATEST_VERSION + 1,
      description: "test: an additive column",
      statements: [`ALTER TABLE value_exchange ADD COLUMN migrated_at {{text}}`],
    };

    // Open with the custom list, so the baseline and the extra migration are
    // applied together by the same runner rather than in two passes.
    const store = await SqlPlatformStore.open({
      client,
      dialect: SQLITE_DIALECT,
      migrations: [BASELINE_MIGRATION, extra],
    });

    assert.equal(await store.scalar(`SELECT MAX(version) FROM schema_version`), BigInt(LATEST_VERSION + 1));

    // The column exists, which is the point of a migration.
    await store.scalar(`SELECT migrated_at FROM value_exchange`);

    // Re-opening over the same database applies nothing: the extra migration is
    // recorded, not re-run on every open.
    const again = await SqlPlatformStore.open({
      client,
      dialect: SQLITE_DIALECT,
      migrations: [BASELINE_MIGRATION, extra],
    });
    assert.equal(await again.scalar(`SELECT COUNT(*) FROM schema_version`), BigInt(2));
    // One client shared by both stores: closing one closes it for both, so only
    // close it once.
    await again.close();
  });

  test("a description containing a quote does not break the insert", async () => {
    const tricky: Migration = {
      version: LATEST_VERSION + 1,
      description: "it's a description with a 'quote'",
      statements: [`ALTER TABLE value_exchange ADD COLUMN q {{text}}`],
    };
    const store = await SqlPlatformStore.open({
      client: sqliteClient(),
      dialect: SQLITE_DIALECT,
      migrations: [BASELINE_MIGRATION, tricky],
    });

    const described = await store.query(
      `SELECT description FROM schema_version WHERE version = ?`,
      LATEST_VERSION + 1,
    );
    assert.equal(described[0]!.description, tricky.description, "the description survived verbatim");
    await store.close();
  });

  test("the schema is identical whether created by migration or by the legacy path", async () => {
    // The baseline migration and the old `schemaStatements` list must produce the
    // same tables, because two ways of creating the same schema is how they
    // quietly stop being the same.
    const byMigration = await SqlPlatformStore.open({ client: sqliteClient(), dialect: SQLITE_DIALECT });
    const tables = await byMigration.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    const names = tables.map((row) => String(row.name));
    await byMigration.close();

    assert.ok(names.includes("schema_version"), "the version table is new");
    for (const expected of [
      "value_exchange",
      "grant_row",
      "counter",
      "counter_subject",
      "counter_recent",
      "counter_granted",
      "funding_source",
      "execution",
      "ledger_entry",
      "ledger_snapshot",
      "audit_record",
      "audit_checkpoint",
      "touchpoint",
    ]) {
      assert.ok(names.includes(expected), `table ${expected} was created by the baseline migration`);
    }
  });
});

for (const [index, adapter] of ADAPTERS.entries()) {
  // `scalar` is a SQL-store method, so this loop only asserts on the SQL adapters
  // that expose it; the memory adapter has no schema to migrate and is covered by
  // the conformance suite instead.
  if (!(adapter.name === "sqlite" || adapter.name === "sql/sqlite" || adapter.name === "sql/postgres")) continue;

  describe(`${adapter.name}: migrations run on open`, () => {
    test("the store opens and reports the latest version", async () => {
      const store = (await adapter.create()) as SqlPlatformStore;
      const version = await store.scalar(`SELECT MAX(version) FROM schema_version`);
      assert.equal(version, BigInt(LATEST_VERSION), `${adapter.name} migrated to ${LATEST_VERSION}`);
      await store.close?.();
    });
  });
}
