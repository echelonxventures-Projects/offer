# What is fixed, and what is not

The design goal is that nothing which varies between deployments is compiled
into the platform. This document is the honest accounting of how far that goes,
because a claim of "zero hardcoding" that is not true is worse than a bounded
claim that is.

Three tiers. The distinction between them is **who has to agree to a change**.

| Tier | Change by | Coordination needed |
| --- | --- | --- |
| **1. Deployment** | Registering an entry or setting config | None. Your deployment, your call. |
| **2. Specification** | Editing `spec/`, regenerating vectors | Every conforming implementation |
| **3. Invariant** | Not available | It would be a different system |

---

## Tier 1 — deployment configuration

No code, no coordination, no fork. 27 registries plus a config object.

| What varies | Mechanism |
| --- | --- |
| Currencies, points, resources, entitlements | `economic-unit`, `economic-unit-class` |
| Calendars, chronologies, time zones | `calendar`, `chronology`, `temporal-zone` |
| Places, physical or virtual | `spatial-node`, `spatial-node-kind`, `coordinate-system` |
| How benefit value is computed | `benefit-type` |
| What that value does | `effect-kind` |
| **Where the credit side posts** | `posting-rule` |
| **How account identifiers are formed** | `AccountNaming` strategy |
| **How a subject obtains an offer** | `acquisition-mode` |
| Condition predicates and functions | `rule-operator`, `rule-function` |
| Context facts | `context-resolver` |
| Who pays and how it splits | `funding-model`, `party-kind` |
| **Lifecycle states and their transitions** | `lifecycle-transition` (routes are derived) |
| What "best" means | `decision-objective` |
| Governance rules | `policy` |
| Risk inputs | `risk-signal` |
| Attribution models | `attribution-model` |
| Alert rules | `alert-rule` |
| Periodic work | `maintenance-job` |
| Execution partitions | `reality` |
| Family labels | `domain-profile` |
| Rule depth and node budget | `config.rules` |
| Stacking search boundary | `config.stacking` |
| Retention caps, risk thresholds, sweep batching | `config.counters`, `config.risk`, `config.maintenance` |
| Storage engine | A `PlatformStore` adapter |
| Metrics backend | A `Telemetry` adapter |
| Scheduler | Whatever calls `maintenance.runDue` |
| Audit anchor | An `AuditAnchor` adapter |

The four in bold were **fixed during this audit**. They had been hardcoded since
Phase 0 and nothing was checking — see
[ADR 0015](../06-adr/0015-the-hardcoding-audit.md).

## Tier 2 — specification changes

Possible, but they change the contract every implementation conforms to. A
deployment cannot make these alone, because doing so would make its data
unreadable by another conforming implementation.

| What | Why it is spec-level |
| --- | --- |
| **Rounding modes** | The seven are pinned by 111 L2 conformance vectors. An eighth needs vectors and every implementation. |
| **Canonical encoding** | Changing it changes every hash, forking all existing audit chains. |
| **The wire codec** | `~bigint:` tagging is how exact integers cross a boundary. |
| **Error codes** | The API contract. A new code is a version change for every caller. |
| **The capability list** | Closed at 22. A new verb changes what callers may rely on. |
| **Limit check order** | Normative: the reported breach must be the same whichever implementation answers. |
| **Allocation remainder order** | Largest weight first, ties by index. Changing it changes every split. |

Extending these is a real process: edit `spec/`, regenerate vectors, update the
Go implementation, bump the version. That is the cost of having more than one
implementation, and it is the right cost.

## Tier 3 — architectural invariants

These cannot be configuration. Each is load-bearing for something the platform
exists to guarantee.

### Something executes

There is always a host language. The implementation is TypeScript; the *contract*
is language-neutral, and `conformance/go/` proves a second implementation
reproduces it exactly. That is the achievable version of "language agnostic",
and it is achieved. The unachievable version — software with no implementation —
is not a goal anyone can meet.

### The pipeline order

```
CONTEXT → CONDITIONS → ELIGIBILITY → BENEFIT → EXECUTION → SETTLEMENT → AUDIT
```

Configurable ordering would make this a workflow engine, and every deployment
would define a different platform. The order also encodes real dependencies: a
benefit cannot be computed before eligibility is known, settlement cannot
precede execution, and audit records what happened rather than what might.

### Double entry balances

Every transaction nets to zero within every unit, or the write is refused.
This is an invariant, not a policy. A "single-entry mode" would make the ledger
unreconcilable, which is the one thing it exists to prevent.

### Money is exact integers

Floating point is not a configuration option for a system that computes
liabilities. See [ADR 0002](../06-adr/0002-integer-money-only.md).

### The value exchange has *a* shape

Fields are additive and `metadata` is open, but an engine has to know where to
look for benefits, funding and conditions. "No shape at all" means no engine —
it means every consumer reimplements interpretation, which is the problem
[ADR 0001](../06-adr/0001-one-record-for-every-domain.md) exists to solve.

### Results, not exceptions

Structural. Every capability returns `Result`, and the compiler enforces
handling. See [ADR 0005](../06-adr/0005-results-not-exceptions.md).

---

## How this is enforced

Not by good intentions. `test/extensibility.test.ts` contains a guard that
greps `src/engines` and `src/ledger` for comparisons against registry-key
literals:

```ts
[/effect\.key\s*===\s*["']/,        "branching on an effect kind"],
[/acquisition\.mode\s*===\s*["']/,  "branching on an acquisition mode"],
[/\.profile\s*===\s*["']/,          "branching on a domain profile"],
[/\bswitch\s*\(\s*\w*\.?(mode|kind|profile|effect|type)\b/, "switching on a registry key"],
```

Plus the existing Law 1 guard against domain vocabulary in engines, and a check
that tuning constants are not reintroduced as bare module-level literals.

Three violations survived three phases because nothing was checking. The guard
is the difference between a principle and a property.

## What is still legitimately a `switch`

Two remain, and both are correct:

- `src/kernel/canonical.ts` — `switch (typeof value)`. JavaScript type dispatch,
  not domain dispatch.
- `src/universal/economic/amount.ts` — `switch (mode)` over rounding modes. A
  Tier 2 set, pinned by conformance vectors. Making it a registry would let a
  deployment silently diverge from the specification it claims to implement.

The second is the interesting one: **not everything should be extensible.**
Extensibility where the specification needs agreement is not flexibility, it is
a way to produce two systems that both claim to be conforming and disagree.
