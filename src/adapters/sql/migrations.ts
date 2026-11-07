/**
 * Schema migrations for the SQL adapters.
 *
 * The store used to run `CREATE TABLE IF NOT EXISTS` on every open and call that
 * a schema. That is enough to create a database and nothing else: there is no
 * version, no upgrade path and no way to distinguish "fresh" from "three
 * releases behind". A schema change had no mechanism behind it, which is the one
 * thing a stored-record platform cannot leave unaddressed - the documents are
 * written by code that has since moved on.
 *
 * This is the mechanism. Migrations are a numbered, ordered list of statement
 * batches; the database records which ones it has run in a `schema_version`
 * table, and `migrate` applies everything above that point in a transaction. The
 * shipped list contains one migration that establishes the whole baseline, so an
 * empty database and a pre-migration one both end up current.
 *
 * What it deliberately is not: a down path. Every change here is additive, and a
 * rollback that reverts a document format the running code already understands
 * is how a database becomes unreadable. Roll forward, or restore a backup.
 */
import type { SqlDialect } from "./dialect.ts";
import { schemaTemplateStatements, substituteTemplate } from "./schema.ts";

export interface Migration {
  /** Monotonic. Applied in order; gaps are not allowed. */
  readonly version: number;
  /** What changed, for an operator reading `migrate` output. */
  readonly description: string;
  /**
   * Statements in template form (`{{text}}` and friends), each separately
   * executable, substituted for the dialect when applied. Placeholders are not
   * available here: a migration alters structure, and a structural change has no
   * parameters.
   */
  readonly statements: readonly string[];
}

/**
 * The baseline. Everything the store created with `IF NOT EXISTS` before
 * migrations existed, expressed as version 1 so a pre-existing database is
 * version 0 and gets upgraded rather than recreated.
 */
export const BASELINE_MIGRATION: Migration = {
  version: 1,
  description: "baseline schema: exchanges, grants, counters, funding, execution, ledger, audit, touchpoints",
  statements: schemaTemplateStatements(),
};

/**
 * Persists maintenance last-run times, so a restart does not forget when the
 * sweep last ran and a multi-process deployment does not run every job on every
 * instance.
 */
const MAINTENANCE_TABLE_MIGRATION: Migration = {
  version: 2,
  description: "maintenance last-run times, so schedules survive a restart",
  statements: [
    `CREATE TABLE IF NOT EXISTS maintenance_run (
       tenant {{text}} NOT NULL,
       job    {{text}} NOT NULL,
       at     {{text}} NOT NULL,
       PRIMARY KEY (tenant, job)
     )`,
  ],
};

/** The shipped migrations, in order. */
export const MIGRATIONS: readonly Migration[] = [BASELINE_MIGRATION, MAINTENANCE_TABLE_MIGRATION];

/** The highest version the shipped migrations reach. */
export const LATEST_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);

export interface MigrationReport {
  /** Version the database was at when this started. */
  readonly fromVersion: number;
  /** Version it reached. Equal to `fromVersion` when nothing was applied. */
  readonly toVersion: number;
  readonly applied: readonly { version: number; description: string; statements: number }[];
}

export interface MigrationClient {
  /** Run several statements in one transaction. */
  transactional(statements: readonly string[]): Promise<void>;
  /** Read a single value, or undefined when the table is empty. */
  scalar(sql: string): Promise<bigint | number | string | undefined>;
}

/** Apply every migration above the recorded version. Idempotent. */
export async function migrate(
  client: MigrationClient,
  dialect: SqlDialect,
  options: { migrations?: readonly Migration[]; now?: () => bigint } = {},
): Promise<MigrationReport> {
  const migrations = options.migrations ?? MIGRATIONS;
  const now = options.now ?? (() => BigInt(Date.now()));

  // The version table has to exist before it can be read, and outside the
  // migration transaction: a database that is already current still needs
  // somewhere to report its version from.
  await client.transactional([substitute(VERSION_TABLE, dialect)]);

  const current = await client.scalar(SELECT_VERSION);
  const fromVersion = current === undefined ? 0 : Number(current);
  if (fromVersion >= LATEST_VERSION) {
    return { fromVersion, toVersion: fromVersion, applied: [] };
  }

  const pending = migrations.filter((migration) => migration.version > fromVersion);
  const applied: { version: number; description: string; statements: number }[] = [];

  for (const migration of pending) {
    const statements = migration.statements.map((statement) => substitute(statement, dialect));
    // One migration is one transaction: a schema change that applies half of
    // itself leaves the database at a version nobody shipped.
    await client.transactional([
      ...statements,
      recordVersion(dialect, migration.version, now(), migration.description),
    ]);
    applied.push({
      version: migration.version,
      description: migration.description,
      statements: statements.length,
    });
  }

  return { fromVersion, toVersion: LATEST_VERSION, applied };
}

/** The table that records progress. Created before any migration runs. */
const VERSION_TABLE = `CREATE TABLE IF NOT EXISTS schema_version (
  version     {{integer}} NOT NULL PRIMARY KEY,
  applied_at  {{integer}} NOT NULL,
  description {{text}} NOT NULL
)`;

const SELECT_VERSION = `SELECT MAX(version) FROM schema_version`;

/**
 * Substitute the dialect's type names into a template. The same helper the schema
 * uses, so a migration and a fresh `CREATE TABLE` can never disagree about what
 * a money column is.
 */
const substitute = substituteTemplate;

/**
 * The version insert, values inlined as literals.
 *
 * Inline rather than parameterised because the migration client's transactional
 * interface takes statements only. The values are an integer, a tick and a
 * description this module generated - never caller input - so the only escaping
 * needed is the quote in the description.
 */
function recordVersion(dialect: SqlDialect, version: number, appliedAt: bigint, description: string): string {
  const values = [String(version), appliedAt.toString(), escapeLiteral(description)];
  return `INSERT INTO schema_version (version, applied_at, description) VALUES (${values
    .map((value) => literal(value, dialect))
    .join(",")})`;
}

/**
 * A literal in the dialect's spelling. Both databases accept a quoted string for
 * a text column and a bare integer for an integer one, so the dialect is not
 * needed here - but it is passed so a database that does differ has somewhere to
 * hook in rather than silently producing SQL nobody tested.
 */
function literal(value: string, _dialect: SqlDialect): string {
  return `'${value}'`;
}

/** Single quotes in a description would terminate the literal early. */
function escapeLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
