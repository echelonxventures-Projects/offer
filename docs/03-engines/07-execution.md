# Execution Engine

`src/engines/execution.ts`

Turns a decision into a commitment, in two phases.

## Why two phases

| Phase | Consumes limits | Holds budget | Posts to ledger |
| --- | :-: | :-: | :-: |
| `reserve` | yes | yes | no |
| `capture` | — | converts to spend | yes |
| `release` | gives back | gives back | no |
| `reverse` | gives back | gives back | contra entries |

A price is quoted many times and taken once. Consuming limits at quote time
exhausts a campaign on page views; consuming them at payment time leaves a gap
in which a last-of-stock coupon is redeemed twice. A reservation closes it.

See [ADR 0006](../06-adr/0006-two-phase-execution.md).

## Reserve

1. **Idempotency.** An existing execution for this key is returned unchanged.
2. **Allocate funding** for every benefit across the exchange's sources,
   honouring caps and remaining budgets.
3. **Stage the holds** in a local map.
4. **Commit** — and only now write. If any allocation in the whole decision
   fails, nothing was written and no partial hold is left behind.
   `test/execution.test.ts` asserts this explicitly.
5. **Consume the limit counters.**
6. **Audit** `execution.reserved`, carrying the decision hash.

The staging in step 3 is the part that is easy to get wrong. Writing holds as
they are computed means a failure on the third benefit leaves budget locked
against the first two, and it stays locked until someone notices.

## Capture

1. Build balanced double entries for each benefit.
2. Convert each hold into spend.
3. **If the reality is binding**, append to the ledger. If not, everything above
   still ran and nothing is written.
4. Audit `execution.captured`.

Step 3 is what makes simulation honest. A non-binding reality is not a separate
code path with its own bugs — it is the same path with the write suppressed at
the last moment.

Capturing an already-captured execution returns its existing entries rather than
posting again.

## Release

Only from `reserved`. Gives back the holds and the consumed limits, and the
offer becomes available again — asserted end to end in the tests.

## Reverse

Only from `captured` or `settled`. Posts contra entries (same accounts, opposite
directions), restores `spent`, and gives back the limits.

After a reversal every account nets to zero. `test/execution.test.ts` checks
every position, not just the total.

## Idempotency

Keyed on `idempotencyKey`, which callers should always supply. A retried
checkout must never double-consume a budget, and callers do retry.

```ts
const a = caps.redeem({ context, actor, idempotencyKey: "order-1001" });
const b = caps.redeem({ context, actor, idempotencyKey: "order-1001" });
a.value.execution.id === b.value.execution.id;   // true
// budget spent once, ledger written once
```

## Limit counters

Consumed at reserve:

```
counters.redemptions           += 1
counters.bySubject[subject]    += 1
counters.recentBySubject[subject].push(nowSeconds)
counters.grantedByUnit[unit]   += benefit value
```

Restored on release and on reversal.

**The concurrency caveat.** The in-memory `CounterStore` is trivially atomic
because it is single-threaded. A distributed adapter must make `mutate` a single
transaction or a compare-and-set — the read-check-write gap is precisely where
over-redemption occurs under load. This is marked in
`src/adapters/memory-store.ts` and specified in
[persistence](../07-operations/01-persistence.md).

## What it refuses

| Situation | Error |
| --- | --- |
| Reserving a decision that applied nothing | `INVALID_REQUEST` |
| Funding cannot cover the benefit | `INSUFFICIENT_FUNDS`, with the shortfall |
| Capturing something not `reserved` | `ILLEGAL_STATE` |
| Releasing something not `reserved` | `ILLEGAL_STATE` |
| Reversing something not captured | `ILLEGAL_STATE` |
| A benefit with value but no funding allocation | `INVALID_REQUEST` |
