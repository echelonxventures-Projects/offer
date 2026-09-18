# ADR 0015 — The hardcoding audit

**Status:** Accepted · **Date:** 2026-09-18 · **Phase:** 3 (prelude)

## Context

The requirement was restated as: *zero hard coding — language, tools, database,
everything.*

Rather than assert compliance, the codebase was audited for the specific shape
Law 2 forbids: a comparison against a literal that is really a registry key.

```
grep "switch (" src/
grep 'effect\.key === \|\.type === "\|kind === "' src/
grep "^export const [A-Z_]* = [0-9]" src/
```

It found three violations and three magic numbers. All three violations had
survived since Phase 0, in code that had been reviewed and documented as
registry-driven, because **nothing was checking**.

## What was wrong

**1. Posting rules branched on the effect key.** `src/ledger/settlement.ts`:

```ts
if (effect.key === "commission") { ... }
const id = effect.key === "points_grant" ? pointsLiability(...) : subjectWallet(...);
```

Registering a new effect kind that posted somewhere new required editing the
ledger. This is the exact scenario the constitution names — "if adding one
requires editing a `switch`, the design is wrong and the review should reject
it" — and it had been shipped, documented and tested around for three phases.

**2. Lifecycle routing was a hardcoded `switch`.** `publish` walked a fixed
route to `active`, silently ignoring the transition registry. A deployment that
registered a custom state — legal sign-off between review and approval, say —
would have had its own transitions bypassed.

**3. Acquisition modes were a closed union.** `"automatic" | "code" | "issued" |
"earned" | "referred"`, dispatched by `switch` in the eligibility engine. How a
subject comes to hold an offer is a business question, and a closed list makes
it the platform's.

**Plus** `EXHAUSTIVE_LIMIT = 10`, `MAX_RECENT_RETAINED = 512`,
`DEFAULT_SWEEP_LIMIT = 100` and the rule depth and budget: decisions about cost
and safety made on behalf of deployments that may not share the assumptions.

## Decision

**Fix all three, extract the constants, and add a guard so the next one is
caught by a test rather than by an audit three phases later.**

| Was | Now |
| --- | --- |
| `if (effect.key === "commission")` | `posting-rule` registry; an effect *names* its rule |
| Account id template literals | `AccountNaming` strategy, injectable |
| `switch (from)` for lifecycle | `routeBetween()` — breadth-first over the transition registry |
| Closed acquisition union | `acquisition-mode` registry; the field is a string |
| Four magic numbers | `PlatformConfig`, with the reasoning attached to each |

And, because the underlying failure was the absence of a check rather than the
presence of a bug, `test/extensibility.test.ts` now greps the engines and the
ledger for comparisons against registry-key literals, and for reintroduced bare
constants.

## Consequences

**Good**

- Four new genuine extension points, each demonstrated by a test that registers
  something the platform has never heard of: an escrow posting rule, a
  token-gated acquisition mode, a custom lifecycle state, a tightened config.
- 27 registries, 204 entries. A deployment can map onto an existing chart of
  accounts without forking.
- The guard means Law 2 is a property rather than a principle.
- No behaviour changed. All 303 pre-existing tests passed throughout, which is
  the evidence that this was refactoring rather than redesign.

**Bad**

- More indirection. Finding where a commission posts now means following
  `effect.posting` to a registry entry rather than reading a branch.
- The `acquisition.mode` field widened from a union to a string, so a typo is no
  longer a compile error. It fails closed at eligibility with the mode named,
  which is the right trade but is a real loss of static safety.
- `PlatformConfig` is another thing to document and get wrong.

## What was deliberately *not* changed

This is the part that matters, and it is written up at length in
[what is fixed](../01-architecture/08-what-is-fixed.md).

"Zero hardcoding" taken literally is incoherent: something has to execute, the
pipeline has to have an order, and a ledger that does not balance is not a
ledger. The useful version of the requirement is **three tiers**, distinguished
by who has to agree to a change:

- **Deployment** — registries and config. No coordination.
- **Specification** — rounding modes, encoding, error codes, the capability
  list, the limit check order. Changing these requires updating the vectors and
  every conforming implementation.
- **Invariant** — the pipeline order, double entry, exact integer money, the
  existence of a host language.

The clearest case is rounding. `switch (mode)` in `amount.ts` survived the audit
deliberately: the seven modes are pinned by 111 conformance vectors, and making
them a registry would let a deployment silently diverge from the specification
it claims to implement. **Extensibility where the specification needs agreement
is not flexibility; it is a way to produce two systems that both claim to
conform and disagree.**

## Alternatives considered

**Claim compliance and move on.** Rejected. The audit took twenty minutes and
found three real violations; the claim would have been false.

**Make everything a registry, including rounding and the pipeline.** Rejected
for the reason above — and because a configurable pipeline is not a platform,
it is a workflow engine with no opinion, which pushes every hard decision back
onto each deployment.

**Keep the constants but document them.** Rejected: that is what the previous
version did, and documentation is not a mechanism.
