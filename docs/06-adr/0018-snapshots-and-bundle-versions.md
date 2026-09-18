# ADR 0018 — Snapshots and bundle versions

**Status:** Accepted · **Date:** 2026-09-18 · **Phase:** 5

## Context

Phase 5 was meant to be about scale. An audit found that two of the things
carrying the most risk were not really about volume at all.

**Reconciliation folded the entire ledger, every time.** `settle()`, `pay()` and
— worst — the `ledger` health check all called `ledger.all(tenant)` and summed
from the beginning. The ledger is append-only and the fastest-growing table in
the system, so this got slower every day and never got faster. The health check
runs every minute: the check designed to catch problems was on its way to
becoming one.

This is the same defect the audit chain had before checkpointing, in the one
place where it costs the most.

**Decisions did not record which registries produced them.** A decision is a
pure function of its context *and* the loaded registries. The context trace was
recorded; the registry state was not. So re-running a decision from months ago
could legitimately differ because a benefit type had been added, and nothing
would say so — which is exactly the moment an investigation draws the wrong
conclusion from a true observation.

## Decision

**Ledger snapshots.** A `LedgerSnapshot` records netted balances as of a
sequence number. `ReconciliationService.positions()` starts from the latest
snapshot and folds only what came after it, in bounded batches. A
`ledger.snapshot` maintenance job records one hourly.

Three properties make it safe to cache a financial figure:

- **Derived, never authoritative.** Delete every snapshot and the answer is
  identical; it is recomputed from the entries.
- **Refuses to snapshot an imbalance.** A snapshot asserts that the balances up
  to that point are trusted. Recording one over a hole would make the hole
  permanent — every later reconciliation would inherit it without ever
  rescanning the entries that would reveal it.
- **`verify()` does not depend on a snapshot being correct.** It derives from
  the same fold, so health still detects an imbalance that appeared before the
  last snapshot.

**Bundle versions.** `computeBundleVersion()` hashes every registry's keys into
a short, deterministic id. Decisions and `execution.reserved` audit records
carry it. `replayDecision()` re-runs a decision and reports four distinct
outcomes rather than a boolean.

Cheap on the hot path: every `Registry` carries a monotonic `revision` counter,
so the platform re-hashes only when something actually changed, and otherwise
sums 28 integers.

## Consequences

**Good**

- `settle()` after a snapshot folds **zero** entries, and reports
  `foldedEntries` so the cost is visible rather than assumed.
- The health check stops degrading.
- A disputed decision can be replayed, and the result distinguishes "did not
  reproduce" from "did not reproduce, and the rules changed" — which is the
  difference between an incident and an explanation.
- `settle()` now returns `throughSeq`, so a caller knows exactly which entries
  its answer includes.

**Bad**

- `settle()`'s shape changed: `entries` became `throughSeq` and `foldedEntries`.
  A caller wanting a total entry count now has to ask for it.
- Snapshots are per tenant and single-row. A tenant with very high write volume
  will find the hourly job folding a lot; the fix is more frequent snapshots,
  which is a config change, not a redesign.
- **Bundle versions hash keys, not behaviour.** Editing a benefit handler's
  arithmetic without touching its key produces the same version. That is a real
  limit and it is documented at the top of `bundle.ts`: the version is evidence,
  and it pairs with the deployment's own build identifier, which is what changes
  when code changes.

## The bug this produced, and what it taught

`bundle` was initially part of the hashed decision body. Every decision then
failed to reproduce whenever *any* registry changed — including a registration
entirely unrelated to that decision.

That collapsed two genuinely different questions into one: *did this decision
reproduce?* and *was the platform running the same rules?* The whole value of
recording the bundle is being able to answer them separately, and to say that an
unrelated registration did not affect the outcome.

So `bundle` is recorded but **not hashed**. It is provenance, not content. The
test that caught it asserts exactly that: an unrelated registration must change
the bundle and must not change the decision.

## What replay deliberately does not do

**It does not store contexts.** They contain customer data and are the largest
thing per decision by an order of magnitude; retaining every one to make replay
convenient would be the wrong trade in both directions. The caller supplies the
context from its own records.

What the platform guarantees is narrower and more useful: the same context,
under the same bundle, at the same instant, reproduces the same decision byte
for byte. The clock is pinned from the recorded instant, because replaying a
weekend-only offer against today's date produces a meaningless answer.

## Alternatives considered

**Materialised balances updated on every write.** Rejected: it makes the ledger
write path do two things, and a bug in the increment is unrecoverable because
nothing rescans. A derived snapshot is recomputable by construction.

**Versioning registries individually.** Rejected for the decision record: a
decision may touch a dozen registries, and a dozen version strings per decision
is worse than one hash plus a `compareBundles` that reports which registries
moved.

**Storing the full context with each decision.** Rejected on privacy and volume,
as above.
