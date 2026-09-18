# GOIP documentation

Organised so you can start anywhere, but if you are new, read in this order:

1. [Mission](00-mission/01-mission.md) — what this is for
2. [Constitution](00-mission/02-constitution.md) — the nine laws, and their tests
3. [Honest scope](00-mission/03-honest-scope.md) — what the claims actually mean
4. [Architecture overview](01-architecture/01-overview.md)
5. [The decision pipeline](01-architecture/03-decision-pipeline.md)
6. Then whichever engine or domain you need.

---

## 00 — Mission

| Document | Contents |
| --- | --- |
| [01 Mission](00-mission/01-mission.md) | The problem, and why a general kernel is the answer |
| [02 Constitution](00-mission/02-constitution.md) | Nine laws, how each is enforced, where the test lives |
| [03 Honest scope](00-mission/03-honest-scope.md) | What "no redesign" can and cannot mean |
| [04 Glossary](00-mission/04-glossary.md) | Every term, defined once |

## 01 — Architecture

| Document | Contents |
| --- | --- |
| [01 Overview](01-architecture/01-overview.md) | The whole system on one page |
| [02 Layers](01-architecture/02-layers.md) | The eight layers and what may call what |
| [03 Decision pipeline](01-architecture/03-decision-pipeline.md) | Request to decision to money, step by step |
| [04 Extension model](01-architecture/04-extension-model.md) | How to add anything without touching an engine |
| [05 Data model](01-architecture/05-data-model.md) | `ValueExchange` and every part of it |
| [06 Incentive graph](01-architecture/06-incentive-graph.md) | Nodes, edges, and the queries they answer |
| [07 Deployment topologies](01-architecture/07-deployment-topologies.md) | Embedded, service, edge, multi-region |
| [08 What is fixed](01-architecture/08-what-is-fixed.md) | The three tiers: deployment, specification, invariant |

## 02 — Domains

| Document | Contents |
| --- | --- |
| [01 Domain catalog](02-domains/01-domain-catalog.md) | All 67 specification domains, mapped to where they live |
| [02 Profiles](02-domains/02-profiles.md) | The eleven profiles and how to add one |

## 03 — Engines

| Document | Contents |
| --- | --- |
| [01 Context resolution](03-engines/01-context-resolution.md) | Assembling a frozen, replayable context |
| [02 Rule evaluation](03-engines/02-rule-evaluation.md) | The condition language and its limits |
| [03 Eligibility](03-engines/03-eligibility.md) | Ten checks, and why every one is reported |
| [04 Benefit resolution](03-engines/04-benefit-resolution.md) | Targeting, computation, capping, effects |
| [05 Stacking and conflict](03-engines/05-stacking-and-conflict.md) | Combination search, ordering, objectives |
| [06 Decision](03-engines/06-decision.md) | The orchestrator and the decision record |
| [07 Execution](03-engines/07-execution.md) | Reserve, capture, release, reverse |
| [08 Settlement](03-engines/08-settlement.md) | Funding allocation and double-entry posting |
| [09 Governance](03-engines/09-governance.md) | Policies, lifecycle, approvals |
| [10 Risk](03-engines/10-risk.md) | Signals, scoring, dispositions |
| [11 Discovery](03-engines/11-discovery.md) | Listing and ranking what is available |
| [12 Attribution](03-engines/12-attribution.md) | Journeys, models, exact credit division |

## The specification (language-neutral)

Everything in [`spec/`](../spec/README.md) is independent of TypeScript.

| Document | Contents |
| --- | --- |
| [Specification overview](../spec/README.md) | What is normative, and the conformance levels |
| [Conformance](../spec/conformance.md) | How to run the vectors and declare a level |
| [Encoding](../spec/encoding.md) | Canonical hashing form and the wire codec |
| [Rule language](../spec/rule-language.md) | The condition AST, normative parts only |
| [Storage contract](../spec/storage-contract.md) | L5 obligations, in any database |
| [`spec/vectors/`](../spec/vectors) | 289 frozen behaviour cases |
| [`spec/schema/`](../spec/schema) | JSON Schema for the data model |
| [`conformance/go/`](../conformance/go) | Independent Go implementation, L1–L4 |

## 04 — Registries

| Document | Contents |
| --- | --- |
| [01 Extending](04-registries/01-extending.md) | How to register each kind of thing, with code |
| [02 Reference](04-registries/02-reference.md) | Generated from the running platform |

## 05 — API

| Document | Contents |
| --- | --- |
| [01 Capabilities](05-api/01-capabilities.md) | All 22 verbs, with signatures and examples |
| [02 Errors](05-api/02-errors.md) | Every error code and what to do about it |
| [03 Rule language](05-api/03-rule-language.md) | Complete condition-language reference |

## 06 — Decision records

| ADR | Decision |
| --- | --- |
| [0001](06-adr/0001-one-record-for-every-domain.md) | One record for every domain |
| [0002](06-adr/0002-integer-money-only.md) | Integer money only |
| [0003](06-adr/0003-bounded-stacking-search.md) | Bounded stacking search |
| [0004](06-adr/0004-no-regex-in-rules.md) | No regular expressions in rules |
| [0005](06-adr/0005-results-not-exceptions.md) | Results, not exceptions |
| [0006](06-adr/0006-two-phase-execution.md) | Two-phase execution |
| [0007](06-adr/0007-registry-driven-time-and-space.md) | Registry-driven time and space |
| [0008](06-adr/0008-visibility-is-not-applicability.md) | Visibility is not applicability |
| [0009](06-adr/0009-hash-chained-audit.md) | Hash-chained audit, not blockchain |
| [0010](06-adr/0010-no-implicit-unit-conversion.md) | No implicit unit conversion |
| [0011](06-adr/0011-no-read-check-write-in-the-port.md) | No read-check-write in the storage port |
| [0012](06-adr/0012-sqlite-as-the-reference-durable-adapter.md) | SQLite as the reference durable adapter |
| [0013](06-adr/0013-conformance-vectors-as-the-portability-contract.md) | Conformance vectors as the portability contract |
| [0014](06-adr/0014-observability-as-ports-not-vendors.md) | Observability as ports, not vendors |
| [0015](06-adr/0015-the-hardcoding-audit.md) | The hardcoding audit |

## 07 — Operations

| Document | Contents |
| --- | --- |
| [01 Persistence](07-operations/01-persistence.md) | What a real storage adapter must guarantee |
| [02 Concurrency and scaling](07-operations/02-concurrency-and-scaling.md) | Where this breaks under load, and what to do |
| [03 Security](07-operations/03-security.md) | Threat model and controls |
| [04 Observability](07-operations/04-observability.md) | What to log, measure and alert on |
| [05 Multi-tenancy](07-operations/05-multi-tenancy.md) | Isolation model and tenant overlays |
| [06 Runbook](07-operations/06-runbook.md) | The incidents you will actually have |
| [07 Maintenance](07-operations/07-maintenance.md) | What runs periodically, and what breaks if it does not |

## 08 — Roadmap

| Document | Contents |
| --- | --- |
| [01 Phases](08-roadmap/01-phases.md) | A sequenced path from here to production |
| [02 Known gaps](08-roadmap/02-known-gaps.md) | Everything missing, listed honestly |
