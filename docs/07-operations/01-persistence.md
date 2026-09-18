# Persistence

Two adapters ship: `MemoryPlatformStore` and `SqlitePlatformStore`. This
document is the contract a third must satisfy.

The single most important thing to know: **the ports no longer let you get
atomicity wrong.** Before Phase 1 this document contained a long warning about a
read-check-write gap in `CounterStore.mutate`. That warning is gone because the
shape it warned about is gone — see
[ADR 0011](../06-adr/0011-no-read-check-write-in-the-port.md).

---

## The ports

`src/adapters/store.ts`. Everything returns a promise, because a real store is
remote.

| Port | Holds | Volume |
| --- | --- | --- |
| `ValueExchangeStore` | Authored exchanges | Thousands per tenant |
| `GrantStore` | Issued grants | Millions |
| `CounterStore` | Redemption and budget counters | One row per exchange, high write rate |
| `FundingStore` | Budgets with reserved/spent | Hundreds |
| `ExecutionStore` | Reservations and captures | Millions, append-heavy |
| `LedgerStore` | Double-entry lines | Tens of millions, append-only |
| `AuditStore` | Hash chain | Tens of millions, append-only, serial per tenant |
| `TouchpointStore` | Attribution journeys | Very high volume |

---

## The two rules

### 1. Conditional operations must be atomic

Four methods carry a constraint and must enforce it in one indivisible step:

| Method | Enforces |
| --- | --- |
| `counters.tryConsume` | Every limit in the supplied `LimitSpec` |
| `counters.tryIssue` | `totalIssuance` |
| `funding.tryReserve` | Budget headroom (`budget − reserved − spent`) |
| `funding.captureReserved` | That the hold being captured actually exists |

Each must either apply its change completely or report a typed failure having
changed nothing. There is no third outcome, and no version in which the caller
does the check.

Two correct shapes, both shipped:

**Conditional update** — push the test into the `WHERE` clause and inspect the
affected row count. This is what `SqliteFundingStore.tryReserve` does:

```sql
UPDATE funding_source
   SET reserved_minor = reserved_minor + :amount
 WHERE tenant = :tenant AND id = :id
   AND (budget_minor IS NULL OR budget_minor - reserved_minor - spent_minor >= :amount);
-- changes === 0 means refused, and nothing was written
```

**Exclusive section** — take a write lock for the read and the write together.
`BEGIN IMMEDIATE` in SQLite, `SELECT ... FOR UPDATE` in Postgres, a mutex in the
memory adapter. This is what `tryConsume` does, because a `LimitSpec` has five
independent constraints and expressing all of them in one `WHERE` clause would
be unreadable.

What is **never** acceptable: read the counters, check in application code,
write. `test/concurrency.test.ts` contains a negative control that demonstrates
exactly that pattern over-admitting.

### 2. Composite operations must be transactional

`PlatformStore.transaction(work)` must make every store call inside `work`
atomic, and roll all of it back on an `Err` return or a throw.

Five operations depend on it:

| Operation | Touches |
| --- | --- |
| `reserve` | counters, funding, executions, audit |
| `capture` | ledger, funding, executions, audit |
| `release` | funding, counters, executions, audit |
| `reverse` | ledger, funding, counters, executions, audit |
| `issue` | counters, grants, audit |

A partial capture — ledger entries written with no execution, or budget spent
with no entries — is the worst outcome this platform can produce.

---

## Per-port requirements

### ValueExchangeStore

- Index on `(tenant, state)` — `find` with `state: "active"` is the hottest read
  on the decision path.
- Index on `(tenant, upper(acquisition.code))` for `byCode`.
- Exchanges are immutable between versions. **Cache them hard.** Invalidate on
  publish.

### GrantStore

- Index on `(tenant, subjectId)` and `(tenant, upper(code))`.

### CounterStore

- `read` is explicitly advisory and may be served from a replica.
- `tryConsume` and `tryIssue` are authoritative and must not be.
- `subjectRecent` must be **bounded**. Both shipped adapters prune by the window
  any limit actually uses and by a hard cap of 512 rows
  (`limit-rules.pruneRecent`). Without this it is the table that grows forever.
- Reuse `findBreach` from `src/adapters/limit-rules.ts` rather than
  re-implementing the rules, so "which limit blocked this" has one answer.

### FundingStore

`reserved` and `spent` have the same atomicity requirement. A reservation that
reads a budget, checks headroom and writes a hold can be raced into overdraft.

### ExecutionStore

- **Unique index on `(tenant, idempotencyKey)`.** This is what makes retries
  safe; without it, two concurrent identical requests both create executions.
- Append-heavy. Partition by time.

### LedgerStore

- Append-only. No updates, ever — a correction is a contra entry.
- Index on `(tenant, accountId, amount.unit)` for reconciliation.
- Index on `(tenant, reference.id)` for reversal.
- Partition by time. This is the table that grows without bound.

### AuditStore

- Append-only, serial per tenant — each record depends on the previous hash.
- Unique index on `(tenant, seq)`.
- `verify()` is O(n) from genesis. **Checkpoint**: store a verified head hash
  and sequence number periodically, and verify forward from there.

---

## Transaction boundaries

Two operations must be atomic across several ports.

**Reserve** — funding holds, counters and the execution record must commit
together, or a crash leaves budget held against an execution nobody knows about:

```
BEGIN
  for each allocation: UPDATE funding SET reserved = reserved + ?   -- conditional
  for each exchange:   UPDATE counters ...                          -- conditional
  INSERT execution
  INSERT audit
COMMIT
```

**Capture** — ledger entries, funding spend and the execution state:

```
BEGIN
  INSERT ledger entries (all of them, or none)
  UPDATE funding SET reserved = reserved - ?, spent = spent + ?
  UPDATE execution SET state = 'captured'
  INSERT audit
COMMIT
```

A partial capture is the worst outcome available: budget consumed with no
ledger entries, or ledger entries with no execution.

---

## Suggested schema sketch (PostgreSQL)

```sql
CREATE TABLE value_exchange (
  tenant text NOT NULL,
  id text NOT NULL,
  version int NOT NULL,
  state text NOT NULL,
  profile text NOT NULL,
  document jsonb NOT NULL,       -- the whole record
  code_upper text GENERATED ALWAYS AS (upper(document->'acquisition'->>'code')) STORED,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX ON value_exchange (tenant, state);
CREATE INDEX ON value_exchange (tenant, code_upper) WHERE code_upper IS NOT NULL;

CREATE TABLE counters (
  tenant text NOT NULL,
  value_exchange_id text NOT NULL,
  issued bigint NOT NULL DEFAULT 0,
  redemptions bigint NOT NULL DEFAULT 0,
  granted jsonb NOT NULL DEFAULT '{}',   -- per unit, minor units as text
  PRIMARY KEY (tenant, value_exchange_id)
);

CREATE TABLE ledger_entry (
  tenant text NOT NULL,
  id text NOT NULL,
  transaction_id text NOT NULL,
  account_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  unit text NOT NULL,
  minor numeric(38,0) NOT NULL CHECK (minor >= 0),
  scale int NOT NULL,
  at text NOT NULL,
  reference_kind text NOT NULL,
  reference_id text NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX ON ledger_entry (tenant, account_id, unit);
CREATE INDEX ON ledger_entry (tenant, reference_id);
```

Storing amounts as `numeric(38,0)` plus a separate `scale` keeps them exact and
avoids a float round-trip. Do **not** use `money` or `float`.

---

## Testing an adapter

Add one line to `test/_adapters.ts`:

```ts
export const ADAPTERS: AdapterUnderTest[] = [
  { name: "memory", create: () => new MemoryPlatformStore() },
  { name: "sqlite", create: () => new SqlitePlatformStore({ location: ":memory:" }) },
  { name: "postgres", create: () => new PostgresPlatformStore({ url: TEST_URL }) },  // yours
];
```

That immediately subjects it to:

- **`test/adapter-conformance.test.ts`** — 11 end-to-end behaviours: round-trip
  fidelity, bigint precision, code lookup, full redeem, release, reversal, audit
  verification, atomic issuance, touchpoint persistence, transaction rollback,
  tenant isolation.
- **`test/concurrency.test.ts`** — 5 concurrency properties, including the Phase
  1 exit criterion.
- **`test/reaper.test.ts`** — 6 reaper behaviours.

An adapter is not done when it compiles. It is done when it passes those.

The one thing the suite cannot cover for you, because it needs a real crash:

- A process kill between the ledger insert and the execution update. Verify by
  hand that recovery leaves a consistent state, and that
  `capabilities.settle()` still reports `balanced: true`.

For the shipped SQL adapter — dialects, the driver port and wiring a real
driver — see [SQL adapters](11-sql-adapters.md).
