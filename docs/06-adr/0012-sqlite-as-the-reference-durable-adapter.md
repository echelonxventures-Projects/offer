# ADR 0012 — SQLite as the reference durable adapter

**Status:** Accepted · **Date:** 2026-09-17 · **Phase:** 1

## Context

Phase 1 needed a durable adapter. The obvious target was PostgreSQL: it is what
a production deployment would use, and the roadmap named it.

But a Postgres adapter in this repository would have been **untestable**. There
is no server to run it against, so it could not have appeared in `npm test`,
could not have been covered by the conformance suite, and could not have proven
the concurrency claim that is Phase 1's whole exit criterion. It would have been
code that looked like durability.

## Decision

Ship a **SQLite** adapter, built on Node's built-in `node:sqlite`.

- Still zero runtime dependencies.
- Real transactions with real rollback.
- `BEGIN IMMEDIATE` takes a write lock, which is SQLite's `SELECT ... FOR UPDATE`.
- Conditional `UPDATE ... WHERE headroom >= ?` for atomic reservation.
- Runs in `:memory:` for tests and against a file for the durability example.

The schema lives in its own file, `sqlite-schema.ts`, written to be read as a
specification rather than as an implementation detail: a Postgres adapter is
that file with different types and the same indexes.

## Consequences

**Good**

- The concurrency suite runs against a genuinely transactional store in CI, on
  every commit, with no infrastructure.
- `examples/07-durability.ts` closes a platform, opens a new one on the same
  file, and shows budget, counters, idempotency and the audit chain all intact.
- The conformance suite (`test/adapter-conformance.test.ts`) now has two
  implementations to compare, which is what makes it a conformance suite rather
  than a second copy of the unit tests.
- Adding a third adapter is one line in `test/_adapters.ts`.

**Bad**

- SQLite is not the production target for most deployments, so a Postgres
  adapter is still work that has to happen.
- **Arithmetic columns are 64-bit INTEGER**, because the conditional updates
  have to compare them in SQL. That bounds one funding source at ~9.2e18 minor
  units: 92 trillion at scale 2, 9.2 billion at scale 6. Documents keep full
  `bigint` precision via the wire codec; only the columns that must be compared
  in SQL are bounded. A Postgres adapter should use `NUMERIC(38,0)` and have
  both.
- Single-writer. Fine for the reference and for small deployments, not for a
  high-throughput one.

## What it proves, and what it does not

**Proves:** the ports are implementable against a real transactional database;
the atomicity claims hold under genuine interleaving; a restart loses nothing.

**Does not prove:** behaviour under multi-process contention, network partitions,
or replica lag. Those need a networked database, and they are listed in
[known gaps](../08-roadmap/02-known-gaps.md) rather than implied away.

## Alternatives considered

**A Postgres adapter with a docker-compose file.** Rejected for now: it moves
the test suite from "runs anywhere with Node" to "runs where Docker runs", and
the conformance suite is more valuable than the specific engine.

**Both.** The right end state, and the natural Phase 1b/2 follow-on now that the
conformance suite exists to hold a second implementation to account.

**A file-backed JSON store.** Rejected: no transactions, so it would have proven
nothing about the property Phase 1 exists to establish.
