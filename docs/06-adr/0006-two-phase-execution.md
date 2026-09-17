# ADR 0006 — Two-phase execution

**Status:** Accepted · **Date:** 2026-09-17

## Context

A price is quoted many times and taken once. A customer loads a basket page
five times, edits it twice, then pays — or abandons it.

If limits are consumed at quote time, a campaign is exhausted by browsing. If
they are consumed at payment time, there is a window between showing a price and
taking the money in which the last unit of a limited offer can be redeemed
twice.

## Decision

Three separate operations.

| Operation | Limits | Budget | Ledger |
| --- | --- | --- | --- |
| `apply` | — | — | — |
| `reserve` | consumed | held | — |
| `capture` | — | hold → spend | posted |

Plus `release` (undo a reservation) and `reverse` (undo a capture).

All of it idempotent on `idempotencyKey`.

## Consequences

**Good**

- Quotes are free and unlimited.
- The oversell window is closed: a reservation is taken before the customer is
  told a final price.
- Abandoned baskets return their budget on release, or on a sweep.
- Reservations make distributed checkout flows safe — hold, take payment
  elsewhere, capture.

**Bad**

- Callers must handle a third state. A reserved-but-never-captured execution
  holds budget until released.
- **A reaper is required.** Nothing here expires stale reservations. A
  deployment that never releases will leak budget. Listed in
  [known gaps](../08-roadmap/02-known-gaps.md).
- More round trips for a simple flow. `redeem` exists for exactly that case and
  does both in one call.

## The atomicity requirement

Reserve stages all funding holds locally and commits only when every allocation
in the decision has succeeded. A failure halfway leaves nothing behind.

This is asserted in `test/execution.test.ts` → *"an exhausted funding source
refuses the reservation rather than half-funding it"*, which checks that no
partial hold remains.

## Alternatives considered

**Single-phase redeem only.** Rejected: leaves the oversell window open.

**Optimistic with compensation.** Rejected: compensating a customer who was
shown a price and then charged more is a support problem, not an engineering
solution.

**Pessimistic locks on the exchange.** Rejected: serialises all traffic for a
popular offer, which is exactly the offer that matters.
