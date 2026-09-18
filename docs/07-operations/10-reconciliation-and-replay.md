# Reconciliation and replay

Two operational surfaces added in Phase 5: how the ledger answers "what is each
account worth" without rescanning history, and how a past decision is
re-examined when somebody disputes it.

---

## Part 1 — Reconciliation

### The problem it solves

The ledger is append-only and is the fastest-growing table in the system. Three
callers needed netted balances — `settle()`, `pay()` and the `ledger` health
check — and all three loaded every entry and summed from the beginning.

The health check runs every minute. Left alone, the check designed to catch
problems becomes one.

### How it works

`ReconciliationService.positions(tenant)` starts from the latest snapshot and
folds only the entries after it, in pages of `FOLD_BATCH` (5000):

```ts
const positions = await platform.reconciliation.positions("acme");
positions.value.fromSnapshotSeq; // where the fold started
positions.value.foldedEntries;   // how much work it actually did
positions.value.throughSeq;      // the answer is current as of this entry
```

`foldedEntries` is reported rather than inferred. If it climbs, the snapshot job
is not keeping up, and the fix is `intervalSeconds` on the job — configuration,
not code.

### Why caching a financial figure is safe here

Three properties, and all three are load-bearing:

**It is derived, never authoritative.** Delete every snapshot row and the
balances are identical; they are recomputed from the entries. A snapshot is an
optimisation that can always be thrown away.

**It refuses to snapshot an imbalance.** A snapshot asserts that everything up to
that sequence is trusted. Recording one over a hole would make the hole
permanent — every later reconciliation would start after it and never rescan the
entries that would reveal it. So `snapshot()` verifies first and returns an error
rather than a row.

**`verify()` does not trust the snapshot's numbers.** It derives balance from the
same fold, so an imbalance introduced before the last snapshot is still caught.

### Operating it

| | |
| --- | --- |
| Job | `ledger.snapshot`, order 50, hourly |
| Trigger | `platform.maintenance.runDue(tenant, now)` |
| Failure to watch | The job returning an error — that is an unbalanced ledger, not a slow query |
| Manual snapshot | `platform.reconciliation.snapshot(tenant, now)` |
| Manual check | `platform.reconciliation.verify(tenant)` |

An empty ledger reports "no ledger entries to snapshot" and is not a failure.
An **unbalanced** one is a failure, deliberately loud. See
[the runbook](06-runbook.md) for what to do when the ledger does not balance;
nothing in this document changes that procedure.

### Tuning

- **High write volume:** shorten `intervalSeconds` on `ledger.snapshot`. Each
  snapshot is one row per account per unit.
- **Very wide tenants** (many thousands of accounts): the snapshot row grows
  with account count, not history. `FOLD_BATCH` bounds memory during the fold,
  not the snapshot itself.
- Snapshots are **per tenant**. One tenant's volume never affects another's
  reconciliation cost.

---

## Part 2 — Bundle versions and replay

### What a bundle version is

A decision is a pure function of its context *and* the registries loaded at the
time. The context trace was always recorded. The registry state was not.

`computeBundleVersion()` hashes every registry's keys into a short deterministic
id. Every decision and every `execution.reserved` audit record carries it.

It is cheap on the hot path: each `Registry` keeps a monotonic `revision`
counter, so the platform re-hashes only when something has actually been
registered or overridden, and otherwise sums 28 integers.

### What it does not cover

**The version hashes keys, not behaviour.** Change the arithmetic inside a
benefit handler without touching its key and the version is unchanged. That is a
real limit, stated at the top of `src/platform/bundle.ts`.

A bundle version is **evidence, not proof**. It pairs with the deployment's own
build identifier, which is what moves when code moves. Record both.

### Replaying a decision

```ts
const result = await replayDecision(platform, { decision, context });
result.value.conclusion; // one of four, not a boolean
```

The four conclusions exist because "did not reproduce" on its own is the answer
that gets investigations wrong:

| Reproduced | Bundle | Means |
| --- | --- | --- |
| yes | same | The decision is confirmed exactly |
| yes | changed | Confirmed, and the registry changes did not affect it |
| no | changed | Expected. `bundleDifferences` names which registries moved |
| no | same | **Investigate.** Same rules, same context, different answer |

Only the last row is a fault.

### Why `bundle` is recorded but not hashed

It was inside the hashed decision body first. Every decision then failed to
reproduce whenever *any* registry changed, including registrations with nothing
to do with that decision.

That collapsed two different questions — *did this decision reproduce?* and *was
the platform running the same rules?* — into one, which is the exact opposite of
the reason for recording the bundle. `bundle` is provenance, not content. See
[ADR 0018](../06-adr/0018-snapshots-and-bundle-versions.md).

### Supplying the context

The platform does not store decision contexts. They contain customer data and
are the largest thing per decision by an order of magnitude; keeping every one
so that replay is convenient is the wrong trade on both privacy and volume.

The caller supplies the context from its own records. What the platform
guarantees is narrower and more useful: **the same context, under the same
bundle, at the same instant, reproduces the same decision byte for byte.**

The clock is pinned from `decision.at` automatically. Replaying a weekend-only
offer against today's date would produce a meaningless answer, so replay never
uses the current time.

### Comparing two bundles

```ts
compareBundles(recordedRegistries, currentRegistries); // BundleDifference[]
```

Reports which registries gained, lost or changed keys. This is what turns "the
rules changed" from an assertion into a list.

---

## Related

- [Concurrency and scaling](02-concurrency-and-scaling.md) — where this still breaks under load
- [Maintenance](07-maintenance.md) — the job table and what happens if nothing runs it
- [Runbook](06-runbook.md) — the ledger-imbalance procedure
- [ADR 0018](../06-adr/0018-snapshots-and-bundle-versions.md) — why it is built this way
