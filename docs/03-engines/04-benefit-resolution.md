# Benefit Resolution Engine

`src/engines/benefit-resolution.ts`

Turns benefit *specifications* into benefit *computations*.

## The steps

For each `BenefitSpec` on an exchange:

1. **Resolve the handler** from the `benefit-type` registry.
2. **Resolve the effect** from the `effect-kind` registry.
3. **Check the unit policy** — reject a `base` benefit declaring a foreign unit.
4. **Select the lines** the benefit targets.
5. **Compute the base** it works against.
6. **Call the handler.**
7. **Verify** the handler honoured its own unit policy.
8. **Apply the cap**, re-spreading allocations so they still sum to the value.
9. **Classify** by effect: reduces the payable, or is granted separately.

## The type / effect split

The central modelling decision. A benefit type says *how much*; an effect says
*what it does*.

| Construct | type | effect |
| --- | --- | --- |
| Percentage discount | `percentage` | `price_reduction` |
| Cashback | `percentage` | `deferred_credit` |
| Affiliate commission | `percentage` | `commission` |

One handler, three products. This is why eight handlers cover the
specification's twenty-six benefit types.

## Shipped handlers

| Type | Parameters | Unit policy | Computes |
| --- | --- | --- | --- |
| `percentage` | `rate` | base | `rate`% of the base |
| `flat` | `amount` | declared | A fixed value, never exceeding the base |
| `tiered` | `tiers[{min, rate\|amount}]` | base | Highest threshold the base meets |
| `volume` | `tiers[{minQuantity, rate\|amount}]` | base | Highest threshold the quantity meets |
| `fixed_price` | `price` | base | The difference, per targeted unit |
| `free_quantity` | `buy`, `free` | base | The cheapest units, given away |
| `item_grant` | `sku`, `quantity`, `value` | declared | The declared cost of the granted item |
| `points_accrual` | `points`, `per` | declared | Points per whole unit of base |

## Unit policy

`"base"` means the value comes out in the interaction's unit — 10% of a USD
basket is USD, and there is no meaningful sense in which it is points.
Declaring a different `spec.unit` on such a benefit is an authoring error and
is **refused**, not ignored.

`"declared"` means the handler mints value in `spec.unit`.

This was a real bug: `percentage` silently ignored `spec.unit`, so a benefit
authored as "5% back in points" would have paid 5% of the basket in dollars.
The policy field and both guards exist because a test caught it. See
[ADR 0010](../06-adr/0010-no-implicit-unit-conversion.md).

## Targeting

```ts
target: {
  categories?, skus?, merchants?,        // filters
  select?: "all" | "cheapest" | "most_expensive",
  maxLines?, maxQuantityPerLine?,
}
```

SKUs are glob-matched. `select` plus `maxLines` expresses "the cheapest two
items" directly.

## The base, and `baseOverride`

The subtle part. An untargeted benefit computes against `baseOverride` — the
remaining base threaded in by the stacking engine — or the cart subtotal if
none is given.

A targeted benefit computes against its targeted lines, **clipped to the
remaining base**. Without that clip, sequential stacking would let the second
benefit discount money the first one already discounted.

## Allocations

Every line-affecting benefit spreads its value across the lines it came from,
proportional to line totals, using the remainder-preserving allocator. The
allocations always sum exactly to the value.

This is not bookkeeping neatness: it is what lets a partial refund reverse
exactly the right amount for exactly the right line, months later.

When a cap binds, the allocations are re-spread to the capped total rather than
left summing to the uncapped one. `test/benefits.test.ts` asserts this.

## Ranking value

`rankingValue` counts only value in the interaction's own unit. An offer
granting points contributes zero.

That is deliberate: converting points to money for ranking would import an
exchange rate into a decision that has to be explainable without one. The
consequence — that such an offer ties with the empty set — is handled by the
stacking tie-break, not by fudging the score. See
[the constitution, Law 9](../00-mission/02-constitution.md).
