# ADR 0011 — No read-check-write in the storage port

**Status:** Accepted · **Date:** 2026-09-17 · **Phase:** 1

## Context

The original `CounterStore` looked like this:

```ts
read(tenant, valueExchangeId): LimitCounters;
mutate(tenant, valueExchangeId, change: (counters) => void): void;
```

The engine read the counters, checked the limits in application code, then
wrote. That is safe in the in-memory adapter because it is synchronous and
single-threaded — and safe nowhere else.

The documentation said so, at length, in
[persistence](../07-operations/01-persistence.md). But an interface whose only
safe implementation is an accident of the reference adapter is not a
specification; it is a trap with a warning label. Every adapter author would
have had to read the prose and then re-derive the fix.

## Decision

**The check moves inside the port.**

```ts
tryConsume(request: ConsumeLimitsRequest): Promise<Result<CounterSnapshot>>;
tryIssue(tenant, valueExchangeId, cap?): Promise<Result<number>>;
tryReserve(tenant, sourceId, amount): Promise<Result<FundingSource>>;
```

Each carries the constraint it must enforce. There is no shape in which a
caller can check and then write, because the caller never sees the value it
would check.

`read()` still exists, and its contract says explicitly what it is for:

> Advisory read, for eligibility verdicts and reporting. The value can be stale
> the instant it is returned. It exists so a verdict can say "3/5 used", never
> as the basis for allowing a redemption.

## Consequences

**Good**

- Over-redemption is prevented by the type signature, not by an adapter author
  reading a caution.
- Both shipped adapters use the same pure `findBreach`, so "which limit blocked
  this" has one answer everywhere.
- The SQLite adapter's `tryReserve` puts the headroom test in the `WHERE` clause
  and checks `changes === 0` — the pattern a Postgres adapter should copy
  verbatim.
- The concurrency suite passes against both adapters, with a negative control
  proving the naive shape over-admits under identical load.

**Bad**

- More methods, and a more opinionated port. An adapter over a store with no
  conditional writes has to emulate one with a lock.
- `tryConsume` takes a `LimitSpec`, so the port now knows something about the
  model. That is a real coupling, accepted because the alternative is the
  caller knowing something about atomicity.

## The split that made it work

Limit *semantics* are pure functions in `src/adapters/limit-rules.ts`; limit
*atomicity* is the adapter's job. That separation is what lets the same rules be
conformance-tested without a store, and lets a re-implementation in another
language reuse the rules without reusing the storage.

One subtlety fell out of it: eligibility runs *before* benefits are resolved, so
it cannot know what a redemption would grant. The budget check therefore has two
modes — `advisory` ("is there any headroom?") at eligibility and
`authoritative` ("would this grant fit?") at reserve. Making that explicit
replaced a silent inconsistency in which the advisory path quietly allowed a
15.00 budget to fund 20.00 of grants.

## Alternatives considered

**Keep the port, document the requirement harder.** Rejected: that is what the
previous version did, and it is why this ADR exists.

**A generic `compareAndSwap(key, expected, next)`.** Rejected: pushes the
semantics back to the caller and produces retry loops in engine code.

**Lock the exchange row for the whole reservation.** Rejected: serialises all
traffic for the most popular offer, which is exactly the offer that matters.
