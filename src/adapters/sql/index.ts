/**
 * The SQL adapter: one store, a driver port, and a registry of dialects.
 *
 * See docs/07-operations/11-sql-adapters.md for wiring a real driver.
 */
export * from "./client.ts";
export * from "./dialect.ts";
export * from "./schema.ts";
export * from "./store.ts";
export * from "./sqlite-client.ts";
