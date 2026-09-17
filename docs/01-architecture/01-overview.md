# Architecture overview

## One page

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CALLERS   web · mobile · POS · ERP · partner feed · agent · batch job    │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │  only ever through capabilities
┌────────────────────────────────▼─────────────────────────────────────────┐
│  CAPABILITY LAYER            src/capabilities                            │
│  22 verbs. Never mentions coupon, cashback, gift card or commission.     │
│  create clone publish govern validate · discover search compare issue    │
│  activate · apply optimize simulate forecast · reserve redeem · track    │
│  attribute audit · fund settle pay                                       │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────────────┐
│  ENGINES                     src/engines, src/ledger, src/attribution    │
│                                                                          │
│   Context ─► Eligibility ─► Benefit ─► Stacking ─► Decision              │
│   resolution                resolution  + conflict     │                 │
│                                                        ▼                 │
│                                          Execution ─► Settlement ─► Audit│
│                                                                          │
│   Cross-cutting: Governance · Risk · Discovery · Attribution             │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────────────┐
│  MODEL                       src/model                                   │
│  ValueExchange · Benefit · Funding · Limits · Lifecycle · Grant          │
│  Execution                                                               │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────────────┐
│  UNIVERSAL DOMAINS           src/universal                               │
│  Economic ── units, amounts, rates, exchange                             │
│  Temporal ── chronologies, calendars, frames, windows                    │
│  Spatial  ── nodes, containment, jurisdiction, scopes                    │
│  Reality  ── binding vs non-binding partitions                           │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────────────┐
│  REGISTRY  src/registry   ·   KERNEL  src/kernel                         │
│  The one extension mechanism   Result · errors · canonical hash · ids    │
└──────────────────────────────────────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────────────┐
│  PORTS AND ADAPTERS          src/adapters                                │
│  ValueExchangeStore · GrantStore · CounterStore · FundingStore           │
│  ExecutionStore · LedgerStore · AuditStore   →  MemoryPlatformStore      │
└──────────────────────────────────────────────────────────────────────────┘
```

## The three ideas

Everything else follows from these.

### 1. One record

There is a single stored entity, `ValueExchange`. A coupon is one. So is a
subsidy, a commission plan and a loyalty accrual rule. They differ in their
data, never in their shape.

The evidence is `src/profiles/builders.ts`: seven builder functions, all
returning the same type, differing only in which fields they set. And
`test/platform.test.ts` asserts that a `coupon` and a `government_benefit`
produce structurally identical records.

### 2. One pipeline

```
CONTEXT → CONDITIONS → ELIGIBILITY → BENEFIT → EXECUTION → SETTLEMENT → AUDIT
```

Every decision, for every profile, in every reality, walks the same path. There
is no fast path, no special case and no bypass. A simulation is the same walk
with `effectsAreBinding: false`.

### 3. One extension mechanism

Registries. Not plugins, not subclasses, not hooks in eleven different shapes —
one `Registry<T>` class, used twenty-three times.

The consequence: `platform.describe()` enumerates the entire extension surface
at runtime, which is how the [registry reference](../04-registries/02-reference.md)
is generated rather than written.

## Dependency direction

Strictly downward. Enforced by review and visible in the imports:

```
capabilities → engines → model → universal → registry → kernel
      │            │
      └────────────┴──────► adapters (ports only, never concrete)
```

The kernel imports nothing from the platform. The registry imports only the
kernel. The universal domains import the registry and kernel. No engine imports
another engine's internals — they compose through `EngineDeps`.

`src/platform/platform.ts` is the only place that knows about everything, and it
is a constructor, not logic.

## What makes it replayable

Three deliberate choices, each of which costs something:

| Choice | Cost | What it buys |
| --- | --- | --- |
| The clock is injected | Every engine needs `TemporalAuthority` | A disputed decision can be re-run exactly |
| Context is deep-frozen | An allocation and a freeze per request | Two engines cannot disagree about the facts |
| Decisions are hashed | Canonical serialisation per decision | The audit record proves what was decided |

Together they mean a decision from eight months ago can be reproduced given its
context and the registry state, and the reproduction is checkable against the
hash in the audit chain.

## Where to go next

- [Layers](02-layers.md) — the rules about what may call what
- [Decision pipeline](03-decision-pipeline.md) — step by step, with the code
- [Extension model](04-extension-model.md) — how to add things
- [Data model](05-data-model.md) — the record, field by field
