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

## Phase 1b — Make it language-agnostic

**Goal: the contract is portable, not just the storage.**

The implementation is TypeScript and something has to be. What can be neutral is
the *specification*, so a Go or Java or Python implementation can be written and
checked rather than merely intended.

| Work | Why |
| --- | --- |
| JSON Schema for the data model | `ValueExchange` and every part of it, as a language-neutral schema |
| Rule language grammar | The condition AST, written down independently of its evaluator |
| Canonical encoding spec | Hashing and wire form, including the `~bigint:` convention |
| Error vocabulary | The codes, as data |
| **Conformance vectors** | JSON in, expected JSON out, that any implementation must reproduce |
| Capability contract | OpenAPI, generated from the descriptors |

The vectors are the part that makes this real. Documentation of a rule engine is
a wish; a file of inputs and exact expected outputs is a test any language can
run. The pure layers — amounts, allocation, rules, limits, benefit computation,
attribution — are all already free of I/O, which is what makes them
vector-testable.

## Phase 2 — Make it operable

**Goal: run it without watching it.**

| Work | Why |
| --- | --- |
| ~~Reservation reaper~~ | ✅ Done in Phase 1 — `platform.reaper.sweep()` |
| Metrics and traces | Per [observability](../07-operations/04-observability.md) |
| Health endpoint | Ledger balance + audit verification |
| Audit checkpointing | `verify()` from genesis stops scaling |
| External audit anchoring | Makes tamper evidence meaningful against an insider |
| Alerting | The page-level conditions from the observability doc |

**Exit criterion:** a week of synthetic traffic with no manual intervention, and
no outstanding reservations older than the reaper interval.

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
