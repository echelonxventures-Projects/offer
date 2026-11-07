/**
 * SQL dialects.
 *
 * `sqlite-schema.ts` always said a Postgres adapter would be "this file with
 * different types and the same indexes". This is that sentence made executable:
 * one schema, one set of queries, and a registry of the handful of places where
 * two SQL databases genuinely disagree.
 *
 * Keeping it to one schema is the whole point. Two copies of this DDL would
 * drift - one would gain an index the other did not, and the adapters would
 * quietly stop being the same store. The types are substituted, the indexes are
 * not negotiable.
 */
import type { RegistryEntry } from "../../registry/registry.ts";
import { Registry } from "../../registry/registry.ts";

export interface SqlDialect extends RegistryEntry {
  /** Positional parameter marker: `?` for SQLite, `$1` for Postgres. */
  placeholder(index: number): string;

  /** Column type names substituted into the shared schema. */
  readonly types: {
    /** Opaque strings: ids, JSON documents, tick tokens. */
    readonly text: string;
    /** Small counts that will never approach 2^53. */
    readonly integer: string;
    /**
     * Money, in minor units.
     *
     * SQLite has one integer type, 64-bit signed, which bounds a funding source
     * at ~9.2e18 minor units. Postgres can do better and should: NUMERIC(38,0)
     * removes the limit without giving up the conditional `UPDATE ... WHERE
     * headroom >= ?` that makes reservation atomic.
     */
    readonly money: string;
    /** Fractional seconds, for the rolling-window index. */
    readonly real: string;
  };

  /**
   * How to open a write transaction.
   *
   * SQLite needs `BEGIN IMMEDIATE` to take the write lock up front; a plain
   * `BEGIN` defers it and turns a concurrent check-and-consume into
   * SQLITE_BUSY at COMMIT, after the decision has already been made. Postgres
   * takes row locks as it goes, so a plain `BEGIN` is correct there.
   */
  readonly beginWrite: string;

  /** Statements run once at open, before the schema. Empty for most databases. */
  readonly setup: readonly string[];

  /**
   * Scalar maximum of two values.
   *
   * SQLite overloads `MAX` - aggregate with one argument, scalar with two.
   * Postgres keeps them apart and calls the scalar one `GREATEST`. Every use
   * here is clamping a counter at zero on the way down.
   */
  greatest(a: string, b: string): string;

  /**
   * Order a text column in codepoint order.
   *
   * This is the one place a database's defaults are not neutral. SQLite's only
   * text collation is BINARY, which compares by codepoint. Postgres collates by
   * the database's `LC_COLLATE` - locale-dependent, and case-folding in most
   * locales - so a plain `ORDER BY` on a mixed-case id disagrees with every
   * other adapter. Account ids embed unit codes like `USD` and source ids are
   * tenant-supplied, so "mixed-case" is the normal case here, not an edge.
   *
   * [ADR 0020](../../06-adr/0020-codepoint-ordering.md) makes codepoint order the
   * contract across implementations; this is how a database that would rather
   * use the locale still keeps it. Only applied to text columns - numeric
   * columns such as `seq` have no collation and are ordered directly.
   */
  orderByText(column: string): string;

  /** Coerce a driver's idea of an integer column into a bigint. */
  toBigInt(value: unknown): bigint;
}

/**
 * Drivers disagree about what an integer column is.
 *
 * `node:sqlite` returns a bigint when asked. Postgres drivers return BIGINT and
 * NUMERIC as **strings**, because neither fits a JavaScript number - which is
 * correct of them and a trap for any adapter that assumes otherwise. Money in
 * this platform is exact, so a silent trip through a float would be the worst
 * possible bug: small values would look fine and large ones would be wrong.
 */
function coerceBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string") return BigInt(value === "" ? "0" : value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(`refusing to read ${value} as an exact integer`);
    }
    return BigInt(value);
  }
  if (value === null || value === undefined) return 0n;
  return BigInt(String(value));
}

export const SQLITE_DIALECT: SqlDialect = {
  key: "sqlite",
  label: "SQLite",
  description: "Node's built-in driver. Single-writer, genuinely transactional, zero dependencies.",
  placeholder: () => "?",
  types: { text: "TEXT", integer: "INTEGER", money: "INTEGER", real: "REAL" },
  beginWrite: "BEGIN IMMEDIATE",
  setup: ["PRAGMA journal_mode = WAL", "PRAGMA foreign_keys = ON"],
  greatest: (a, b) => `MAX(${a}, ${b})`,
  orderByText: (column) => column,
  toBigInt: coerceBigInt,
};

export const POSTGRES_DIALECT: SqlDialect = {
  key: "postgres",
  label: "PostgreSQL",
  description: "Multi-writer, with NUMERIC(38,0) money columns that have no 64-bit ceiling.",
  placeholder: (index) => `$${index}`,
  types: {
    text: "TEXT",
    integer: "BIGINT",
    money: "NUMERIC(38,0)",
    real: "DOUBLE PRECISION",
  },
  beginWrite: "BEGIN",
  setup: [],
  greatest: (a, b) => `GREATEST(${a}, ${b})`,
  orderByText: (column) => `${column} COLLATE "C"`,
  toBigInt: coerceBigInt,
};

export function dialectRegistry(): Registry<SqlDialect> {
  return new Registry<SqlDialect>("sql-dialect").registerAll([SQLITE_DIALECT, POSTGRES_DIALECT]);
}
