# Storage contract (L5)

What a storage adapter must guarantee, in any database, in any language.

This is the one level vectors cannot cover, because it is about what other
callers can observe rather than about a value. It is stated as obligations.

---

## Obligation 1 — conditional operations are atomic

Four operations carry a constraint and MUST enforce it in one indivisible step.

| Operation | Enforces |
| --- | --- |
| `counters.tryConsume` | Every limit in the supplied limit spec |
| `counters.tryIssue` | The issuance cap |
| `funding.tryReserve` | Budget headroom: `budget − reserved − spent` |
| `funding.captureReserved` | That the hold being captured exists |

Each MUST either apply completely or fail having changed **nothing**. A caller
MUST NOT be able to read a value, decide, and then write.

Two acceptable shapes:

**Conditional update** — the test lives in the write:

```sql
UPDATE funding_source
   SET reserved_minor = reserved_minor + :amount
 WHERE tenant = :tenant AND id = :id
   AND (budget_minor IS NULL OR budget_minor - reserved_minor - spent_minor >= :amount);
-- zero rows affected means refused, and nothing was written
```

**Exclusive section** — a write lock spanning the read and the write:
`BEGIN IMMEDIATE` (SQLite), `SELECT ... FOR UPDATE` (Postgres), a mutex
(in-process).

**Unacceptable:** read, check in application code, write. That shape is safe
only in a single-threaded adapter, and an interface whose only safe
implementation is an accident is the wrong interface.

## Obligation 2 — composite operations are transactional

These MUST be atomic across every store they touch, rolling back entirely on
failure:

| Operation | Touches |
| --- | --- |
| reserve | counters, funding, executions, audit |
| capture | ledger, funding, executions, audit |
| release | funding, counters, executions, audit |
| reverse | ledger, funding, counters, executions, audit |
| issue | counters, grants, audit |

A partial capture — ledger entries with no execution, or budget spent with no
entries — is the worst outcome the platform can produce.

## Obligation 3 — idempotency is enforced by the store

An execution's idempotency key MUST be unique per tenant, enforced by the
database (a unique index), not by a prior read. Two concurrent identical
requests MUST converge on one execution.

## Obligation 4 — advisory reads are marked as such

A counter read is explicitly advisory: it may be stale, may be served from a
replica, and MUST NOT be the basis for admitting a redemption. Only
`tryConsume` may authorise one.

## Obligation 5 — bounded growth

Per-subject recency data MUST be pruned, both by the window any limit actually
uses and by a hard cap. Unbounded append is a leak that surfaces months later
as an oversized row.

## Obligation 6 — append-only ledger and audit

Ledger entries and audit records are append-only. A correction is a contra
entry, never an update. The audit chain is serial per tenant: each record
carries the previous record's hash.

## Obligation 7 — tenant scoping

Every key is `(tenant, id)`. No exceptions, including funding sources — two
tenants using the same source id MUST NOT share a budget.

---

## Proving it

Vectors cannot. Write a concurrency suite in your own language and make it
include a **negative control**: reproduce the unsafe read-check-write shape and
assert that it over-admits under the same load. Without it, a passing test may
simply mean nothing interleaved.

The reference does exactly this in `test/concurrency.test.ts`:

| Property | Assertion |
| --- | --- |
| Redemption limit | 25 concurrent reservations against a limit of 1 → exactly 1 |
| Per-subject limit | 3 subjects × 4 attempts, limit 1 each → exactly 3 |
| Budget headroom | Budget for one benefit, 15 concurrent → exactly 1 |
| Idempotency | 12 concurrent, same key → 1 execution |
| Rollback | A failed reservation leaves no hold **and** no consumed limit |
| Negative control | The unsafe shape over-admits under identical load |

## Suggested schema

`src/adapters/sqlite-schema.ts` is written to be read as a specification: a
Postgres or MySQL adapter is that file with different types and the same
indexes. Two notes carried over from it:

- Store records as documents using the wire codec so exact integers survive.
- Columns that must be **compared in SQL** (reserved, spent, budget, granted)
  need a numeric type. SQLite's 64-bit INTEGER bounds a source at ~9.2e18 minor
  units; Postgres `NUMERIC(38,0)` does not. Choose knowingly.
