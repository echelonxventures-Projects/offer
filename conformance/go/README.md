# Go conformance implementation

An independent implementation of GOIP levels L1–L4, sharing no code with the
TypeScript reference and depending on nothing beyond the Go standard library.

```bash
go run .                    # from this directory
npm run conformance         # from the repository root
```

## Why Go

Go is maximally unlike TypeScript for this purpose:

- **Compiled and statically typed**, so nothing is resolved at runtime.
- **No native arbitrary-precision integer.** `math/big` is explicit, which means
  the specification has to be precise about integer semantics rather than
  quietly relying on a host language feature.
- **Different float formatting**, which forced the canonical number rule to be
  written down rather than assumed.

A second implementation in a language that shares TypeScript's habits would
prove considerably less.

## Layout

| File | Covers |
| --- | --- |
| `codec.go` | Wire codec: `~bigint:` tagging and escaping |
| `canonical.go` | Canonical hashing form, SHA-256, chain hashing |
| `amount.go` | Exact integer money, all rounding modes, allocation |
| `runners_l1_l2.go` | L1/L2 vector runners |
| `runners_limits_spatial.go` | Limit semantics, spatial containment |
| `runners_temporal.go` | Chronologies, Gregorian, fiscal, Mars calendars |
| `runners_benefits.go` | All eight benefit types |
| `runners_rules.go` | The rule evaluator, operators and functions |
| `runners_attribution.go` | All five attribution models |
| `main.go` | Vector loader, comparison, reporting |

## Notes from writing it

**The proleptic Gregorian calendar is implemented by hand**, not via Go's
`time` package. The specification defines a proleptic calendar; `time` does not
match it before 1583, and the difference would have surfaced as a silent
divergence rather than an error.

**Comparison is by canonical form.** The runner does not compare its own
serialisation to the expected text; it canonicalises both and compares those.
Key order is not part of any expectation — values are.

**Skipped suites are printed.** A conformance report that hides what it did not
run is worse than no report.
