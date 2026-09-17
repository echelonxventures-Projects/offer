# Conformance

How to check an implementation, and what it may then claim.

---

## Running the vectors

Each file in `vectors/` is one suite:

```json
{
  "suite": "amount",
  "level": "L2",
  "description": "...",
  "cases": [
    { "id": "percent:12.5%of12.34:half_even",
      "input":  { "op": "multiplyRate", "amount": {...}, "percent": "12.5", "mode": "half_even" },
      "expect": { "amount": { "unit": "USD", "minor": "154", "scale": 2 } } }
  ]
}
```

A runner reads the file, produces a result for each case, and compares. Compare
by **canonical form**, not by string equality of your own serialiser — key
order is not part of the expectation, values are.

Two conventions the runner must honour:

- A case whose `id` begins and ends with `__` (`__context__`, `__nodes__`)
  carries **suite setup**, not an assertion. It supplies shared state — the rule
  context, the spatial node table — that later cases in that file use.
- An `expect` containing `error` or `throws` means the operation must fail. The
  `error` value is a code from `errors.json`, not a message.

## The normative amount shape

Anywhere an amount appears, including nested inside a context:

```json
{ "unit": "USD", "minor": "1234", "scale": 2 }
```

`minor` is a **decimal integer string**, never a JSON number. A 64-bit value
read by a parser that assumes doubles is silently wrong above 2^53, in every
language. Hydrate it into your own integer type before computing and render it
back the same way.

## Levels

| Level | Suites | Means |
| --- | --- | --- |
| L1 | `canonical`, `codec`, `audit-chain` | Can hash and store records compatibly |
| L2 | L1 + `amount`, `allocate` | Can compute money compatibly |
| L3 | L2 + `rules`, `limits`, `benefits`, `spatial`, `temporal` | Can make the same decisions |
| L4 | L3 + `attribution` | Can divide credit the same way |
| L5 | L4 + `storage-contract.md` | Can persist safely |

Declare the highest level you fully pass. **Declare skipped suites explicitly**;
the reference Go runner prints them rather than silently omitting them, because
a conformance report that hides what it did not run is worse than no report.

## L5 cannot be a vector

L1–L4 are pure functions, so a vector can pin them exactly. L5 is about
*atomicity and durability* — properties of an execution, not of a value. No
input/output pair can express "and no other caller observed an intermediate
state".

So L5 is specified as obligations in `storage-contract.md`, and each
implementation must write its own concurrency suite in its own language. The
reference does this in `test/concurrency.test.ts`, including a negative control
that reproduces the unsafe pattern and demonstrates it failing — a technique
worth copying, because a concurrency test that passes for the wrong reason is
indistinguishable from one that passes for the right one.

## The reference implementations

| | Language | Levels | Location |
| --- | --- | --- | --- |
| Reference | TypeScript | L1–L5 | `src/` |
| Conformance proof | Go | L1–L4 | `conformance/go/` |

The Go implementation exists to keep this document honest. It shares no code
with the reference and depends on nothing beyond the Go standard library. It was
written from the vectors and the specification, and the places where it initially
disagreed were exactly the places where the specification was too vague — which
is what a conformance suite is for.

```bash
npm run conformance
```

## Regenerating

Vectors are generated from the reference and then committed:

```bash
npm run vectors:generate
npm run vectors:check     # in `npm run verify`
```

Committing them is the point. An unintended change in reference behaviour shows
up as a diff in a reviewed file, rather than as a quietly updated expectation.
