# Rule Evaluator

`src/rules/`

Conditions are data: JSON that can be stored, versioned, diffed, approved,
shipped to an edge node, replayed three years later, and shown to a regulator.

## The AST

Two kinds of node.

**Rule nodes** — `{ op, ...args }`, where `op` selects a registered operator:

```json
{ "op": "all", "of": [
  { "op": "gte", "left": { "path": "cart.subtotal" }, "right": { "amount": { "unit": "INR", "decimal": "500.00" } } },
  { "op": "spatial.within", "nodes": ["earth.in"] },
  { "op": "temporal.field", "field": "dayOfWeek", "in": [6, 7] },
  { "op": "subject.hasSegment", "segments": ["new-customer"] }
] }
```

**Terms** — values inside a node:

| Form | Meaning |
| --- | --- |
| `{ "path": "cart.subtotal" }` | Read the context; optional `default` |
| `{ "literal": 5 }` | A constant |
| `{ "amount": { "unit": "USD", "decimal": "10.00" } }` | Money, parsed against the unit registry |
| `{ "fn": "cart.quantityIn", "args": [...] }` | A registered function |

Bare JSON in an argument position is treated as a literal, so hand-written and
console-generated rules interoperate.

Builders in `src/rules/ast.ts` make hand-authoring bearable:

```ts
all(
  gte(path("cart.subtotal"), money("INR", "500.00")),
  withinPlace(["earth.in"]),
  { op: "temporal.field", field: "dayOfWeek", in: [6, 7] },
)
```

## Total by construction

| Guard | Default | Why |
| --- | --- | --- |
| Depth limit | 32 | Bounds recursion |
| Node budget | 5 000 | Bounds total work, including term resolution |
| No I/O | — | Evaluation is a pure function of the frozen context |
| No unbounded loops | — | Iteration is bounded by the rule's own literal arrays |
| No regex | — | See [ADR 0004](../06-adr/0004-no-regex-in-rules.md) |

Exceeding a limit is a `RULE_ERROR` naming which limit, not a silent `false`.

## Why there is no regex

A tenant-authored pattern evaluated on the request path is a denial-of-service
waiting to happen — catastrophic backtracking turns a 40-character pattern into
seconds of CPU per request.

String matching is a `glob` operator with `*` and `?`, implemented as a
two-pointer scan with a single backtrack point. Linear in the input, and there
is no pattern that makes it blow up. `test/rules.test.ts` runs the input that
would kill a backtracking regex and asserts it completes in under 250 ms.

## Comparison rules

One place decides what "greater than" means: `src/rules/compare.ts`.

- Money compares against money, exactly, via the economic authority.
- Numbers and bigints compare across representations (`5n === 5`).
- Strings compare lexicographically; booleans compare `false < true`.
- **Mixed, meaningless comparisons are errors**, not `false`.

That last one matters. Comparing a string to money returns `RULE_ERROR`, because
silently returning `false` hides an authoring mistake until it costs money.

## The trace

Every evaluated node lands in the trace with its depth and an operator-supplied
explanation:

```
  gte -> true (109700INR vs 50000INR)
  spatial.within -> true (matched earth.in)
  temporal.field -> true (dayOfWeek=6)
  subject.hasSegment -> true (holds [new-customer])
all -> true (6 children satisfied)
```

Logical operators short-circuit, and the trace says which child decided:
`all -> false (child 1 failed)`. The un-evaluated children are absent, which is
correct — they genuinely did not run.

## An absent condition

`conditions: undefined` is satisfied. An offer with no eligibility rules is open
to everyone, which is the right default and the one authors expect.

## Shipped operators

**Logic:** `all`, `any`, `none`, `not`, `always`, `never`
**Comparison:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `between`
**Membership:** `exists`, `in`, `notIn`, `includesAny`, `includesAll`, `sizeOf`, `glob`
**Domain:** `spatial.within`, `spatial.jurisdiction`, `temporal.within`,
`temporal.field`, `subject.hasSegment`, `subject.hasMembership`

**Functions:** `list`, `cart.quantityIn`, `cart.subtotalOf`, `cart.hasSku`,
`cart.merchants`, `subject.counter`, `facet`

Full reference: [the rule language](../05-api/03-rule-language.md).

## A note on calendar fields

`temporal.field` reads whatever the context calendar publishes. On Gregorian
that is `dayOfWeek`; on the Martian calendar it is `sol`. Asking for a field the
calendar does not publish returns `false` with an explanation — not an error —
because a rule written for one calendar should simply never fire on another.

Asking for it in a *window* is different: `validateWindow` rejects it at
authoring time, via the `window.valid` policy, because a window constraint
naming a non-existent field is always a mistake.
