# ADR 0021 — The driver is a port

**Status:** Accepted · **Date:** 2026-09-18 · **Phase:** 7

## Context

"No PostgreSQL adapter" has been the top entry on the critical gap list since
Phase 1. SQLite is genuinely transactional and it proved the ports, but it is
single-writer, which makes it unsuitable for the multi-process deployment this
platform is otherwise built for.

The obvious implementation has a problem the rest of the project would not
tolerate. Node ships a SQLite driver and nothing else, so a Postgres adapter has
to get its driver from somewhere. Adding `pg` as a dependency would:

- end the zero-dependency promise for **every** deployment, including the ones
  that only ever use SQLite;
- choose a driver on a deployment's behalf, when most already run one, have
  opinions about pooling, or are on a serverless platform whose driver speaks
  HTTP rather than TCP.

The user requirement this project was built to is explicit: tools, language and
database agnostic, with zero hard coding. A hard dependency on one driver is
exactly the thing being ruled out.

## Decision

**The driver is a port.** Four methods:

```ts
export interface SqlClient {
  query(sql: string, params?: readonly unknown[]): Promise<SqlRow[]>;
  execute(sql: string, params?: readonly unknown[]): Promise<number>;
  script(sql: string): Promise<void>;
  close?(): Promise<void>;
}
```

A deployment wraps whatever it already runs. The interface is deliberately tiny:
the moment an adapter can reach a driver-specific feature it stops being
portable.

**One store, not two.** `SqlPlatformStore` is the single SQL implementation.
`SqlDialect` holds the five things two SQL engines genuinely disagree about —
placeholders, column types, how to open a write transaction, the scalar maximum,
and setup statements. Everything else is shared.

**One schema.** `schema.ts` holds the DDL once, with four substituted type
names. Two copies would drift — one gains an index the other does not, and two
adapters meant to be the same store quietly stop being it.

**`NodeSqliteClient` ships**, because Node already has that driver and taking it
costs nothing. Nothing else ships.

## Consequences

**Good**

- Postgres works, and `NUMERIC(38,0)` removes SQLite's ~9.2e18 ceiling on a
  funding source without giving up the conditional `UPDATE ... WHERE headroom >=
  ?` that makes reservation atomic. Both, rather than one or the other.
- The zero-dependency promise survives intact.
- MySQL, CockroachDB or a hosted serverless database is a dialect entry plus a
  driver wrapper, not a fork of the store.
- The conformance suite covers Postgres the moment it is listed, which is what
  the adapter list was always for.

**Bad**

- Opening a store is now async (`SqlPlatformStore.open`), because connecting is.
  A constructor cannot await, and a store that returned before its schema existed
  would fail on its first write for a reason nobody would guess.
- Every deployment that is not on SQLite writes ten lines of driver wrapper. That
  is the price of not choosing their driver, and it is documented with a working
  `pg` example.
- Placeholder renumbering does not parse SQL, so a literal `?` inside a quoted
  string would be rewritten. No query here contains one and a test asserts that
  stays true, because the failure would otherwise be silent and bizarre.

## What Postgres forced, that SQLite had hidden

Three portability defects, each of which SQLite accepts and Postgres does not.
All three were found by running the suite, not by reading the code.

**`ON CONFLICT ... DO UPDATE SET redemptions = redemptions + 1`** is ambiguous in
Postgres — the bare column could be the stored row or the proposed one. SQLite
guesses; Postgres refuses. Qualifying it (`counter.redemptions + 1`) is correct
and works in both. This one broke every transactional path.

**`rowid`** has no portable equivalent. `counter_recent` now carries an explicit
`seq`, assigned inside the write transaction exactly the way the ledger assigns
its own. That also fixed a latent correctness point: undoing "the most recent
redemption" by timestamp cannot choose between two in the same second, and by
insertion order it can.

**`MAX(a, b)`** is a scalar in SQLite and an aggregate in Postgres, which spells
the scalar `GREATEST`. Every use is clamping a counter at zero on the way down.

## Reading integers exactly

The one place a portable adapter goes quietly and badly wrong.

`node:sqlite` returns a bigint when asked. Postgres drivers return `BIGINT` and
`NUMERIC` as **strings**, because neither fits a JavaScript number — correct of
them, and a trap for anything that assumes otherwise. Money here is exact, so a
silent trip through a float would be the worst available bug: small values look
fine and large ones are wrong.

Every integer column is read through `dialect.toBigInt`, which accepts a bigint,
a string, or an exactly-representable number, and **throws** on a non-integer
number rather than rounding it.

## On the test driver

`test/_postgres-driver.ts` speaks enough of the version 3 wire protocol to put
the conformance suite in front of a real server. It exists because an adapter
nobody has run against Postgres is not an adapter, it is a hopeful guess.

It is **not** a production driver and says so at the top: no TLS, no SCRAM or
MD5 authentication, no pooling, no prepared-statement cache, and every value
read as text. It is not exported from the package. Shipping it would invite
exactly the wrong use.

## Alternatives considered

**Depend on `pg`.** Rejected, as above.

**Write a production Postgres driver.** Rejected. TLS and SCRAM are a large,
security-sensitive surface, and a hand-rolled driver would be the least
trustworthy component in a system whose entire argument is trustworthiness.

**Keep `SqlitePlatformStore` and add a separate Postgres store.** Rejected: two
stores drift, which is the same argument as one schema. The existing synchronous
SQLite adapter remains for now — see the note in
[known gaps](../08-roadmap/02-known-gaps.md) — but the generic store is the one
that gets new work.
