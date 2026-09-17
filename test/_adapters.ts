/**
 * The adapters every storage-sensitive test runs against.
 *
 * Adding a third - Postgres, say - means adding one line here, and the whole
 * conformance and concurrency suite covers it immediately. That is the point of
 * the ports: an adapter is not "done" until it passes this list.
 */
import type { PlatformStore } from "../src/adapters/store.ts";
import { MemoryPlatformStore } from "../src/adapters/memory-store.ts";
import { SqlitePlatformStore } from "../src/adapters/sqlite-store.ts";

export interface AdapterUnderTest {
  readonly name: string;
  create(): PlatformStore;
}

export const ADAPTERS: AdapterUnderTest[] = [
  { name: "memory", create: () => new MemoryPlatformStore() },
  { name: "sqlite", create: () => new SqlitePlatformStore({ location: ":memory:" }) },
];
