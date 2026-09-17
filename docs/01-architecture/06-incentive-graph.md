# The universal incentive graph

The specification describes the platform as graph-native. This document is
precise about what that means here: the graph is a **derived view** over the
stored records, not a separate database.

---

## Why derived rather than stored

A graph database alongside the relational store would be a second source of
truth that drifts. Every edge below is already implied by a field on a record,
so the graph is a projection — computed on demand for analysis, never consulted
on the decision path.

The decision path deliberately does not traverse a graph. It walks a fixed
pipeline, because a decision that depends on graph traversal is a decision whose
latency and outcome depend on how much history a subject has.

## Nodes

| Node | Source | Key |
| --- | --- | --- |
| `ValueExchange` | `ValueExchangeStore` | `vx_*` |
| `Grant` | `GrantStore` | `grn_*` |
| `Subject` | context / grants / executions | tenant-supplied id |
| `Execution` | `ExecutionStore` | `exe_*` |
| `Decision` | audit payloads | `dec_*` |
| `FundingSource` | `FundingStore` | source id |
| `Party` | `FundingSource.party`, touchpoints | `<kind>:<id>` |
| `Account` | ledger entries | derived account id |
| `Touchpoint` | `AttributionEngine` | `tp_*` |
| `SpatialNode` | `spatial-node` registry | node key |
| `EconomicUnit` | `economic-unit` registry | unit key |
| `Reality` | `reality` registry | reality key |

## Edges

| Edge | From → To | Derived from |
| --- | --- | --- |
| `FUNDED_BY` | ValueExchange → FundingSource | `funding.splits[].sourceId` |
| `HELD_BY` | FundingSource → Party | `FundingSource.party` |
| `ISSUED_TO` | Grant → Subject | `Grant.subjectId` |
| `INSTANCE_OF` | Grant → ValueExchange | `Grant.valueExchangeId` |
| `DECIDED` | Decision → ValueExchange | `Decision.applied[]` |
| `REJECTED` | Decision → ValueExchange | `Decision.rejected[]` |
| `DISPLACED_BY` | ValueExchange → ValueExchange | `Decision.displaced[].conflictsWith` |
| `EXECUTES` | Execution → Decision | `Execution.decisionId` |
| `REDEEMED_BY` | Execution → Subject | `Execution.subjectId` |
| `PAID_FROM` | Execution → FundingSource | `ExecutedBenefit.funding[]` |
| `POSTED_TO` | Execution → Account | ledger `reference.id` |
| `ATTRIBUTED_TO` | Execution → Party | attribution shares |
| `TOUCHED` | Touchpoint → Subject | `Touchpoint.subjectId` |
| `CLAIMS` | Touchpoint → Party | `Touchpoint.party` |
| `SCOPED_TO` | ValueExchange → SpatialNode | `scope.spatial.include[]` |
| `CONTAINS` | SpatialNode → SpatialNode | `SpatialNode.parent` (reversed) |
| `DENOMINATED_IN` | Benefit → EconomicUnit | `BenefitSpec.unit` |
| `GOVERNED_BY` | ValueExchange → Policy | `governance.policies[]` |

## The picture

```
        Party ──HELD_BY── FundingSource
          │                     ▲
          │                     │ FUNDED_BY
       CLAIMS                   │
          │              ValueExchange ──SCOPED_TO──► SpatialNode
      Touchpoint                │  ▲                      │
          │                     │  │ INSTANCE_OF       CONTAINS
       TOUCHED           DECIDED│  │                      ▼
          │                     │  Grant ──ISSUED_TO──► Subject
          ▼                     │                          ▲
       Subject ◄────────────────┴── Decision               │
          ▲                            │ EXECUTES          │
          │                            ▼                   │
          └────────REDEEMED_BY──── Execution ──PAID_FROM──►FundingSource
                                       │
                                  POSTED_TO
                                       ▼
                                    Account
```

## Questions it answers

These are the queries that are painful without the graph and straightforward
with it.

**"Which offers did this customer see, take, and miss, and why?"**
`Subject ← REDEEMED_BY ← Execution → EXECUTES → Decision → {DECIDED, REJECTED}`

**"What did this campaign actually cost, and who bore it?"**
`ValueExchange ← DECIDED ← Decision → EXECUTES → Execution → PAID_FROM → FundingSource → HELD_BY → Party`

**"Which offers keep getting displaced?"**
`ValueExchange → DISPLACED_BY → ValueExchange`, aggregated. A campaign that is
always eligible and never chosen is a campaign that was configured but never
delivered — one of the most useful and least available reports in this domain.

**"Which partner drove this revenue?"**
`Execution → ATTRIBUTED_TO → Party`, weighted by the attribution model.

**"What is our total outstanding liability, per unit?"**
Sum the credit balances of `liab:*` accounts. Available directly from
`capabilities.settle()` without the graph, but the graph explains each
component.

**"If we retire this funding source, which offers stop working?"**
`FundingSource ← FUNDED_BY ← ValueExchange`. The single most useful
pre-change safety query, and the reason `funding.sources_exist` is a policy.

## Building the projection

Everything needed is already in the stores. A projector reads them and emits
nodes and edges:

```ts
function project(store: PlatformStore, tenant: string) {
  const exchanges  = store.exchanges.find(tenant).value ?? [];
  const ledger     = store.ledger.all(tenant).value ?? [];
  const audit      = store.audit.all(tenant);
  // ... emit nodes and edges per the tables above
}
```

No projector ships here — it would be inventing a query interface nobody has
specified yet. What ships is the guarantee that every edge above is derivable
from stored fields, which is the part that has to be true at design time. It is
listed in [known gaps](../08-roadmap/02-known-gaps.md).

## The rule

**Never traverse the graph inside a decision.** If an eligibility rule needs a
graph-derived fact — "has this subject ever been referred by a partner" — the
fact is computed upstream and placed in the context as a facet or a counter.
That keeps decision latency bounded and decisions replayable, since replaying a
traversal would require reconstructing the whole graph as it stood at the time.
