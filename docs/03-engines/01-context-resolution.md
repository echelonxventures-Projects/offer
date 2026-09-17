# Context Resolution Engine

`src/context/resolution-engine.ts`

Turns a thin request into a complete, frozen `ResolvedContext`.

## The shape problem

The specification lists twenty-five kinds of context. Modelling twenty-five
fixed fields would be a lie — the twenty-sixth arrives next quarter.

So the context has a small **structural core** (the facts every engine needs to
do arithmetic and containment) plus an open `facets` map:

```ts
{
  reality, tenant, correlationId, instant,
  temporal: { chronology, calendar, zone, fields },
  spatial:  { place?, path, jurisdiction? },
  economic: { unit, scale },
  subject:  { id?, anonymous, segments, tier?, memberships, counters, attributes },
  cart?:    { lines, subtotal, itemCount, lineCount },
  channel?,
  facets:   { [key]: Json },     // risk, device, inventory, campaign, weather...
  trace:    ContextTraceEntry[],
}
```

Rules address both halves through the same dotted paths: `cart.subtotal`,
`subject.counters.redemptions`, `facets.risk.score`.

## The pipeline

Three stages, each a registry of resolvers:

| Stage | Purpose | Shipped resolvers |
| --- | --- | --- |
| `base` | Structural facts | `core.temporal` (10), `core.spatial` (20), `core.economic` (30) |
| `enrich` | External lookups | `core.subject` (10) |
| `derive` | Computed from enriched data | `core.cart` (10) |

Ordering is `stage`, then `order` ascending, then `key` — fully deterministic.

The stages exist because of real dependencies: cart totals cannot be computed
before the economic unit is known, and segments cannot be derived before the
subject is loaded.

## The trace

Every resolver is recorded, including the ones that did nothing:

```ts
[
  { resolver: "core.temporal", outcome: "applied", note: "instant=1789813800000 calendar=gregorian zone=UTC" },
  { resolver: "core.spatial",  outcome: "applied", note: "place=earth.in.br.patna jurisdiction=IN-BR" },
  { resolver: "core.economic", outcome: "applied", note: "unit=INR" },
  { resolver: "core.subject",  outcome: "applied", note: "subject=subject-1" },
  { resolver: "core.cart",     outcome: "applied", note: "subtotal=109700 items=3" },
]
```

A skip is recorded as `outcome: "skipped"`, not omitted. Silence is
indistinguishable from failure, and this is the first thing anyone reads when a
decision looks wrong.

## Freezing

The result is deep-frozen before any engine sees it. Two engines reading the
same context must see identical bytes, or a decision cannot be replayed.

`test/platform.test.ts` asserts that assigning to a resolved context throws.

## What it refuses

**No economic unit.** A context with neither `unit` nor a priced cart is refused
with `INVALID_REQUEST`, because every downstream computation needs to know what
unit it is working in. Guessing would be worse.

**An unknown place, calendar, zone, unit or reality.** Each returns
`UNKNOWN_REGISTRY_ENTRY` naming the registry and listing what was available.

**A negative or non-integer cart quantity.** Caught in `core.cart`.

A resolver failure aborts resolution and returns the partial trace in the error
details, so a misconfigured resolver is diagnosable from the error alone.

## Adding a resolver

```ts
new GoipPlatform({
  contextResolvers: [{
    key: "acme.inventory",
    label: "Stock levels for cart lines",
    stage: "enrich",
    order: 20,
    resolve({ request, draft }) {
      if (!request.cart) return ok(null);                  // recorded as a skip
      draft.facets.inventory = lookupStock(request.cart.lines);
      return ok(`stock checked for ${request.cart.lines.length} line(s)`);
    },
  }],
});
```

A condition can then read `{ path: "facets.inventory.TEA-500" }`.

## The rule about I/O

External calls belong **here**, not in a rule operator. Rules must be pure and
bounded so evaluation is total and replayable. A resolver is where latency and
failure are allowed to live, and the trace makes that cost visible.
