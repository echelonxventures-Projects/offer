# Stacking and Conflict Resolution Engine

`src/engines/stacking.ts`

Given several eligible exchanges, decide which may apply together, in what
order, and which combination is best.

## Compatibility

Pairwise, in this order:

| Rule | Conflict when |
| --- | --- |
| Exclusivity | Either exchange sets `exclusive: true` |
| Shared group | Both list the same group **and** they do not mutually whitelist |
| Explicit exclude | Either lists the other in `excludes` |
| Whitelist | Either has `combinesWith` that omits the other |

A one-sided `combinesWith` is not enough — both must name the other. Otherwise
one campaign author could unilaterally opt into stacking with somebody else's
budget.

## Search

Choosing the best combination is subset selection, and it is NP-hard in general.
This engine does not pretend otherwise:

| Eligible candidates | Strategy | Optimal? |
| --- | --- | --- |
| ≤ 10 (`EXHAUSTIVE_LIMIT`) | Enumerate all 2ⁿ subsets, keep the compatible ones | Yes |
| > 10 | Greedy: sort by standalone value, accept each improvement | No |

The decision reports `searchMode`, so a consumer can tell which it got. At the
limit, 1 024 subsets each requiring a benefit resolution is a few milliseconds;
beyond it, the growth is not acceptable on a request path.

See [ADR 0003](../06-adr/0003-bounded-stacking-search.md) for the reasoning and
the alternatives considered.

## Application order

**Priority descending, then id ascending.** Fixed and documented, because an
order that varies between runs makes a decision impossible to reproduce.

## Base threading

```
originalBase = cart.subtotal
remaining    = originalBase

for each exchange, in application order:
    appliedTo = (application === "parallel") ? originalBase : remaining
    resolve the exchange against appliedTo
    if sequential:
        remaining -= that exchange's payable reduction   (floored at zero)
```

Worked example — a 10% discount (sequential) and a 5% cashback (parallel) on
40 000:

| Exchange | Computes on | Value |
| --- | --- | --- |
| 10% discount | 40 000 | 4 000 off, leaving 36 000 |
| 5% cashback | **40 000**, not 36 000 | 2 000 deferred |

Had the cashback been sequential the customer would have received 1 800 and
nobody could have explained why. `examples/02-cashback.ts` prints this.

## The over-application guard

The combined reduction may never exceed the base. If it does — two parallel 60%
discounts, say — the decision fails with `ILLEGAL_STATE` and names the members.

It does **not** clamp. A clamp would produce a decision whose benefits do not
sum to its own total, and a ledger that cannot balance. Failing loudly at
authoring time is the cheaper mistake. `test/execution.test.ts` covers it.

## Objectives

What "best" means is a business question, so it is a registry entry. Scores are
`bigint`, so comparisons are exact.

| Objective | Prefers |
| --- | --- |
| `max_subject_value` | Most value to the subject, in the interaction's unit (default) |
| `max_payable_reduction` | Most off the price now, ignoring deferred value |
| `min_cost` | The cheapest combination that still applies something |
| `max_applied` | The most offers stacked |
| `max_priority` | The author's stated intent |

`examples/06-stacking-conflict.ts` runs one basket under four objectives and
gets four different, defensible answers. That is the point: the platform makes
it a parameter rather than a decision.

## The tie-break

Two combinations scoring identically are settled by:

1. **A combination that applies something beats one that applies nothing.**
2. Fewer exchanges beats more.
3. Lexical order of ids.

Rule 1 exists because of a real bug. An offer granting points scores zero in the
interaction's unit, tied with the empty set, and lost on "fewer is simpler" — so
a customer promised points would not have received them, and the decision would
have looked correct. `min_cost` had the same flaw from the other direction and
is handled by scoring the empty set as the worst possible option.

The greedy path applies the same tie-break, for the same reason.

## Displacement

Every eligible exchange that did not make the winning combination is reported:

```ts
displaced: [
  { valueExchangeId: "vx_000001", reason: "'vx_000005' is exclusive", conflictsWith: "vx_000005" },
  { valueExchangeId: "vx_000002", reason: "a different combination scored higher" },
]
```

"Eligible but never chosen" is one of the most useful signals a campaign owner
can have, and one of the least available in conventional systems.
