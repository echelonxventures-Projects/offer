# ADR 0013 — Conformance vectors as the portability contract

**Status:** Accepted · **Date:** 2026-09-17 · **Phase:** 1b

## Context

The platform must be agnostic of tools, databases and languages. Storage
agnosticism was settled in Phase 1 by the ports and two adapters. Language
agnosticism is harder, because it contains a claim that cannot be literally
true: *something has to execute*, and that something is written in a language.

The weak version of this is to write prose describing the model and call it
language-neutral. Two implementations then read the same paragraph about
rounding and disagree in the third decimal place, and nobody finds out until a
liability account is wrong.

## Decision

Separate the **specification** from the **implementation**, and make the
specification's centre of gravity executable.

```
spec/vectors/*.json     frozen behaviour: input -> exact expected output
spec/schema/*.json      the data model, as JSON Schema
spec/encoding.md        canonical hashing form and the wire codec
spec/rule-language.md   the condition AST, normative parts only
spec/errors.json        the error vocabulary, as data
spec/storage-contract.md  L5 obligations, which vectors cannot express
```

TypeScript is demoted from "the platform" to "the reference implementation".

Then: **write a second implementation in another language and prove it passes.**
`conformance/go/` is an independent Go implementation of L1–L4, sharing no code
and depending on nothing beyond the standard library. It reproduces all 289
vector cases exactly.

## Conformance levels

| Level | Covers |
| --- | --- |
| L1 | Encoding: canonical form, wire codec, audit chain |
| L2 | Arithmetic: exact money, every rounding mode, allocation |
| L3 | Decisioning: rules, limits, benefits, spatial, temporal |
| L4 | Distribution: attribution |
| L5 | Storage obligations — **not vector-expressible** |

## Consequences

**Good**

- Portability is demonstrated, not asserted. A Go, Java or Rust implementation
  has something exact to conform to.
- Vectors are committed, so an unintended change in reference behaviour appears
  as a diff in a reviewed file rather than as a silently updated expectation.
- `npm run conformance` runs both implementations against the same files in CI.
- The vectors document intent better than prose: `percent:12.5%of12.34:half_even
  → 154` cannot be misread.

**Bad**

- Vectors are generated from the reference, so they encode the reference's
  behaviour — including any bug. They pin behaviour; they do not validate it.
  That is the correct trade, but it must be said plainly.
- Two things now have to be kept in step. `vectors:check` runs in `verify`
  precisely so that drift is loud.
- The Go implementation is real code that must be maintained, or it rots into a
  claim about a version nobody runs.

## What writing the second implementation actually found

This is the part that justifies the effort. Two genuine defects, neither of
which would have been found by re-reading the TypeScript:

**1. `spatial.within` was not a pure function of the context.** It consulted the
spatial registry, even though the context resolver had already computed the
ancestry into `context.spatial.path`. Any portable implementation would have
needed the entire node table loaded just to evaluate a condition. The operator
now reads the resolved path. The reference is better for it, and rule evaluation
is now genuinely pure.

**2. One vector was unreachable.** A canonical-encoding case with non-finite
numbers could not survive JSON at all — `JSON.stringify(Infinity)` is `null`, so
no implementation could ever have received the input the expectation described.
It was removed rather than shipped as an expectation nobody could meet.

Both were found by a second implementation disagreeing. That is what a
conformance suite is for, and it is why the honest version of "language
agnostic" requires actually writing one.

## Alternatives considered

**Prose specification only.** Rejected: it is the weak version, and it fails at
the first rounding decision.

**Port the whole platform to a second language.** Rejected as premature: L5 is
storage and concurrency, which is where the real work is, and duplicating it
would double the maintenance before the contract had stabilised. L1–L4 are the
pure core and prove the point.

**Generate implementations from the schema.** Rejected: code generation produces
a second copy of the same assumptions, not an independent check. The value here
came specifically from a human implementing against the spec and disagreeing.
