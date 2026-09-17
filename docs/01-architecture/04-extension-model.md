# Extension model

Everything you can add without changing an engine, with the code to add it.

The rule underneath all of this: **if adding something requires editing a
`switch`, the design is wrong and the review should reject it.**

---

## The mechanism

One generic class, `Registry<T>`, used twenty-three times.

```ts
const registry = new Registry<MyEntry>("my-registry");
registry.register({ key: "acme.thing", label: "Acme thing", /* ... */ });
registry.require("acme.thing");   // Result<MyEntry>, error names what was available
registry.list();                  // sorted, enumerable
registry.seal();                  // no further registration
registry.fork("tenant-a");        // inherits everything, may shadow anything
```

Enumerability is the property that matters most. It is why
`platform.describe()` can inventory the whole extension surface, and why
[the registry reference](../04-registries/02-reference.md) is generated rather
than written by hand.

---

## Adding a benefit type

The most common extension. A benefit type answers *how much*.

```ts
platform.deps.benefitTypes.register({
  key: "acme.carbon_rebate",
  label: "Carbon rebate",
  params: ["gramsPerUnit"],
  unitPolicy: "declared",          // mints value in its own unit
  compute(input) {
    const grams = Number(input.spec.params.gramsPerUnit ?? 0);
    const wholeUnits = input.base.minor / 10n ** BigInt(input.base.scale);
    return ok({
      benefitId: input.spec.id,
      type: input.spec.type,
      effect: input.spec.effect,
      value: { unit: input.unit, scale: input.scale, minor: wholeUnits * BigInt(grams) },
      allocations: [],
      detail: `${grams}g per unit of ${input.base.unit}`,
    });
  },
});
```

`unitPolicy` is the field to get right:

- `"base"` — the value comes out in the interaction's unit. 10% of a USD basket
  is USD. Declaring a different `spec.unit` is then an authoring error and the
  engine refuses it rather than ignoring the field.
- `"declared"` — the handler mints value in `spec.unit`.

This exact handler is in `test/platform.test.ts`, where it is registered at
runtime and asserted to work end to end.

## Adding an effect kind

An effect answers *what the value does*.

```ts
platform.deps.effectKinds.register({
  key: "acme.carbon_offset",
  label: "Carbon offset retired on the subject's behalf",
  reducesPayable: false,      // does not come off the price
  createsLiability: false,    // we do not owe it back
  requiresSettlement: true,   // but somebody funds it
});
```

Those three booleans are all the settlement engine needs to decide which
accounts a benefit posts to.

## Adding an economic unit

```ts
platform.economic.units.register({
  key: "WATER_LITRE",
  label: "Potable water ration",
  scale: 3,
  unitClass: "resource",
  fungible: true,
});
```

If the unit's behaviour is genuinely new, register a class too:

```ts
platform.economic.unitClasses.register({
  key: "ration",
  label: "Rationed resource",
  transferable: false,   // cannot be paid out
  exchangeable: false,   // cannot be converted
  liability: true,       // but we do owe it
});
```

`transferable: false` is load-bearing — it is what makes `pay` refuse to wire
loyalty points to a bank account.

## Adding a calendar

```ts
platform.temporal.calendars.register({
  key: "acme.retail-454",
  label: "4-5-4 retail calendar",
  chronology: "earth.unix.ms",
  fieldNames: ["retailYear", "retailQuarter", "retailWeek", "retailDay"],
  decompose(instant, zone) { /* → { retailYear: 2026, retailWeek: 37, ... } */ },
  compose(fields, zone)    { /* → Instant */ },
});
```

Any rule can now say `{ op: "temporal.field", field: "retailWeek", in: [37, 38] }`.
The eligibility engine has no idea a retail calendar exists.

`fiscalCalendar()` in `src/universal/temporal/calendars.ts` shows the pattern of
deriving one calendar from another rather than reimplementing the arithmetic.

## Adding a place

```ts
platform.spatial.nodes.register({
  key: "earth.in.br.patna.store-02",
  label: "Patna Store 02",
  kind: "site",
  parent: "earth.in.br.patna",
});
platform.spatial.invalidate();   // clears the path cache
```

Remember `invalidate()` after mutating the node registry. Paths are cached.

## Adding a rule operator

```ts
platform.registries["rule-operator"].register({
  key: "acme.hasValidPrescription",
  label: "Subject holds a valid prescription",
  args: ["forDrugClass"],
  evaluate(node, ctx) {
    const held = ctx.context.facets["prescriptions"] ?? [];
    const valid = Array.isArray(held) && held.includes(node.forDrugClass);
    return ok({ result: valid, detail: `${(held as unknown[]).length} on file` });
  },
});
```

Operators are pure and must remain so. If the answer needs an external call, put
it in a context resolver and read it from a facet here — which is exactly what
this example does.

## Adding a context resolver

```ts
const platform = new GoipPlatform({
  contextResolvers: [{
    key: "acme.risk-score",
    label: "Device risk score",
    stage: "enrich",
    order: 50,
    resolve({ request, draft }) {
      const deviceId = request.facets?.deviceId;
      if (typeof deviceId !== "string") return ok(null);   // recorded as a skip
      draft.facets.risk = { score: lookupScore(deviceId) };
      return ok(`risk score attached for ${deviceId}`);
    },
  }],
});
```

Stages run `base` → `enrich` → `derive`; within a stage, `order` ascending, ties
broken on key. Returning `null` records a skip in the trace rather than silence.

## Adding a funding model

```ts
platform.deps.fundingModels.register({
  key: "acme.brand-first",
  label: "Brand absorbs first, merchant covers the rest",
  strategy: "waterfall",
});
```

The two strategies (`proportional`, `waterfall`) are the mechanism; a model is a
named configuration of one. Genuinely new *mechanics* would be an engine change,
and that is called out honestly in [known gaps](../08-roadmap/02-known-gaps.md).

## Adding an objective

```ts
platform.registries["decision-objective"].register({
  key: "acme.max_margin",
  label: "Protect margin",
  score: (combination, context) => -combination.payableReduction.minor,
});
```

Scores are `bigint`, so comparisons are exact. Higher wins. Remember that a
combination applying nothing is handled by the tie-break, not by the score — see
[the constitution, Law 9](../00-mission/02-constitution.md).

## Adding a policy

```ts
platform.governance.policies.register({
  key: "acme.max_discount",
  label: "No single offer may exceed 40%",
  severity: "error",
  profiles: ["coupon", "promotion"],     // omit for all profiles
  check({ exchange }) {
    const offenders = exchange.benefits
      .filter((b) => b.type === "percentage" && Number(b.params.rate) > 40)
      .map((b) => ({
        policy: "acme.max_discount",
        severity: "error" as const,
        message: `benefit '${b.id}' is ${b.params.rate}%`,
        path: `benefits.${b.id}.params.rate`,
      }));
    return ok(offenders);
  },
});
```

`error` blocks publication; `warning` is reported and does not.

## Adding a risk signal, attribution model or profile

Same pattern. The registries are `risk-signal`, `attribution-model` and
`domain-profile`; their entry shapes are in
[the reference](../04-registries/02-reference.md).

---

## Tenant overlays

`fork()` gives a tenant its own view of a registry without affecting anyone else:

```ts
const tenantUnits = platform.economic.units.fork("units:acme");
tenantUnits.override({ key: "POINTS", label: "Acme Stars", scale: 0, unitClass: "points", fungible: true });
```

Construct that tenant's authorities with the forked registries and hand them to
a tenant-scoped `GoipPlatform`. Because nothing in `src` reads a module-level
singleton, two such platforms coexist in one process. See
[multi-tenancy](../07-operations/05-multi-tenancy.md).

---

## What is *not* extensible

Stated plainly, so nobody discovers it late:

- **The capability list.** Twenty-two verbs, closed. A new verb changes the
  platform's contract with its callers and is a version change, not config.
- **The pipeline order.** Context before conditions before eligibility before
  benefit before execution. Reordering is a redesign.
- **The `ValueExchange` shape.** New *fields* are additive and cheap; a new
  top-level concept alongside it is not.
- **Double entry.** Every movement is two or more balancing entries. There is no
  single-entry mode.
- **Funding *mechanics*.** Proportional and waterfall are implemented; a model
  needing genuinely different mechanics needs engine work.
