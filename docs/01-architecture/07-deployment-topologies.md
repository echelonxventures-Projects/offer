# Deployment topologies

The same code in five shapes. The capability layer is the boundary in every one.

---

## 1. Embedded library

```
┌─────────────────────────────────┐
│ Your application process        │
│   import { GoipPlatform }       │
│   platform.capabilities.apply() │
│            │                    │
│   MemoryPlatformStore (or yours)│
└─────────────────────────────────┘
```

**Use when** incentives are part of one application and there is no second
consumer.

**Gets you** zero network latency and no serialisation.

**Costs you** a shared deployment lifecycle, and no isolation between your
application's memory and the platform's.

This is what the examples do.

## 2. Headless service

```
   web ─┐
   POS ─┼─► HTTP / GraphQL ─► capability layer ─► engines ─► Postgres
partner ─┘                                                    Kafka (events)
```

**Use when** several consumers need one answer.

The transport is a thin wrapper: each capability becomes one endpoint, each
`Result` becomes a status code (see [errors](../05-api/02-errors.md)). The
mapping is mechanical because the capability surface is already closed and
already returns typed errors.

**Watch:** context resolution runs per request. If a resolver makes an external
call, that latency is now in your p99. Measure `context.trace` per resolver —
[observability](../07-operations/04-observability.md) covers what to emit.

## 3. Edge decisioning

```
  origin ──(publish registry + active exchanges)──► edge nodes
                                                       │
                                        apply() locally, no round trip
                                                       │
                             reserve/redeem ──────► origin (always)
```

**Use when** decision latency matters more than perfect freshness — a storefront
showing prices, a POS terminal that must work with a flaky link.

**The split that makes it safe:** `apply` is a pure function of context and
registry state, so it runs anywhere. `reserve`, `redeem`, `fund` and `pay` touch
counters and budgets and must be central. The capability descriptors already
classify this: `mutating` and `financial` tell you exactly which verbs may not
be pushed to the edge.

**Costs you** staleness. An exchange paused centrally is still live at the edge
until the next publish. Bound it with a short TTL and accept that `apply` at the
edge is a quote, re-validated at `reserve`.

## 4. Multi-region

```
  region A ──┐                     ┌── region A store
             ├── shared registries ┤
  region B ──┘                     └── region B store
```

Registries replicate cleanly — they are immutable configuration and can be
published as versioned bundles.

Counters and budgets do not. A global redemption limit across regions needs
either a single authoritative counter (a latency cost on every reserve) or
per-region sub-budgets (an accuracy cost at the boundaries). There is no third
option, and the choice belongs to the business, not the architecture. Per-region
sub-budgets are usually right: allocate 40% of the budget to each of two regions
plus a central 20% reserve, and rebalance on a schedule.

## 5. Simulation and back-testing

```
 production store ──(snapshot)──► simulation platform, reality: "simulation"
                                       │
                                  same engines, effects detached
```

The `reality` registry makes this a first-class mode rather than a parallel
implementation. `effectsAreBinding: false` means capture runs every computation
and writes nothing.

`capabilities.simulate()` refuses to run in a binding reality — checked, not
assumed, because a simulation that silently hit production would be the worst
bug this platform could have.

**What this buys:** the model you back-test against is the model that runs. The
usual failure mode — a separate simulator that drifts from production over
eighteen months — is structurally impossible here.

---

## Choosing

| If you need | Use |
| --- | --- |
| One application, fastest path | Embedded |
| Several consumers, one answer | Headless service |
| Sub-10ms quotes, tolerable staleness | Edge for `apply`, central for the rest |
| Global limits and global latency | Multi-region with sub-budgets |
| Confidence before a launch | Simulation reality |

## What none of these solve

**Authentication.** Capabilities accept an `actor` string and trust it. Every
topology above needs an identity layer in front.

**Rate limiting.** Nothing here bounds how often a caller may ask.

**Registry distribution.** Publishing registry bundles to edge nodes is
described above but not implemented. See
[known gaps](../08-roadmap/02-known-gaps.md).
