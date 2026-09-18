# Phases

A sequenced path from this reference implementation to something you could run.

The ordering is deliberate: each phase removes the reason the next one would be
unsafe. Skipping ahead means running a production platform with a known way to
lose money.

---

## Phase 0 — Where this repository is

**Complete and verified.**

- The full pipeline: context → conditions → eligibility → benefit → execution →
  settlement → audit
- 23 registries, 183 entries, 22 capabilities
- 8 benefit types, 8 effects, 6 rule operator families, 5 attribution models
- Exact integer money with remainder-preserving allocation
- Double-entry ledger with balance enforcement
- Hash-chained audit with tamper detection
- Two-phase execution with idempotency
- Governance with policies, lifecycle and separation of duties
- 200 tests, strict typecheck clean, 6 runnable examples
- In-memory persistence only

```bash
npm run verify
```

---

## Phase 1 — Make it durable ✅ **COMPLETE**

**Goal: survive a restart. Nothing else changes.**

| Work | Status |
| --- | --- |
| Async port variants | ✅ Every port returns a promise; engines thread `await` |
| Durable adapter | ✅ SQLite, via built-in `node:sqlite` — see [ADR 0012](../06-adr/0012-sqlite-as-the-reference-durable-adapter.md) |
| **Atomic counters** | ✅ `tryConsume` / `tryIssue`; the check moved inside the port |
| **Atomic funding** | ✅ `tryReserve` uses a conditional `UPDATE ... WHERE headroom >= ?` |
| Transaction boundaries | ✅ Reserve, capture, release, reverse and issue each run in one transaction |
| Durable attribution | ✅ `TouchpointStore`; the in-memory `Map` is gone |
| Adapter conformance tests | ✅ 22 tests × 2 adapters, plus 12 concurrency tests |
| Tenant-scoped funding | ✅ Closed a listed gap: sources are keyed `(tenant, id)` |
| Bounded `recentBySubject` | ✅ Pruned by window and by a hard row cap |
| Reservation reaper | ✅ Pulled forward from Phase 2; it was the top critical gap |

**Exit criterion: met.** `test/concurrency.test.ts` fires 25 concurrent
reservations against a limit of one, through the full capability layer, against
**both** adapters — exactly one is admitted, every run. A negative control in
the same file reproduces the old read-check-write shape and demonstrates it
over-admits under identical load, so the test is not vacuous.

Two design decisions came out of this phase and are written up:
[ADR 0011](../06-adr/0011-no-read-check-write-in-the-port.md) (the port shape)
and [ADR 0012](../06-adr/0012-sqlite-as-the-reference-durable-adapter.md) (the
adapter choice).

**What Phase 1 did *not* do:** a PostgreSQL adapter. The conformance suite now
exists to hold one to account, which is the right order.

## Phase 1b — Make it language-agnostic ✅ **COMPLETE**

**Goal: the contract is portable, not just the storage.**

| Work | Status |
| --- | --- |
| Conformance vectors | ✅ 11 suites, **289 cases**, committed and drift-checked |
| JSON Schema for the data model | ✅ `spec/schema/value-exchange.schema.json`, `rule.schema.json` |
| Canonical encoding spec | ✅ `spec/encoding.md`, including the number-formatting trap |
| Rule language spec | ✅ `spec/rule-language.md` — normative parts only |
| Error vocabulary as data | ✅ `spec/errors.json`, with the normative limit-check order |
| Storage contract | ✅ `spec/storage-contract.md` — the L5 obligations vectors cannot express |
| **Second implementation** | ✅ **Go, L1–L4, passing all 289 cases** |

**Exit criterion: met.** `npm run conformance` runs an independent Go
implementation — no shared code, standard library only — against the same vector
files. It reproduces every case exactly: SHA-256 hashes, all seven rounding
modes over both signs, the allocator's remainder ordering, proleptic Gregorian
and Martian calendars, the full rule evaluator with traces, all eight benefit
handlers, and all five attribution models.

Writing it found two real defects that re-reading the TypeScript would not have:
an operator that was not a pure function of the context, and a vector that could
not survive JSON. Both are written up in
[ADR 0013](../06-adr/0013-conformance-vectors-as-the-portability-contract.md).

**Still open from this phase:** an OpenAPI contract generated from the capability
descriptors. Deferred to Phase 3, where the HTTP layer is built.

What remains TypeScript-specific: L5. Storage and concurrency are specified as
obligations rather than vectors, because no input/output pair can express "and
no other caller observed an intermediate state".

## Phase 2 — Make it operable ✅ **COMPLETE**

**Goal: run it without watching it.**

| Work | Status |
| --- | --- |
| Reservation reaper | ✅ Done in Phase 1 |
| Telemetry | ✅ A four-method port, no vendor SDK, 29 catalogued metrics |
| Instrumentation | ✅ Decision, context (per resolver), eligibility (per check), execution, funding, limits |
| Health | ✅ Four integrity checks: ledger, audit, funding, reservations |
| Audit checkpointing | ✅ `verify(tenant, fromSeq)` resumes from a stored checkpoint |
| External anchoring | ✅ `AuditAnchor` port + memory and append-only-file implementations |
| Alerting | ✅ Seven rules, each with a mandatory runbook link |
| Maintenance | ✅ Five jobs, scheduler-agnostic runner |

**Exit criterion: met.** `examples/08-operations.ts` runs a simulated day —
traffic, abandoned baskets, an exhausted budget, a broken condition — then a
maintenance pass that sweeps, checkpoints, anchors, reconciles and reports. Every
problem surfaces as a metric, a health check or an alert with a runbook link;
none needs a human to notice it.

Writing that example found three bugs the unit tests had happily asserted
around: alerts latching on cumulative counters, an alert paging with a *healthy*
message, and jobs running in alphabetical order so health reported state the
sweep was about to fix. All three are written up in
[ADR 0014](../06-adr/0014-observability-as-ports-not-vendors.md) and pinned by
tests.

**Still open from this phase:** maintenance last-run times are held in process,
so a multi-process deployment runs every job on every instance. The jobs are
idempotent, so this is wasteful rather than dangerous;
[maintenance](../07-operations/07-maintenance.md) sets out the three ways to fix
it. No distributed tracing — `correlationId` is the substitute.

## Phase 3 prelude — The hardcoding audit ✅ **COMPLETE**

Before building the HTTP and identity layer, the codebase was audited for the
shape Law 2 forbids: a comparison against a literal that is really a registry
key.

It found three violations that had survived since Phase 0 — posting rules
branching on `effect.key`, lifecycle routing as a hardcoded `switch`, and
acquisition modes as a closed union — plus four magic numbers. All are fixed,
and a guard in `test/extensibility.test.ts` greps the engines and ledger so the
next one is caught by a test rather than by an audit three phases later.

No behaviour changed: all 303 pre-existing tests passed throughout, which is the
evidence that it was refactoring and not redesign.

The boundary — what genuinely cannot be configuration, and why — is written up
in [what is fixed](../01-architecture/08-what-is-fixed.md) and
[ADR 0015](../06-adr/0015-the-hardcoding-audit.md).

## Phase 3 — Make it reachable

**Goal: other systems can use it.**

| Work | Why |
| --- | --- |
| HTTP API | One endpoint per capability; the mapping is mechanical |
| Authentication | Bind `actor` to a verified identity |
| Authorisation | Per-capability, per the matrix in [security](../07-operations/03-security.md) |
| Rate limiting | Coupon brute-forcing is the obvious attack |
| Bigint serialisation | Decide the wire format; `canonicalize()` is one option |
| OpenAPI schema | Generated from the capability descriptors |
| Client SDK | Typed, from the same descriptors |

**Exit criterion:** an external service integrates using only the published API
and documentation, without reading the source.

## Phase 4 — Make it authorable

**Goal: a campaign manager does not need an engineer.**

| Work | Why |
| --- | --- |
| Authoring console | Build a `ValueExchange` without writing JSON |
| Rule builder | Visual conditions, backed by the operator registry |
| **Rule preview** | Evaluate against a sample context before publishing — closes the `RULE_ERROR` gap |
| Approval workflow | Surface the separation-of-duties gate |
| Simulation UI | `simulate` against replayed traffic |
| Budget dashboard | `forecast` output, per source |

The rule preview is the highest-value item here. It converts the single worst
production failure mode — a broken condition silently delivering nothing — into
a validation error at authoring time.

## Phase 5 — Make it scale

**Goal: survive volume.**

| Work | Why |
| --- | --- |
| Registry bundle versioning | Pin decisions to a rules version; makes replay exact |
| Edge decisioning | `apply` at the edge, `reserve` central |
| Sharded counters | For very large limits |
| Read replicas | The decision path is read-heavy |
| Ledger partitioning | It grows without bound |
| Multi-region | With the sub-budget trade-off made explicitly |

## Phase 6 — Make it clever

**Deliberately last.**

| Work | Why |
| --- | --- |
| Offer recommendation | Beyond ranking by computed value |
| Learned risk model | As a signal, with the explanation surface intact |
| Budget optimisation | Allocation across campaigns |
| Graph projection | Per [the incentive graph](../01-architecture/06-incentive-graph.md) |
| Anomaly detection | On decisions and settlement |

Every one of these is a registry entry or a downstream consumer. None requires
an engine change — which is why it is safe to leave them until last, and why
leaving them until last is the right call. A clever platform that cannot balance
its books is worth less than a dull one that can.

---

## What is not on this roadmap

**Distribution.** Email, SMS, push, partner feeds. The platform decides what a
channel should show; delivering it is a different product.

**Payments.** Moving money. The platform records obligations and stops at the
clearing account. Card rails inside an incentive engine make both unmaintainable.

**A general search engine.** Substring matching over names covers a catalogue of
hundreds. Beyond that, put a real index in front and pass `candidateIds`.
