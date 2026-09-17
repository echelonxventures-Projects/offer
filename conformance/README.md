# Conformance implementations

A portability claim nobody has tested is a portability claim that is false.

This directory holds implementations of the GOIP specification written
independently of the TypeScript reference, to establish that the specification
is precise enough to re-implement.

| Implementation | Language | Levels | Dependencies |
| --- | --- | --- | --- |
| [`go/`](go/) | Go 1.24+ | L1–L4 | Standard library only |

```bash
npm run conformance
```

## What it proved

Writing the Go implementation found real gaps, which is the point:

- **`spatial.within` reached into the spatial registry** when the resolved
  ancestry was already in the context. A portable implementation would have
  needed the whole node table just to evaluate a condition. The operator now
  reads `context.spatial.path`, making rule evaluation a pure function of the
  context — and the reference is better for it.
- **One vector could not survive JSON at all.** A case with non-finite numbers
  was unreachable over any wire, so it was removed rather than shipped as an
  expectation no implementation could meet.

Both were found by a second implementation disagreeing, and neither would have
been found by reading the code.

## Adding an implementation

1. Read `spec/conformance.md` and `spec/encoding.md`.
2. Write a runner over `spec/vectors/*.json`. Compare by canonical form.
3. Honour the two conventions: `__setup__` cases carry shared state, and an
   `expect` containing `error` or `throws` means the operation must fail.
4. Declare skipped suites explicitly. Do not hide them.
5. For L5, write a concurrency suite in your language, including a negative
   control. See `spec/storage-contract.md`.
