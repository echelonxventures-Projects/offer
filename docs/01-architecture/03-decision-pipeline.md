# The decision pipeline

From an HTTP request to a ledger entry, with the code at each step.

---

## The whole path

```
  caller
    │
    │  capabilities.redeem({ context, codes, actor, idempotencyKey })
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 1. CONTEXT RESOLUTION          ContextResolutionEngine              │
│    base → enrich → derive, then deep-freeze                         │
│    out: ResolvedContext + trace                                     │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. RISK (optional)             RiskEngine                           │
│    signals → weighted mean → allow | review | block                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. CANDIDATE GATHERING         DecisionEngine                       │
│    active exchanges in this reality, plus any reached by code       │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. ELIGIBILITY (per candidate) EligibilityEngine                    │
│    reality · lifecycle · window · spatial · channel · merchant      │
│    acquisition · minimum base · limits · CONDITIONS                 │
│    out: verdict with every check, passed or failed                  │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 5. STACKING                    StackingEngine                       │
│    enumerate compatible subsets (exhaustive ≤10, else greedy)       │
│    for each: apply in priority order, threading the remaining base  │
│    score each under the objective, pick the best                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 6. DECISION                    DecisionEngine                       │
│    applied · rejected · displaced · totals · traces · hash          │
│    ── commits nothing ──                                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 7. RESERVE                     ExecutionEngine                      │
│    allocate funding · stage holds · commit holds · consume limits   │
│    audit: execution.reserved                                        │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 8. CAPTURE                     ExecutionEngine + settlement         │
│    post balanced double entries · convert holds to spend            │
│    audit: execution.captured                                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 1 — Context resolution

`src/context/resolution-engine.ts`

Three ordered stages, each a registry of resolvers:

| Stage | Purpose | Core resolvers |
| --- | --- | --- |
| `base` | Structural facts | `core.temporal`, `core.spatial`, `core.economic` |
| `enrich` | External lookups | `core.subject` |
| `derive` | Computed from enriched data | `core.cart` |

The ordering exists because cart totals cannot be computed before the economic
unit is known, and segment membership cannot be derived before the subject is
loaded.

Every resolver is recorded, including the ones that did nothing:

```ts
context.trace
// [ { resolver: "core.temporal", outcome: "applied", note: "instant=... calendar=gregorian zone=UTC" },
//   { resolver: "core.spatial",  outcome: "skipped" },
//   ... ]
```

The result is deep-frozen. A resolver that fails aborts resolution and returns
the partial trace in the error details, so a misconfigured resolver is
diagnosable from the error alone.

**A tenant adds context** by registering a resolver. Nothing else changes.

## Step 2 — Risk

`src/engines/risk.ts`

Opt-in, via `assessRisk: true`. Each signal scores 0–100 with a weight; the
engine takes the weighted **mean**, not the sum, so adding a signal does not
inflate every score. Two thresholds produce `allow`, `review` or `block`.
`block` refuses the whole call with `RISK_BLOCKED` and the firing signals
attached.

## Step 3 — Candidate gathering

`src/engines/decision.ts` → `#gatherCandidates`

Either the explicit `candidateIds`, or every `active` exchange scoped to this
reality, plus any exchange reached by a presented code.

Note what is *not* filtered here: visibility. A private exchange still applies.
See [ADR 0008](../06-adr/0008-visibility-is-not-applicability.md).

## Step 4 — Eligibility

`src/engines/eligibility.ts`

Ten checks, cheapest first. Crucially, the record does **not** short-circuit: an
exchange failing on the window still reports what channel, merchant and limit
checks would have said, so a merchant debugging a campaign sees everything in
one call.

The single exception is `conditions`. Rule evaluation is the expensive step, so
once something structural has failed it is skipped — and the trace says so
explicitly rather than silently omitting it:

```
{ check: "conditions", passed: false, skipped: true,
  detail: "not evaluated: an earlier check already failed" }
```

A rule that *errors* is not an ineligible subject. It is an authoring bug, and
it surfaces as `RULE_ERROR` rather than as a quiet non-qualification.

## Step 5 — Stacking

`src/engines/stacking.ts`

Compatibility is pairwise: exclusivity, shared groups, explicit excludes,
mutual whitelists. Then:

- **≤ 10 eligible candidates:** enumerate all 2ⁿ subsets, filter to compatible
  ones, evaluate each, take the best. Genuinely optimal.
- **more:** greedy by standalone value, accepting each addition that improves
  the score. The decision reports `searchMode: "greedy"` so nobody mistakes it
  for optimal.

Within a combination, application order is **priority descending, then id
ascending** — fixed, so the result is reproducible.

The base threading is the subtle part:

```
originalBase = cart.subtotal
remaining    = originalBase

for each exchange in order:
    appliedTo = (application === "parallel") ? originalBase : remaining
    resolve against appliedTo
    if sequential: remaining -= that exchange's payable reduction
```

A 10% discount and a 5% cashback on a 40 000 basket: the discount takes 4 000,
leaving 36 000; the cashback, being parallel, still computes 5% of 40 000 =
2 000 rather than 1 800. Example 2 demonstrates exactly this.

Finally, the combined reduction may never exceed the base. If it does, that is a
bug in the authored offers and the decision fails with `ILLEGAL_STATE` rather
than clamping into a ledger that will not balance.

## Step 6 — Decision

The output record:

```ts
{
  id, tenant, reality, correlationId, objective, at,
  applied: [...],          // what won, in application order, with full resolutions
  payableReduction,        // total off the price now
  remainingPayable,        // what the subject pays
  granted: [...],          // everything else, totalled per unit
  rejected: [...],         // every ineligible candidate, with all its checks
  displaced: [...],        // eligible but not chosen, with the reason
  searchMode, combinationsConsidered, candidatesConsidered,
  contextTrace,
  hash                     // canonical hash of everything above
}
```

A decision commits nothing. Quote it a hundred times.

## Step 7 — Reserve

`src/engines/execution.ts`

1. Idempotency check — an existing execution for this key is returned unchanged.
2. For each benefit: allocate funding across sources, honouring caps and
   remaining budgets.
3. Stage the holds in a local map. **Nothing is written** until every allocation
   in the whole decision has succeeded, so a failure halfway leaves no partial
   holds. `test/execution.test.ts` asserts this.
4. Commit the staged holds, then consume the limit counters.
5. Write the execution and the `execution.reserved` audit record, which carries
   the decision hash.

## Step 8 — Capture

1. For each benefit: build balanced double entries.
2. Convert each hold into spend.
3. If the reality is binding, append to the ledger. If not, everything above
   still ran and nothing is written — which is what makes simulation honest.
4. Write the `execution.captured` audit record.

The posting convention, stated once:

| Effect | Debit | Credit |
| --- | --- | --- |
| price reduction, fee waiver | funder expense | tenant clearing |
| deferred credit, wallet credit | funder expense | subject wallet liability |
| points grant | funder expense | subject points liability |
| commission | funder expense | third-party payable |

Every transaction nets to zero in every unit or it is refused.

---

## Reading the trace end to end

Example 1 prints all of it. The short version:

```
context.trace          how the facts were assembled
verdict.checks         which of the ten checks passed, per candidate
verdict.ruleTrace      which predicates fired, with the values compared
decision.displaced     why an eligible offer did not win
decision.hash          proof of what was decided
audit chain            proof that it has not been edited since
```
