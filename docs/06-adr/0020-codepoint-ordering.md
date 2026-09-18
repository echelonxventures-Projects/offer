# ADR 0020 — Codepoint ordering, everywhere

**Status:** Accepted · **Date:** 2026-09-18 · **Phase:** 6

## Context

Twenty places in `src/` sorted strings with `String.prototype.localeCompare`.
Several of them were on the decision path.

`localeCompare` collates using the host's ICU data and default locale. It is the
obvious way to sort strings in JavaScript and the wrong one here, for two
reasons that both bite.

**The adapters already disagreed.** SQLite's `ORDER BY` uses BINARY collation,
which is codepoint order. The memory adapter sorted the same ids with
`localeCompare`. For anything mixed-case the two return different orders:

```
localeCompare : acc:x | ACC:x | clr:demo:USD | exp:merchant-acme:USD | exp:merchant-Zeta:USD
codepoint     : ACC:x | acc:x | clr:demo:USD | exp:merchant-Zeta:USD | exp:merchant-acme:USD
```

Mixed case is not hypothetical: account ids embed unit codes like `USD`, and
source and subject ids are tenant-supplied. The adapter conformance suite did
not catch it because every fixture id was lowercase ASCII.

**Other implementations would disagree too.** Go's `sort.Strings` is codepoint
order. A specification that says "sorted" and means "sorted according to whatever
locale the process happens to have" is not a specification — and this platform's
central claim is that a second implementation reproduces its results exactly.

The worst affected sites were the ones that decide things: stacking tie-breaks,
candidate ordering, and the granted-totals ordering that feeds a decision's
hashed body.

## Decision

One comparator, `compareKeys` in `src/kernel/order.ts`, used everywhere ordering
is observable. Codepoint order. `localeCompare` appears nowhere in `src/` except
in that file's explanation of why not.

It is the same order `canonical.ts` already uses for object keys, which is what
makes hashes agree across implementations. Ordering and hashing now agree about
what "sorted" means.

## Consequences

**Good**

- Both adapters return the same order for the same data, and a conformance test
  with deliberately mixed-case ids proves it. That test failed on the memory
  adapter before the fix, which is the only reason to trust it now.
- Decision hashes no longer depend on the host's locale.
- A Go or Rust implementation sorts the same way with its standard library, no
  ICU dependency and no special casing.

**Bad**

- Alphabetical discovery ranking now puts `Middle` and `Zebra` before `apple`,
  which looks wrong to a human reading a list. It is the correct trade: a
  presentation nicety is not worth a platform that sorts differently on two
  machines. A deployment that wants locale-aware display order sorts in its own
  presentation layer, where the locale is actually known — the server does not
  know which locale a given viewer wants, which is the deeper reason this never
  belonged here.

## Why this is in the "invariant" tier

[What is fixed](../01-architecture/08-what-is-fixed.md) sorts changeability into
deployment, specification and invariant. Ordering is **specification**: the
conformance vectors depend on it, so changing it means changing them, in every
implementation, together.
