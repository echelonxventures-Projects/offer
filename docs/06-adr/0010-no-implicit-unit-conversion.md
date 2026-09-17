# ADR 0010 — No implicit unit conversion

**Status:** Accepted · **Date:** 2026-09-17

## Context

Found by a test during development.

The `percentage` benefit handler computed `rate% of base` and returned the
result in the **base's** unit, silently ignoring `spec.unit`. An author writing
"5% back in POINTS" would have got 5% of the basket **in dollars**, posted to a
points liability account.

Nothing would have failed. The ledger would have balanced. It would have been
discovered by a customer.

## Decision

Two rules.

**1. Every benefit type declares a `unitPolicy`.**

| Policy | Meaning |
| --- | --- |
| `"base"` | The value comes out in the interaction's unit. Declaring a different `spec.unit` is refused. |
| `"declared"` | The handler mints value in `spec.unit`. |

`percentage`, `tiered`, `volume`, `fixed_price` and `free_quantity` are `base` —
a percentage of USD is USD. `flat`, `item_grant` and `points_accrual` are
`declared`.

The engine checks the policy before calling the handler, and verifies the
handler honoured it afterwards.

**2. Conversion is never implicit, anywhere.**

- Ledger transactions never mix units; a conversion is two transactions plus an
  explicit exchange record.
- `EconomicAuthority.convert` requires a registered rate, refuses a
  non-exchangeable unit class, and returns **which rate it used**.
- There is no multi-hop rate routing. Chained conversions compound rounding and
  nobody can explain the result.
- Ranking counts only value in the interaction's own unit, rather than
  converting points to money to compare.

## Consequences

**Good**

- The failure above is now impossible: it returns `INVALID_REQUEST` naming both
  units.
- Every conversion in the audit trail carries the rate that produced it.
- Decisions stay explainable without reference to a rate table that has since
  changed.

**Bad**

- An offer denominated in a foreign unit cannot be *ranked* against one in the
  interaction's unit; it scores zero. The tie-break in
  [Law 9](../00-mission/02-constitution.md) stops it losing to nothing, but it
  cannot be compared.
- Authors must know their handler's unit policy. The error message says so, and
  it is still a thing to learn.
- Mixed-unit carts are not supported. Every line must be in the context unit.

## The genuine limitation

For a points-heavy programme that wants "the best offer" across money and
points, this design does not answer the question. The honest options are: pick
one objective per surface, or register a custom `decision-objective` that
applies the tenant's own conversion policy — explicitly, in one place, where it
can be reviewed.

**Enforced by** `test/benefits.test.ts` → *"a 'base' benefit may not declare a
foreign unit"* and *"a 'declared' benefit mints value in the unit it names"*.
