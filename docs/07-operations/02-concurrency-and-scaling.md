# Concurrency and scaling

Where this design holds under load, and where it does not.

---

## What is safe to parallelise

| Operation | Safe | Why |
| --- | --- | --- |
| `apply` / `discover` / `compare` | Fully | Pure functions of context and registry state |
| `simulate` | Fully | Non-binding by definition |
| `create` / `clone` / `validate` | Fully | Independent records |
| `settle` | Read-only | Consistent snapshot is enough |

Read-path scaling is horizontal and unremarkable: registries are immutable
configuration, active exchanges are cacheable, and context resolution is
per-request.

## What is not

| Operation | Contention | Mitigation |
| --- | --- | --- |
| `reserve` | Counters and budgets for the same exchange | Conditional updates; see [persistence](01-persistence.md) |
| `capture` | Funding rows | Same |
| `audit.append` | Serial per tenant by construction | Per-tenant chains; batch within a transaction |

## The hot row problem

A popular offer is one row in `counters` and one in `funding`. Every reservation
touches both. At high rates that row is the bottleneck, and it is the row for
the offer that matters most.

Three mitigations, in increasing order of complexity:

**1. Conditional updates.** Push the limit check into the `UPDATE ... WHERE`.
Removes the read-check-write gap and lets the database serialise rather than the
application. Do this first; it is often enough.

**2. Sharded counters.** Split a limit of 10 000 into ten rows of 1 000. Writes
spread; reads sum. Costs accuracy at the boundary — a shard can be exhausted
while others have room — so use it for large limits where being 0.1% under is
acceptable, never for a limit of one.

**3. Reservation batching.** For very high rates, pre-allocate blocks of
redemptions to application instances. Highest throughput, weakest guarantees,
and the accounting to return unused blocks is real work.

## Audit chain throughput

The chain is serial within a tenant: each record needs the previous hash.

- **Per-tenant chains** (as implemented) mean tenants do not block each other.
- Within a tenant, batch appends inside one transaction and compute the chain
  once.
- If a single tenant genuinely saturates it, shard by `(tenant, reality)` or by
  `(tenant, month)`, accepting several chains to verify instead of one.

Do not make the chain global. It would be a platform-wide serialisation point.

## Ledger growth

The ledger is append-only and grows faster than anything else in the system.
Anything that folds it from genesis gets slower every day and never faster.

Three callers needed netted balances — `settle`, `pay` and the `ledger` health
check — and all three did exactly that. Health runs every minute, so the check
designed to catch problems was on its way to becoming one.

Reconciliation now folds forward from a snapshot in bounded batches, the same
shape as audit checkpointing one layer up:

| Read | Cost |
| --- | --- |
| `reconciliation.positions` | Entries since the last snapshot, in pages of 5000 |
| `settle` | The same fold; reports `throughSeq` and `foldedEntries` |
| `health.check` (ledger) | The same fold — bounded, not proportional to history |

Watch `foldedEntries`. If it climbs, snapshot more often; that is
`intervalSeconds` on the `ledger.snapshot` job, not a code change.

Snapshots are derived and never authoritative — delete them all and the answer
is identical. What they must never do is record an imbalance, because a snapshot
is a claim that the balances up to that point are trusted, and later folds start
after it. `snapshot()` therefore verifies first and refuses. See
[reconciliation and replay](10-reconciliation-and-replay.md).

Partitioning the ledger itself is still not built. Snapshots change the cost of
*reading* it, not of storing it.

## Registry distribution

Registries are immutable configuration and should be:

- Loaded at startup and **sealed**.
- Versioned as a bundle, so every node can state which version it is running.
- Distributed by publishing a new bundle, not by mutating a live registry.

A decision made under bundle *v41* should record that, so a replay uses the same
rules. Bundle versioning is **not implemented** and is in
[known gaps](../08-roadmap/02-known-gaps.md).

## Latency budget

Rough shape of a decision, excluding I/O:

| Step | Cost |
| --- | --- |
| Context resolution | Dominated by resolvers; core resolvers are microseconds |
| Eligibility, per candidate | ~10 checks, plus rule evaluation |
| Rule evaluation | Bounded by the node budget (5 000) |
| Stacking, exhaustive | Up to 2¹⁰ subsets × benefit resolution |
| Decision hash | One SHA-256 over the canonical form |

The two that can surprise you:

**A resolver making an external call.** It lands directly in your p99. Measure
each resolver separately — the context trace gives you the structure to do it.

**Stacking at the exhaustive limit.** 1 024 subsets each requiring a full
benefit resolution. Usually milliseconds, but it is the step that grows fastest.

## Cache strategy

| Data | Cacheable | Invalidate on |
| --- | --- | --- |
| Registries | Aggressively; seal them | Bundle publish (restart) |
| Active exchanges | Yes | Publish, pause, expiry |
| Spatial paths | Yes (already cached in the authority) | `spatial.invalidate()` |
| Counters | **No** | — |
| Funding | **No** | — |

The rule: cache what is immutable between versions, never what is a limit.

## Where it genuinely breaks

Stated plainly.

**A global limit across regions.** Either one authoritative counter (latency on
every reserve) or per-region sub-budgets (inaccuracy at the boundaries). There
is no third option, and the choice is a business one.

**More than ~10 simultaneously-eligible offers.** Stacking degrades to greedy.
The fix is usually campaign hygiene rather than engineering — see
[ADR 0003](../06-adr/0003-bounded-stacking-search.md).

**An unbounded `recentBySubject`.** The reference adapter appends timestamps
without pruning. A real adapter must bound it.

**Stale reservations.** Nothing expires them. Without a reaper, an abandoned
checkout holds budget forever. This is the most likely first production
incident, and it is in [known gaps](../08-roadmap/02-known-gaps.md).
