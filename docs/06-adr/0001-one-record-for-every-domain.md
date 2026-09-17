# ADR 0001 — One record for every domain

**Status:** Accepted · **Date:** 2026-09-17

## Context

The specification lists 67 domains: coupon, cashback, gift card, voucher,
loyalty, referral, affiliate, government benefit, and so on.

The conventional approach gives each its own table, its own service and its own
eligibility logic. The predictable result is that two systems disagree about
whether a customer is a new customer, offers from different systems cannot
stack, and nobody can total what promotions cost.

## Decision

**One stored record, `ValueExchange`.** Every construct is an instance. What
distinguishes them is data:

| Distinguisher | Field |
| --- | --- |
| How it is obtained | `acquisition.mode` |
| What it computes | `benefits[].type` |
| What that does | `benefits[].effect` |
| Who pays | `funding` |
| Where it applies | `scope`, `window`, `conditions` |
| How it combines | `stacking` |

`profile` is a label for presentation and policy. **No engine branches on it.**

## Consequences

**Good**

- One eligibility answer, one cost model, one audit trail.
- A new domain is usually zero code — see the worked example in
  [extending](../04-registries/01-extending.md).
- Stacking across "different kinds" of offer is free, because there are no
  different kinds.

**Bad**

- The record is wide. An author sees fields irrelevant to their case, which the
  profile builders mitigate but do not remove.
- Storage is less normalised; a coupon carries funding and attribution fields it
  may not use.
- The abstraction must be actively defended. One `if (profile === ...)` in an
  engine and it is over.

**Enforced by** `test/platform.test.ts` → *"no engine mentions a domain word"*
and *"two different profiles produce structurally identical records"*.

## Alternatives considered

**A table per domain.** Rejected: it is the status quo this design exists to
replace, and it fails at the first cross-domain stacking requirement.

**A base record with per-domain extension tables.** Rejected: it keeps the join
and the dispatch, so engines still learn domain names — the worst of both.

**A schemaless document per domain.** Rejected: no shared eligibility, no shared
settlement, and every consumer re-implements interpretation.
