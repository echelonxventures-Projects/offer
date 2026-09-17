# Extending the platform

A practical guide. For the conceptual argument see
[the extension model](../01-architecture/04-extension-model.md); for what
currently exists see [the reference](02-reference.md).

---

## The decision table

Start here. What are you trying to add?

| You want to | Register a | In |
| --- | --- | --- |
| A new way of computing benefit value | `BenefitType` | `deps.benefitTypes` |
| A new thing a benefit does | `EffectKind` | `deps.effectKinds` |
| A new currency, points scheme or resource | `EconomicUnit` | `economic.units` |
| A new class of unit behaviour | `EconomicUnitClass` | `economic.unitClasses` |
| A conversion between units | `ExchangeRate` | `economic.rates` |
| A new calendar | `Calendar` | `temporal.calendars` |
| A new tick size or epoch | `Chronology` | `temporal.chronologies` |
| A new place | `SpatialNode` | `spatial.nodes` |
| A new condition predicate | `RuleOperator` | `registries["rule-operator"]` |
| A new value function for conditions | `RuleFunction` | `registries["rule-function"]` |
| A new context fact | `ContextResolver` | `context.resolvers` |
| A new funding arrangement | `FundingModel` | `deps.fundingModels` |
| A new kind of party | `PartyKind` | `deps.partyKinds` |
| A new definition of "best" | `DecisionObjective` | `registries["decision-objective"]` |
| A new governance rule | `Policy` | `governance.policies` |
| A new risk input | `RiskSignal` | `risk.signals` |
| A new attribution model | `AttributionModel` | `attribution.models` |
| A new family label | `DomainProfile` | `deps.profiles` |
| A new execution partition | `Reality` | `registries["reality"]` |

If your requirement is not in that table, read
[what is not extensible](../01-architecture/04-extension-model.md#what-is-not-extensible)
before writing code.

---

## Where to register

Two options, and the difference matters.

**Bootstrap** — before serving traffic, usually right after constructing the
platform:

```ts
const platform = new GoipPlatform();
platform.deps.benefitTypes.register(myBenefitType);
platform.economic.units.register(myUnit);
```

**Tenant overlay** — a forked registry so one tenant sees something different:

```ts
const units = platform.economic.units.fork("units:acme");
units.override({ key: "POINTS", label: "Acme Stars", scale: 0, unitClass: "points", fungible: true });
```

See [multi-tenancy](../07-operations/05-multi-tenancy.md) for wiring a
tenant-scoped platform.

## Sealing

`seal()` freezes a registry. Bootstrap should seal everything before serving
traffic, so a late registration is a loud error rather than a race:

```ts
for (const registry of Object.values(platform.registries)) registry.seal();
```

Not done automatically, because tests and the examples register at runtime.

---

## Worked example: a whole new domain

Suppose an insurer wants a no-claims discount. Nothing about it exists in the
platform. Here is everything required.

### 1. Is a new benefit type needed?

The discount grows with claim-free years — that is `tiered` with quantity-like
thresholds. **No new type.** Use `tiered` with the years as a counter.

### 2. Is a new effect needed?

It reduces the premium payable. That is `price_reduction`. **No new effect.**

### 3. Is a new unit needed?

Premiums are in an existing currency. **No.**

### 4. Does a condition need something new?

"Claim-free years" is a subject counter, readable with the existing
`subject.counter` function. **No new operator.**

### 5. A profile, for reporting and policy

```ts
platform.deps.profiles.register({
  key: "insurance_no_claims",
  label: "No-claims discount",
  defaultEffect: "price_reduction",
  requiredPolicies: ["funding.declared", "owner.named"],
});
```

### 6. The exchange itself

```ts
caps.create({
  tenant, actor,
  draft: {
    profile: "insurance_no_claims",
    name: "No-claims discount",
    acquisition: { mode: "automatic" },
    conditions: gte(fn("subject.counter", lit("claimFreeYears")), lit(1)),
    benefits: [{
      id: "ncd",
      type: "tiered",
      params: { tiers: [
        { min: "0.00", rate: "10" },
        { min: "0.00", rate: "20" },
      ] },
      effect: "price_reduction",
      cap: { decimal: "500.00" },
    }],
    funding: { model: "single", splits: [{ sourceId: "insurer-underwriting" }] },
    governance: { owner: "underwriting@insurer.example" },
  },
});
```

**Total new platform code: one registry entry, and it is optional.** That is the
architecture working as intended. Most "new domains" require nothing at all.

---

## When you genuinely do need a new handler

The test is whether the *arithmetic* is new, not whether the *product* is new.

New arithmetic — a benefit computed from an external index, a rebate that
depends on cumulative lifetime spend in a way no counter captures — needs a
handler. A new name for a percentage does not.

```ts
platform.deps.benefitTypes.register({
  key: "acme.index_linked",
  label: "Index-linked rebate",
  params: ["indexFacet", "multiplier"],
  unitPolicy: "base",
  compute(input) {
    const index = input.context.facets[String(input.spec.params.indexFacet)];
    if (typeof index !== "number") {
      return fail(ErrorCode.INVALID_REQUEST, "index facet missing from context");
    }
    return ok({
      benefitId: input.spec.id,
      type: input.spec.type,
      effect: input.spec.effect,
      value: multiplyRate(input.base, rate(Math.round(index * 100), 10_000)),
      allocations: [],
      detail: `index ${index} applied to ${toDecimal(input.base)}`,
    });
  },
});
```

Note where the index comes from: a **context facet**, populated by a resolver.
The handler stays pure.

## Rules for handler authors

1. **Be pure.** Same input, same output, always. No clock, no network, no
   randomness.
2. **Return `Result`,** never throw, for anything a caller could cause.
3. **Honour your `unitPolicy`.** The engine verifies it and will reject you.
4. **Never return a negative value.** Benefits are positive; direction is the
   effect's job.
5. **Make `allocations` sum to `value`,** or return none at all.
6. **Write a useful `detail`.** It goes in the trace a support agent reads.
