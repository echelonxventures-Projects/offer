# ADR 0008 — Visibility is not applicability

**Status:** Accepted · **Date:** 2026-09-17 · **Supersedes:** an earlier implementation

## Context

`ValueExchange.visibility` is `public`, `targeted` or `private`.

The first implementation filtered `private` exchanges out of the Decision
Engine's candidate sweep, on the reasoning that "private" meant "not generally
available".

`examples/04-affiliate-settlement.ts` immediately failed. An affiliate
commission is private — no customer should ever browse it — but it must apply
automatically whenever an attributed order lands. Under the old behaviour it
never applied at all, and the decision reported "nothing applied" as if that
were correct.

## Decision

**Visibility governs discovery only.**

| Engine | Honours visibility |
| --- | --- |
| `DiscoveryEngine` | Yes — `private` is excluded from listings |
| `DecisionEngine` | **No** — every active exchange is a candidate |

What stops a private exchange reaching the wrong subject is its **conditions**
and its **acquisition mode**, which is where that decision belongs.

## Consequences

**Good**

- Affiliate commissions, negotiated partner rates and internal adjustments work
  correctly: invisible, but effective.
- The two concerns are named separately and cannot be confused again.
- Access control lives in conditions, where it is expressible, auditable and
  visible in the trace — rather than in a visibility enum, where it was
  invisible.

**Bad**

- "Private" is a weaker word than it sounds. An author who believes it restricts
  *application* will be wrong.
- A private exchange with no conditions applies to everyone. That is the author's
  bug, but the field name invites it.

**Mitigation:** the field is documented as discovery-only in
[the data model](../01-architecture/05-data-model.md), and
`test/decision.test.ts` → *"a private exchange still applies; it is only hidden
from discovery"* asserts both halves so the behaviour cannot silently revert.

## Alternatives considered

**Keep the filter, require an explicit id for private exchanges.** Rejected:
the caller would have to know the commission exists, which defeats automatic
attribution.

**A separate `applicability` field.** Rejected: two fields where conditions
already express it, and a second place for access rules to drift.

**Rename to `discoverability`.** Tempting and probably correct. Not done because
`visibility` is the term the specification uses and the field is already in the
stored shape. Worth revisiting before a first production release.
