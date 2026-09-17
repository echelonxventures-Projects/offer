# Decision Engine

`src/engines/decision.ts`

The orchestrator. Gathers candidates, asks about each, hands the survivors to
stacking, and emits a complete account of what would happen.

## A decision commits nothing

It consumes no limit, holds no budget and moves no value. Quote it a hundred
times. This separation is [Law 5](../00-mission/02-constitution.md) and the
reason [two-phase execution](07-execution.md) works.

## Candidate gathering

Either an explicit `candidateIds` list, or:

1. Every `active` exchange scoped to this reality.
2. Plus any exchange reached by a presented code.

Note what is **not** filtered: visibility. A private exchange — an affiliate
commission, a negotiated partner rate — still applies. What stops it reaching
the wrong subject is its conditions and its acquisition mode.

Discovery is where private exchanges are hidden. See
[ADR 0008](../06-adr/0008-visibility-is-not-applicability.md).

## The decision record

```ts
{
  id, tenant, reality, correlationId, objective, at,

  applied:  AppliedExchange[],   // in application order, each with its full resolution
  payableReduction,              // total off the price now
  remainingPayable,              // what the subject pays
  granted:  Amount[],            // everything else, totalled per unit

  rejected: RejectedExchange[],  // every ineligible candidate, with all ten checks
  displaced: ConflictNote[],     // eligible but not chosen, with the reason

  searchMode, combinationsConsidered, candidatesConsidered,
  contextTrace,
  hash,
}
```

## The hash

A canonical hash over everything above except the id. Identical inputs produce
an identical hash across processes and machines, because:

- canonical JSON sorts keys and spells bigints explicitly
- the clock is injected
- the context is frozen
- application order is fixed

The `execution.reserved` audit record carries the decision hash, so an execution
can be tied to exactly the decision that produced it —
`test/audit.test.ts` asserts both properties.

## Risk

Optional, via `assessRisk: true` on the capability. A `block` disposition
refuses the whole call with `RISK_BLOCKED` and the firing signals attached, so
the refusal is appealable.

## Reading a decision

```
decision.applied[].resolution.computations[].detail   what each benefit did
decision.rejected[].verdict.checks                    why each candidate failed
decision.rejected[].verdict.ruleTrace                 which predicate decided it
decision.displaced[].reason                           why an eligible offer lost
decision.contextTrace                                 how the facts were assembled
decision.searchMode                                   whether the answer is optimal
```

Everything a support agent needs to answer "why didn't I get the discount?" is
in that structure, without reading a log.
