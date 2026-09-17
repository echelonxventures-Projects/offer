# ADR 0002 — Integer money only

**Status:** Accepted · **Date:** 2026-09-17

## Context

This platform computes liabilities. A cashback balance is money the business
owes; a commission is money a partner is due; a subsidy is public money.

IEEE-754 doubles cannot represent `0.1` exactly. `0.1 + 0.2 === 0.30000000000000004`.
Repeated percentage arithmetic accumulates error, and the error lands in a
liability account.

## Decision

Money is `{ unit, minor: bigint, scale }` — an exact integer count of minor
units. No floating point touches a monetary value anywhere.

- Percentages are exact rationals: `percent("12.5")` is `125/1000`, not `0.125`.
- Every operation that could lose value takes an explicit `RoundingMode`.
- `allocate()` distributes remainders so parts always sum to the whole.
- `bigint` rather than a scaled `number`, so there is no silent overflow at
  2⁵³ minor units.

## Consequences

**Good**

- Correctness is structural, not a matter of care.
- `allocate()` makes multi-party funding, attribution and line-level refunds
  reconcile to the last minor unit by construction.
- Rounding is a visible decision at every call site.

**Bad**

- `bigint` does not serialise to JSON. The canonical encoder spells it
  `"~bigint:1234"`, and any transport layer must handle it.
- `bigint` arithmetic is slower than `number`. Irrelevant at this scale, real if
  someone runs millions of allocations per second.
- Authors must think about scale. `fromDecimal("USD", "1.005", 2)` **throws**
  rather than silently rounding, which is right and occasionally surprising.

**Enforced by** `test/amount.test.ts`, particularly *"never creates or destroys
value"*.

## Alternatives considered

**Floats with rounding at the boundary.** Rejected: the error is already in the
intermediate values, and cashback on a discounted subtotal compounds it.

**A decimal library.** Rejected: a runtime dependency for something `bigint`
does natively, and most such libraries still expose a float constructor.

**Scaled integers in `number`.** Rejected: fine until a tenant uses a 6-decimal
unit and a large budget, then silently wrong.
