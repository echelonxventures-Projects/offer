# ADR 0003 — Bounded stacking search

**Status:** Accepted · **Date:** 2026-09-17

## Context

Given *n* eligible offers with pairwise compatibility constraints, finding the
combination that maximises an objective is subset selection with conflicts. It
is NP-hard, and sequential application makes the value of a combination depend
on its ordering, so subsets cannot be scored independently.

This runs on the request path, at checkout.

## Decision

Two strategies, with the boundary declared in the output.

| Eligible candidates | Strategy | Optimal |
| --- | --- | --- |
| ≤ 10 | Enumerate all 2ⁿ subsets, keep compatible ones, score each | Yes |
| > 10 | Greedy by standalone value, accepting improvements | No |

The decision reports `searchMode: "exhaustive" | "greedy"`.

## Consequences

**Good**

- Real deployments almost always have fewer than ten *eligible* offers for one
  context, even with hundreds authored — so the common case is optimal.
- 1 024 subsets, each a benefit resolution, is a few milliseconds.
- The output is honest. No consumer can mistake a heuristic for a guarantee.

**Bad**

- Above the limit the answer can be worse than optimal, and there is no bound on
  how much worse.
- The threshold is a constant, not adaptive to how expensive resolution is.
- Greedy is order-dependent; the seed ordering is deterministic, which makes it
  reproducible but not better.

## Alternatives considered

**Always greedy.** Rejected: gives up optimality in the case that matters most,
for a saving that does not matter.

**Always exhaustive.** Rejected: 2²⁰ subsets is a million benefit resolutions.
Unacceptable, and a denial-of-service vector for a tenant who authors twenty
compatible offers.

**Integer programming.** Rejected: a solver dependency, latency that is hard to
bound, and an answer no support agent could explain.

**Precomputed combinations.** Rejected: combinations depend on the cart, so
there is nothing stable to precompute.

## If the limit is reached routinely

Reduce *eligible* candidates rather than raising the limit: tighter stacking
groups, more exclusivity, more specific conditions. Ten simultaneously-eligible
offers usually indicates a campaign portfolio problem rather than a search
problem.
