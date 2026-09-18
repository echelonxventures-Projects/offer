# SQL adapters

One store, every SQL database. What a deployment has to supply, and what it gets.

| | |
| --- | --- |
| Module | `src/adapters/sql/` |
| Dialects | `sqlite`, `postgres` |
| Verified by | The full conformance and concurrency suite, against both |
| Decided in | [ADR 0021](../06-adr/0021-the-driver-is-a-port.md) |

---

## The driver is a port

Node ships a SQLite driver and nothing else. A Postgres adapter has to get its
driver from somewhere, and depending on `pg` would end the zero-dependency
promise for **every** deployment — including the ones using SQLite — while also
choosing a driver on their behalf.

So the driver is a port. Four methods:

```ts
export interface SqlClient {
  query(sql: string, params?: readonly unknown[]): Promise<SqlRow[]>;
  execute(sql: string, params?: readonly unknown[]): Promise<number>;
  script(sql: string): Promise<void>;
  close?(): Promise<void>;
}
```

A deployment brings whatever it already runs — `pg`, `postgres.js`, a pooled
connection, a serverless HTTP driver — and wraps it. The adapter never knows
which, and cannot reach a driver-specific feature, because the moment it can it
stops being portable.

### Wiring `pg`

```ts
import { Pool } from "pg";
import { SqlPlatformStore, POSTGRES_DIALECT } from "goip";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const client = {
  async query(sql, params = []) { return (await pool.query(sql, [...params])).rows; },
  async execute(sql, params = []) { return (await pool.query(sql, [...params])).rowCount ?? 0; },
  async script(sql) { await pool.query(sql); },
  async close() { await pool.end(); },
};

const store = await SqlPlatformStore.open({ client, dialect: POSTGRES_DIALECT });
```

That is the whole integration. `postgres.js` and the serverless drivers are the
same shape with different method names.

### SQLite, with no wiring at all

```ts
import { SqlPlatformStore, NodeSqliteClient, SQLITE_DIALECT } from "goip";

const store = await SqlPlatformStore.open({
  client: new NodeSqliteClient("./goip.db"),
  dialect: SQLITE_DIALECT,
});
```

---

## One schema

`src/adapters/sql/schema.ts` holds the DDL **once**. The dialect substitutes
four type names; the indexes are not negotiable.

There is deliberately no second copy. Two copies drift — one gains an index the
other does not, and two adapters that were meant to be the same store quietly
stop being it. Substituting four type names is a much smaller price.

| Template | SQLite | Postgres |
| --- | --- | --- |
| `{{text}}` | `TEXT` | `TEXT` |
| `{{integer}}` | `INTEGER` | `BIGINT` |
| `{{money}}` | `INTEGER` | `NUMERIC(38,0)` |
| `{{real}}` | `REAL` | `DOUBLE PRECISION` |

### Why money is a column type and not just a document field

Records are stored as JSON documents through the wire codec, so `bigint`
survives exactly. But the *arithmetic* columns — budget, reserved, spent,
granted — have to be real numeric columns, because the conditional updates that
make reservation atomic compare them in SQL:

```sql
UPDATE funding_source
   SET reserved_minor = reserved_minor + ?
 WHERE tenant = ? AND id = ?
   AND (budget_minor IS NULL OR budget_minor - reserved_minor - spent_minor >= ?)
```

The headroom test lives in the `WHERE` clause, so there is no window between
checking and writing. Zero rows affected means the check failed and nothing was
written.

**SQLite's ceiling is real.** Its only integer type is 64-bit signed, bounding a
single funding source at ~9.2e18 minor units: 92 trillion at scale 2, 9.2
billion at scale 6. That was accepted deliberately — atomicity is worth more
than headroom nobody will use. **Postgres gives up neither**, because
`NUMERIC(38,0)` does the same arithmetic without the limit.

---

## What differs between dialects

Five things, and they are all the dialect knows about.

| | SQLite | Postgres |
| --- | --- | --- |
| Placeholders | `?` | `$1`, `$2`, … |
| Column types | above | above |
| Opening a write | `BEGIN IMMEDIATE` | `BEGIN` |
| Scalar maximum | `MAX(a, b)` | `GREATEST(a, b)` |
| Setup | two `PRAGMA`s | none |

Queries are written with `?` whatever the dialect, and the session renumbers
them, so the SQL in the store reads the same for every database.

**Why the transaction verbs differ.** SQLite needs `BEGIN IMMEDIATE` to take the
write lock up front; a plain `BEGIN` defers it and turns a concurrent
check-and-consume into `SQLITE_BUSY` at `COMMIT`, after the decision has already
been made. Postgres takes row locks as it goes, so a plain `BEGIN` is right
there.

### Two SQLite-isms that had to go

Both were in the code that bounds the rolling-window table:

- **`rowid`** has no portable equivalent. `counter_recent` now carries an
  explicit `seq`, assigned inside the write transaction exactly the way the
  ledger assigns its own. It also fixed a latent correctness point: undoing "the
  most recent redemption" by timestamp cannot choose between two in the same
  second, and by insertion order it can.
- **`LIMIT -1 OFFSET n`** is SQLite spelling. The prune now names the rows to
  keep with a plain `LIMIT` and deletes the rest.

---

## Reading integers exactly

Drivers disagree about what an integer column is, and this is the one place a
portable adapter can go quietly and badly wrong.

`node:sqlite` returns a bigint when asked. Postgres drivers return `BIGINT` and
`NUMERIC` as **strings**, because neither fits a JavaScript number — which is
correct of them and a trap for anything that assumes otherwise. Money here is
exact, so a silent trip through a float would be the worst available bug: small
values look fine and large ones are wrong.

So every integer column is read through `dialect.toBigInt`, which accepts a
bigint, a string or an exactly-representable number, and **throws** on a
non-integer number rather than rounding it.

---

## Choosing one

| | SQLite | Postgres |
| --- | --- | --- |
| Setup | None. It is built into Node | A server, and a driver you supply |
| Writers | One process | Many |
| Money ceiling | ~9.2e18 minor units | None in practice |
| Right for | Development, tests, single-process deployments, edge | Anything multi-process |

SQLite is not a toy here — it is genuinely transactional and it is what the
concurrency tests run against. It is single-writer, and that is the whole of the
difference.

---

## Migrations

`SqlPlatformStore.open` creates the schema by default, using `CREATE TABLE IF
NOT EXISTS`. A deployment that owns its migrations passes `createSchema: false`
and runs `schemaStatements(dialect)` through its own tool.

There is no migration framework and no versioning of the schema. See
[known gaps](../08-roadmap/02-known-gaps.md).

---

## Related

- [Persistence](01-persistence.md) — what any adapter must guarantee
- [Concurrency and scaling](02-concurrency-and-scaling.md) — where this breaks under load
- [ADR 0021](../06-adr/0021-the-driver-is-a-port.md) — why the driver is injected
