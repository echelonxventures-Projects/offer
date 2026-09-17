# Layers

Eight layers. Each may call downward and sideways within its own layer. None may
call upward. This is the only structural rule in the codebase, and it is what
keeps the kernel reusable and the engines domain-free.

| # | Layer | Directory | May depend on | Must never |
| --- | --- | --- | --- | --- |
| 8 | Capabilities | `src/capabilities` | 1–7 | Be bypassed by a caller |
| 7 | Platform | `src/platform` | 1–6 | Contain business logic |
| 6 | Engines | `src/engines`, `src/ledger`, `src/attribution` | 1–5 | Know a profile name, or import another engine's internals |
| 5 | Model | `src/model` | 1–4 | Contain behaviour beyond pure construction |
| 4 | Universal domains | `src/universal` | 1–3 | Assume a currency, calendar, country or planet |
| 3 | Context / Rules | `src/context`, `src/rules` | 1–2, 4 | Perform I/O, or be unbounded |
| 2 | Registry | `src/registry` | 1 | Know what any entry means |
| 1 | Kernel | `src/kernel` | nothing | Know about money, time, place, or offers |
| 0 | Ports | `src/adapters/store.ts` | 1, 5 | Be imported concretely by an engine |

---

## 1. Kernel — `src/kernel`

Result types, the error vocabulary, canonical JSON, hashing, id factories,
branded types.

**The rule:** the kernel must remain usable in a completely different product.
Its test is `test/platform.test.ts` → *"the kernel knows nothing about money,
time or place either"*, which greps for `usd`, `gregorian`, `country`,
`latitude` and `timezone`.

Key decision: `Result<T, E>` rather than exceptions. An offer that does not apply
is an answer carrying reasoning, not an exceptional condition.
See [ADR 0005](../06-adr/0005-results-not-exceptions.md).

## 2. Registry — `src/registry`

One generic class. Register, override, require, list, seal, fork, describe.

**The rule:** a registry never knows what its entries mean. It is a map with
provenance, error messages that name what was available, and the ability to
enumerate itself.

`fork()` is what makes tenant overlays possible: a child registry inherits every
entry and may shadow any of them without touching the parent.

## 3. Context and rules — `src/context`, `src/rules`

Context resolution assembles facts and freezes them. The rule evaluator answers
predicates against those facts.

**The rule:** both must be total. The evaluator has a depth limit and a node
budget and performs no I/O. If eligibility needs an external fact, a context
*resolver* fetches it before the rules run — which is why the latency is visible
in the context trace rather than hidden inside a condition.

## 4. Universal domains — `src/universal`

Economic, temporal, spatial, reality. Each exposes an *Authority* — the single
object that answers every question about that domain.

**The rule:** no engine reads a unit table, a calendar or a node list directly.
It asks the authority. That indirection is what allows a tenant to fork the
registries per deployment without any engine noticing.

## 5. Model — `src/model`

`ValueExchange` and the types it is built from. Almost entirely interfaces; the
only behaviour is the lifecycle transition table and the benefit handlers, and
the handlers are pure functions of their input.

**The rule:** no persistence, no I/O, no engine references. A model type must be
serialisable to JSON with the sole exception of `bigint` amounts, which the
canonical encoder handles explicitly.

## 6. Engines — `src/engines`, `src/ledger`, `src/attribution`

Where the work happens. Eleven engines, each with one job.

**The rules:**
- No engine imports another engine's internals. `DecisionEngine` composes
  `EligibilityEngine`, `BenefitResolutionEngine` and `StackingEngine` by
  constructing them, and everything else arrives through `EngineDeps`.
- No engine constructs its own dependencies or reads a module-level singleton.
  This is what permits two tenants, two realities or a replay harness in one
  process.
- No engine mentions a domain word. Enforced by test.

## 7. Platform — `src/platform`

The composition root. Constructs every registry, authority, engine and store
once and wires them together. `describe()` reports the resulting extension
surface.

**The rule:** it is a constructor, not logic. If a decision is being made here,
it belongs in an engine.

## 8. Capabilities — `src/capabilities`

Twenty-two verbs. The whole external surface.

**The rules:**
- A caller reaches nothing else. If something is needed and no capability
  exposes it, the fix is a capability, not a leak.
- The vocabulary is value exchange, never coupon or cashback.
- Every capability takes a `ContextRequest` and resolves it, so callers never
  assemble a context themselves.

## 0. Ports and adapters — `src/adapters`

Seven storage interfaces and one in-memory implementation.

**The rule:** engines depend on the interfaces. `MemoryPlatformStore` is passed
in by the composition root and is the only concrete implementation in the
repository. What a real adapter must guarantee — particularly counter atomicity —
is in [persistence](../07-operations/01-persistence.md).

---

## Checking the rule

There is no build-time enforcement of layering; TypeScript will not stop an
upward import. What exists instead:

- The two grep tests in `test/platform.test.ts` for layers 1 and 6.
- Import review. Upward imports are visible because every import in this
  codebase is an explicit relative path with a `.ts` extension.

If this grew, a dependency-cruiser rule would be the next step. It is listed in
[known gaps](../08-roadmap/02-known-gaps.md).
