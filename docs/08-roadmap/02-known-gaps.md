# Known gaps

Everything missing, listed plainly. Severity is the risk of running without it,
not the effort to build it.

---

## Closed in Phase 2

| Was | Now |
| --- | --- |
| No metrics or traces | A vendor-neutral telemetry port, 29 catalogued metrics, instrumented across decision, context, eligibility, execution and funding |
| No health endpoint | Four integrity checks: ledger balance, audit verification, funding headroom, stale reservations |
| `audit.verify()` O(n) from genesis | Checkpointing; `verify(tenant, fromSeq)` resumes from a stored, verified point |
| No external audit anchoring | `AuditAnchor` port; a test forges a self-consistent chain and proves the anchor still catches it |
| No alerting | Seven rules, each with a mandatory runbook link, evaluated on deltas rather than totals |
| Nothing ran periodically | Five maintenance jobs behind a scheduler-agnostic runner |

Verified by `test/observability.test.ts` (26), `test/maintenance.test.ts` (22)
and `examples/08-operations.ts`.

## Closed in Phase 1

Kept here rather than deleted, because a gap list that only ever grows tells you
nothing about whether the work is moving.

| Was | Now |
| --- | --- |
| No reservation reaper | `platform.reaper.sweep()`, bounded, idempotent, audited. 12 tests. |
| Counter mutation not atomic | The port has no read-check-write shape left. [ADR 0011](../06-adr/0011-no-read-check-write-in-the-port.md) |
| Funding reservation not atomic | `tryReserve` — conditional `UPDATE ... WHERE headroom >= ?` |
| No durable storage | SQLite adapter on built-in `node:sqlite`. [ADR 0012](../06-adr/0012-sqlite-as-the-reference-durable-adapter.md) |
| No transaction boundaries | Reserve, capture, release, reverse and issue each run in one transaction |
| Attribution in memory | `TouchpointStore`; survives a restart |
| Funding sources not tenant-scoped | Keyed `(tenant, id)` |
| `recentBySubject` unbounded | Pruned by window and by a hard cap of 512 rows |
| `audit.verify()` O(n) from genesis | `verify(tenant, fromSeq)` resumes from a checkpoint |
| No async ports | Every port returns a promise |

Verified by `test/concurrency.test.ts` (12 tests, both adapters, with a negative
control) and `test/adapter-conformance.test.ts` (22 tests, both adapters).

---

## Critical — do not run in production without these

### No authentication or authorisation
Capabilities accept an `actor` string and trust it. Any caller may invoke any
capability for any tenant.

**Consequence:** anyone who can reach `redeem` can grant themselves benefits.

### No PostgreSQL adapter
SQLite is the only durable adapter. It is genuinely transactional and it proves
the ports, but it is single-writer and its arithmetic columns are 64-bit.

**Consequence:** not suitable for a high-throughput multi-process deployment.
**Mitigation:** the conformance suite is ready; a Postgres adapter is one entry
in `test/_adapters.ts` away from being held to the same standard.

### Nothing triggers maintenance
`platform.maintenance.runDue(tenant, now)` runs every periodic job — the sweep,
checkpointing, anchoring, reconciliation and health. Nothing calls it on a timer,
because the platform deliberately does not own one.

**Consequence:** budget still leaks if the deployment forgets to schedule it.
It is now one call from any scheduler rather than unwritten code.
**Fix:** a cron entry, a `setInterval`, or a Kubernetes CronJob. See
[maintenance](../07-operations/07-maintenance.md).

## High — will cause an incident

### No rule preview before publishing
`validate` checks policy, not rule semantics. A condition comparing a string to
money passes review and fails at runtime with `RULE_ERROR`.

**Consequence:** a campaign silently delivers nothing until somebody notices.
**Fix:** evaluate conditions against sample contexts at publish time.

### No registry bundle versioning
Decisions do not record which registry version produced them.

**Consequence:** a decision cannot be replayed exactly once registries change,
which weakens dispute resolution — the thing the audit chain exists for.

---

## Medium — real limitations, work around them

### Time zones are fixed offsets
No political daylight-saving rules. An offer ending at "local midnight" across a
DST boundary will be wrong by an hour twice a year.
**Workaround:** register a zone-rule provider, or use UTC boundaries.

### No multi-hop exchange rates
`USD → EUR` requires a direct or invertible rate. No `USD → GBP → EUR`.
**Deliberate** — chained conversions compound rounding and nobody can explain
the result. Register direct rates.

### Cross-unit ranking is not possible
An offer granting points scores zero against one giving money off. The tie-break
stops it losing to nothing, but the two cannot be compared. See
[ADR 0010](../06-adr/0010-no-implicit-unit-conversion.md).

### Mixed-unit carts are not supported
Every cart line must be in the context unit.

### Stacking above 10 eligible offers is greedy
Not optimal, and honestly reported as `searchMode: "greedy"`. See
[ADR 0003](../06-adr/0003-bounded-stacking-search.md).

### One subject per decision
A household allowance shared by four people is modelled by making the account
the subject. It works; it is a workaround.

### Search is substring matching
Fine for hundreds of offers. Beyond that, index externally.

---

## Low — nice to have

### No graph projection
Every edge in [the incentive graph](../01-architecture/06-incentive-graph.md) is
derivable from stored fields, but no projector is built.

### No analytics or reporting layer
The data is in the ledger and the audit chain. Nothing reads it.

### No layering enforcement
Upward imports are prevented by review and two grep tests. A
dependency-cruiser rule would make it structural.

### No distributed tracing
Metrics and structured events, but no spans. Propagating trace context across
async boundaries is a real feature, not four methods. `correlationId` threads
through contexts, decisions and audit records and covers most of what tracing
would be used for here.

### Maintenance last-run times are in process
A multi-process deployment runs every job on every instance. The jobs are
idempotent so it is wasteful rather than dangerous.
**Fix:** run maintenance on a single instance, take a lease, or use a scheduler
that guarantees single execution. See
[maintenance](../07-operations/07-maintenance.md).

### No metrics exporter
The catalogue makes writing one mechanical — `describeMetrics()` emits name,
type, unit, help and labels — but no Prometheus or OTel adapter ships.

### No distribution
No email, SMS, push or partner feeds. Deliberate scope boundary.

### No learned models
No recommendation, forecasting or generation beyond linear extrapolation.
`forecast` returns `null` rather than a confident number when there is no
history.

### `visibility` is arguably misnamed
It governs discovery only. `discoverability` would be clearer. Not renamed
because it is the specification's term and is already in the stored shape. Worth
deciding before a first production release. See
[ADR 0008](../06-adr/0008-visibility-is-not-applicability.md).

---

## Not gaps — deliberate scope boundaries

Listed so they are not mistaken for oversights.

| Not built | Why |
| --- | --- |
| Payment execution | The platform records obligations; moving money is a provider's job |
| Identity management | Subjects are opaque ids supplied by the caller |
| Product catalogue | Cart lines carry what is needed |
| CRM / CDP | Segments arrive as context |
| Email / SMS delivery | The platform decides what a channel shows, not how it is sent |
| A blockchain | Solves a trust problem that does not exist here |

---

## How to read this list

Before Phase 1 the critical section was six items, five of which were the same
underlying thing: the storage layer was a reference implementation pretending to
be a contract.

That is now closed. Storage is durable, atomic and conformance-tested against
two adapters, and the claims are backed by concurrency tests with a negative
control rather than by prose.

Phase 2 closed the operational gaps: nothing now fails silently, and every
failure mode in the runbook has a metric, a health check or an alert behind it.

What remains critical is different in kind: **there is no identity layer**, the
durable adapter is single-writer, and nothing triggers maintenance. None is a
design flaw — all are unwritten work, and [the roadmap](01-phases.md) sequences
them.

The other honest limitation is the one the whole list should be read against:
this is a reference implementation with a conformance suite, not a deployed
system. It has never carried production traffic.
