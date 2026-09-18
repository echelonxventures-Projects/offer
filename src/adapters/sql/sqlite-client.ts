/**
 * A `SqlClient` over Node's built-in SQLite driver.
 *
 * This is the one driver the platform can ship without taking a dependency,
 * because Node already has it. Everything else - Postgres, MySQL, a hosted
 * serverless database - arrives through the same port, written by whoever is
 * deploying.
 *
 * `node:sqlite` is synchronous, so every method here resolves immediately. That
 * is not a shortcut: it means the SQLite path keeps the atomicity it always
 * had, while the store above it is written once for drivers that are not.
 */
import { DatabaseSync } from "node:sqlite";
import type { SqlClient, SqlRow } from "./client.ts";

export class NodeSqliteClient implements SqlClient {
  readonly #db: DatabaseSync;

  constructor(location = ":memory:") {
    this.#db = new DatabaseSync(location);
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<SqlRow[]> {
    const statement = this.#db.prepare(sql);
    // Integer columns hold money. Without this they arrive as JavaScript
    // numbers, and anything past 2^53 is silently wrong.
    statement.setReadBigInts(true);
    return statement.all(...(params as never[])) as SqlRow[];
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    return Number(this.#db.prepare(sql).run(...(params as never[])).changes);
  }

  async script(sql: string): Promise<void> {
    this.#db.exec(sql);
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
