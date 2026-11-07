# Known gaps

Everything missing, listed plainly. Severity is the risk of running without it,
not the effort to build it.

---

## Closed in Phase 7

| Was | Now |
| --- | --- |
| **No PostgreSQL adapter** | `SqlPlatformStore` with a `postgres` dialect, verified against a real server |
| **Depending on a driver would end zero dependencies** | The driver is a port; a deployment brings its own |
| SQLite's 64-bit ceiling on a funding source | `NUMERIC(38,0)` on Postgres, keeping atomic reservation |
| Two SQL adapters would have meant two schemas | One schema, four substituted type names |
| `rowid` and `MAX(a,b)` were quietly SQLite-only | Portable in both, and the rewrite fixed an ordering ambiguity |
| A bare `ORDER BY` on text was codepoint order on SQLite and locale order on Postgres | The dialect renders text sorts; both adapters now agree on mixed-case ids, and a guard keeps it |

Verified by the conformance and concurrency suites running against Postgres:
25 concurrent reservations still admit exactly one.
[ADR 0021](../06-adr/0021-the-driver-is-a-port.md).

## Closed in Phase 6

| Was | Now |
| --- | --- |
| **No graph projection** | `GraphProjector`, bounded and honest about truncation, plus the six named queries |
| **"Which campaigns never delivered anything" was unanswerable** | `neverDelivered(projection)` — nothing else in the platform notices a campaign that quietly does nothing |
| **Ranking was a closed union with a `switch` in the engine** | `discovery-ranking` and `ranking-feature` registries |
| **"Register a learned model as a signal" was a claim** | Scorecards: fitted elsewhere, loaded as data, one contribution per feature |
| No budget planning | `planAllocation`, advisory, exact to the minor unit, with a reason per line |
| Alerting only caught thresholds you predicted | Anomaly detection over the chain, on median and MAD |
| **`localeCompare` in 20 places, several on the decision path** | One codepoint comparator; a conformance test proves both adapters now agree |
| The chain recorded that a reservation happened, not what for | `execution.reserved` carries the exchanges that applied |
| The audit chain had no resumable forward scan | `AuditStore.range` |

Verified by `test/intelligence.test.ts` (34), `test/ranking.test.ts` (14),
`examples/12-intelligence.ts`,
[ADR 0019](../06-adr/0019-analysis-is-a-downstream-layer.md) and
[ADR 0020](../06-adr/0020-codepoint-ordering.md).

## Closed in Phase 5

| Was | Now |
| --- | --- |
| **`settle`, `pay` and health rescanned the whole ledger** | Snapshot-backed fold, in bounded batches, reporting how much it folded |
| **Decisions did not record which registries produced them** | Every decision and reservation carries a bundle version |
| **A decision could not be replayed once registries changed** | `replayDecision` — and it distinguishes "did not reproduce" from "the rules changed" |
| No way to say what changed between two registry states | `compareBundles` names the registries that moved |
| `settle` did not say what it had counted | Returns `throughSeq` and `foldedEntries` |

Verified by `test/reconciliation.test.ts` (20), `test/replay.test.ts` (17),
`examples/11-scale.ts` and
[ADR 0018](../06-adr/0018-snapshots-and-bundle-versions.md).

## Closed in Phase 4

| Was | Now |
| --- | --- |
| **No rule preview before publishing** | `rules.evaluable` policy: an unevaluable condition blocks publication |
| `validate` checked policy, not semantics | It runs preview, and works on an unsaved draft |
| No way to review a revision | `compareVersions` classifies each change by effect on exposure |
| Decisions were data, not answers | `explainDecision` / `explainOffer` / `explainPreview` render them |
| A cart condition broke discovery | An absent operand is false, not an error |
| Failed conditions said "4 nodes evaluated" | They name the predicate that decided |

Verified by `test/authoring.test.ts` (25 tests) and `examples/10-authoring.ts`.

## Closed in Phase 3

| Was | Now |
| --- | --- |
| **No authentication** | API keys (hashed, constant-time) and HMAC tokens, behind a port |
| **No authorisation** | Roles as a registry, checked per capability and per tenant |
| **`actor` was a trusted string** | Overridden from the authenticated principal; the body cannot name the actor |
| **No rate limiting** | Per source before auth, per principal after |
| No transport | `node:http` adapter over a transport-neutral gateway |
| No API contract | OpenAPI generated from the capability descriptors |
| Audit recorded the subject as actor | Records the caller; the subject is in the payload |

Verified by `test/api.test.ts` (41 tests) and `examples/09-api.ts`.

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


### Nothing triggers maintenance
`platform.maintenance.runDue(tenant, now)` runs every periodic job — the sweep,
checkpointing, anchoring, reconciliation and health. Nothing calls it on a timer,
because the platform deliberately does not own one.

**Consequence:** budget still leaks if the deployment forgets to schedule it.
It is now one call from any scheduler rather than unwritten code.
**Fix:** a cron entry, a `setInterval`, or a Kubernetes CronJob. See
[maintenance](../07-operations/07-maintenance.md).

---

## Medium — real limitations, work around them

### No migration framework
`SqlPlatformStore.open` runs `CREATE TABLE IF NOT EXISTS`. There is no schema
version, no upgrade path and no down migration.
**Consequence:** a future schema change has no mechanism behind it.
**Workaround:** pass `createSchema: false` and run `schemaStatements(dialect)`
through the migration tool the deployment already has.

### Two SQLite adapters exist
`SqlitePlatformStore` (synchronous, original) and `SqlPlatformStore` with the
`sqlite` dialect do the same job. Both pass conformance, and both are in the
adapter list so they are held to it.
**Consequence:** duplication, which is the drift risk this project argues
against everywhere else.
**Fix:** retire the synchronous one once the generic store has been exercised
longer. Deliberately not done in the same change that introduced the generic
store, because replacing a tested component and proving its replacement in one
step leaves nothing to compare against.

### The Postgres driver is yours to supply
Ten lines of wrapper, documented with a working `pg` example. The platform does
not ship one, because shipping one would mean depending on it.
**Consequence:** a deployment cannot go to Postgres without writing that
wrapper. See [SQL adapters](../07-operations/11-sql-adapters.md).

### A bundle version hashes registry keys, not behaviour
Change the arithmetic inside a benefit handler without touching its key and the
bundle version is unchanged.
**Consequence:** a replay can report "same bundle" across a genuine behavioural
change, which is the one conclusion that means *investigate*.
**Mitigation:** a bundle version is evidence, not proof. Record it alongside the
deployment's own build identifier, which is what moves when code moves. Stated
at the top of `src/platform/bundle.ts`.

### Ledger snapshots are per tenant and single-row
One row per tenant holds every account position.
**Consequence:** a tenant with very high write volume will find the hourly job
folding a lot between snapshots.
**Fix:** shorten `intervalSeconds` on `ledger.snapshot`. Configuration, not a
redesign. `foldedEntries` makes the need visible before it hurts.

### Replay requires the caller to supply the context
The platform does not store decision contexts — they hold customer data and are
the largest thing per decision by an order of magnitude.
**Consequence:** a decision whose context was not retained downstream cannot be
replayed, only read.
**Deliberate.** See [ADR 0018](../06-adr/0018-snapshots-and-bundle-versions.md).

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

### No analytics or reporting layer beyond the projection
Phase 6 added a graph projector, the six named queries and anomaly detection.
There is still no scheduled reporting, no warehouse export and no dashboard.
**Consequence:** somebody has to call the projector and read the result.

### A projection is a scan
`graph.project()` reads the audit chain. It is bounded and it reports its cost,
but it is not cheap and it does not belong behind a per-request endpoint.
**Workaround:** project periodically, or over a `fromSeq` window.

### Anomaly detection has no memory
Each scan is independent, so a finding repeats on every run until the window
moves past it.
**Fix:** route findings through the alert engine, which already de-duplicates on
deltas rather than totals.

### A bundle version does not cover a scorecard's weights
Registry bundle versions hash registry keys. A scorecard is data loaded by a
deployment, so changing its weights changes decisions without moving the bundle.
**Fix:** version the weights file yourself and record it alongside the build id.

### Layering enforcement is partial
The analysis layer is enforced structurally: a guard test forbids any engine,
rule, context resolver or ledger module from importing `src/intelligence/`, and
forbids that layer from writing. The remaining upward imports are prevented by
review and two grep tests. A dependency-cruiser rule would make all of it
structural.

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

### No TLS in the HTTP adapter
Plain `node:http`. Terminate TLS in front of it.

### No row-level authorisation
A principal that may `publish` may publish anything in its tenant. Roles are
capability-level only.

### No key rotation workflow
`MemoryApiKeyStore` issues and revokes. Rotating without downtime needs
overlapping validity, which a real store should add.

### The rate limiter is per-instance
With four instances the effective limit is four times the configured one. The
port is one method; a shared store is the fix.

### No authoring console
Deliberately not built: a console is a client, and bundling one would mean
choosing a framework and a build step. The capabilities it needs exist —
`validate` with preview, `compareVersions`, the explanation renderers and a
generated OpenAPI document. See [ADR 0017](../06-adr/0017-preview-as-a-publish-gate.md).

### Preview is only as good as its samples
The shipped context samples are generic and catch structural mistakes, not
business ones. A deployment must replace them with samples drawn from its own
traffic.

### No metrics exporter
The catalogue makes writing one mechanical — `describeMetrics()` emits name,
type, unit, help and labels — but no Prometheus or OTel adapter ships.

### No distribution
No email, SMS, push or partner feeds. Deliberate scope boundary.

### Nothing is trained here
Phase 6 added scorecards, which **execute** a linear model fitted somewhere
else, and ranking features that compose into a recommender. There is still no
training: no gradient descent, no inference over a neural network, nothing that
should be called learning. `forecast` still returns `null` rather than a
confident number when there is no history.
**Deliberate.** Embedding a model runtime would end the zero-dependency,
zero-build promise and buy an unexplainable score in return. See
[intelligence](../09-intelligence/01-overview.md).

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

Phase 3 closed the identity gap, which was the largest. A caller must now
authenticate, is authorised per capability and per tenant, is rate limited, and
cannot name itself as somebody else.

Phase 5 closed the two that would have degraded silently: reconciliation no
longer rescans a table that only grows, and a decision now records the rules it
was made under, so a dispute can be answered rather than argued.

Phase 6 was the one most likely to undo the others, and the work went into a
boundary rather than an algorithm. It also caught the oldest defect in the list:
two storage adapters that had been quietly disagreeing about sort order for
anything mixed-case, hidden by test fixtures that were all lowercase.

What remains critical is one entry: **nothing triggers maintenance**. It is
unwritten work rather than a design flaw, and [the roadmap](01-phases.md)
sequences it.

The other honest limitation is the one the whole list should be read against:
this is a reference implementation with a conformance suite, not a deployed
system. It has never carried production traffic.
