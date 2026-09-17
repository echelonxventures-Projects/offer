# Rule language reference

Conditions are JSON. This is the complete vocabulary.

---

## Structure

A rule is a **node**: `{ "op": "...", ...args }`. Arguments are **terms** or
nested nodes.

```json
{ "op": "all", "of": [
  { "op": "gte",
    "left":  { "path": "cart.subtotal" },
    "right": { "amount": { "unit": "USD", "decimal": "50.00" } } },
  { "op": "subject.hasSegment", "segments": ["member"] }
] }
```

## Terms

| Form | Resolves to |
| --- | --- |
| `{ "path": "cart.subtotal" }` | A value from the context |
| `{ "path": "x.y", "default": 0 }` | …or the default if absent |
| `{ "literal": 5 }` | The constant |
| `{ "amount": { "unit": "USD", "decimal": "10.00" } }` | An exact `Amount` |
| `{ "fn": "cart.quantityIn", "args": [...] }` | A function's return value |

Bare JSON in an argument position is treated as a literal.

## Context paths

| Path | Type |
| --- | --- |
| `reality`, `tenant`, `correlationId`, `channel` | string |
| `instant.tick`, `instant.chronology` | bigint, string |
| `temporal.calendar`, `temporal.zone` | string |
| `temporal.fields.<name>` | number — whatever the calendar publishes |
| `spatial.place`, `spatial.jurisdiction` | string |
| `spatial.path` | string[] — root-to-leaf ancestry |
| `economic.unit`, `economic.scale` | string, number |
| `subject.id`, `subject.tier` | string |
| `subject.anonymous` | boolean |
| `subject.segments`, `subject.memberships` | string[] |
| `subject.counters.<name>` | number |
| `subject.attributes.<name>` | any |
| `cart.subtotal` | Amount |
| `cart.itemCount`, `cart.lineCount` | number |
| `cart.lines` | CartLine[] |
| `cart.lines.0.sku` | indexed access works |
| `facets.<key>...` | anything a resolver put there |

## Operators

### Logic

| Op | Args | True when |
| --- | --- | --- |
| `all` | `of: Node[]` | Every child is true. Short-circuits. |
| `any` | `of: Node[]` | Any child is true. Short-circuits. |
| `none` | `of: Node[]` | No child is true. |
| `not` | `of: Node` | The child is false. |
| `always` | — | Always |
| `never` | — | Never |

### Comparison

| Op | Args | Notes |
| --- | --- | --- |
| `eq`, `ne` | `left`, `right` | Structural equality; `5n` equals `5` |
| `gt`, `gte`, `lt`, `lte` | `left`, `right` | Ordering |
| `between` | `value`, `low`, `high` | Inclusive both ends |

Comparing incomparable things (a string against money) is a **`RULE_ERROR`**,
not `false`.

### Membership and shape

| Op | Args | True when |
| --- | --- | --- |
| `exists` | `value` | Not null and not undefined |
| `in` | `value`, `options` | `value` appears in the array |
| `notIn` | `value`, `options` | It does not |
| `includesAny` | `collection`, `values` | Any wanted value is present |
| `includesAll` | `collection`, `values` | All are |
| `sizeOf` | `collection`, `gte?`, `lte?` | Length is within bounds |
| `glob` | `value`, `pattern` | Wildcard match with `*` and `?` |

There is no regex operator. See
[ADR 0004](../06-adr/0004-no-regex-in-rules.md).

### Domain

| Op | Args | True when |
| --- | --- | --- |
| `spatial.within` | `nodes`, `exclude?` | The context place is inside any node and not inside an exclusion |
| `spatial.jurisdiction` | `in` | The resolved jurisdiction is listed |
| `temporal.within` | `window` | The instant is inside the window |
| `temporal.field` | `field`, `in?`, `min?`, `max?` | The named calendar field matches |
| `subject.hasSegment` | `segments`, `mode?` | Any (default) or all segments held |
| `subject.hasMembership` | `memberships` | Any membership held |

`temporal.field` returns **false**, not an error, for a field the calendar does
not publish — so a rule written for a Martian calendar simply never fires on a
Gregorian one.

## Functions

| Function | Arity | Returns |
| --- | --- | --- |
| `list` | variadic | Its arguments as an array |
| `cart.quantityIn` | 1 | Total quantity in the given categories |
| `cart.subtotalOf` | 1 | `Amount` for lines in the given categories |
| `cart.hasSku` | 1 | Whether any line matches the SKU globs |
| `cart.merchants` | 0 | Sorted, distinct merchants in the cart |
| `subject.counter` | 1 | Named counter; missing reads as `0` |
| `facet` | 2 | `facets.<key>`, or the fallback |

## Limits

| Guard | Default |
| --- | --- |
| Nesting depth | 32 |
| Node and term budget | 5 000 |

Exceeding either is a `RULE_ERROR` naming the limit.

## Worked examples

**Weekend, in India, over ₹500, first three redemptions:**

```json
{ "op": "all", "of": [
  { "op": "temporal.field", "field": "dayOfWeek", "in": [6, 7] },
  { "op": "spatial.within", "nodes": ["earth.in"] },
  { "op": "gte", "left": { "path": "cart.subtotal" },
                 "right": { "amount": { "unit": "INR", "decimal": "500.00" } } },
  { "op": "lt", "left": { "fn": "subject.counter", "args": [{ "literal": "redemptions.total" }] },
                "right": { "literal": 3 } }
] }
```

**At least two grocery items, excluding one city:**

```json
{ "op": "all", "of": [
  { "op": "gte", "left": { "fn": "cart.quantityIn", "args": [{ "literal": ["grocery"] }] },
                 "right": { "literal": 2 } },
  { "op": "spatial.within", "nodes": ["earth.in"], "exclude": ["earth.in.mh.mumbai"] }
] }
```

**Gold or platinum members, but not on clearance lines:**

```json
{ "op": "all", "of": [
  { "op": "in", "value": { "path": "subject.tier" }, "options": { "literal": ["gold", "platinum"] } },
  { "op": "not", "of": { "op": "eq",
      "left":  { "fn": "cart.hasSku", "args": [{ "literal": ["CLEARANCE-*"] }] },
      "right": { "literal": true } } }
] }
```

**Every third sol, in Olympus Territory:**

```json
{ "op": "all", "of": [
  { "op": "temporal.field", "field": "sol", "min": 0 },
  { "op": "spatial.within", "nodes": ["mars.olympus"] }
] }
```

For the modulo form, use a window constraint:
`{ "field": "sol", "modulo": 3, "remainder": 0 }`.

## Authoring with builders

```ts
import { all, gte, path, money, fn, lit, withinPlace } from "./src/rules/ast.ts";

all(
  gte(path("cart.subtotal"), money("INR", "500.00")),
  withinPlace(["earth.in"]),
  { op: "temporal.field", field: "dayOfWeek", in: [6, 7] },
);
```

The builders produce exactly the JSON above. Use them in seed data and tests;
store the JSON.
