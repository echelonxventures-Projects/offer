# ADR 0005 — Results, not exceptions

**Status:** Accepted · **Date:** 2026-09-17

## Context

Most of what this platform returns is a negative answer: not eligible, out of
budget, limit reached, outside the window. These are not errors. They are the
answer, and the reasoning behind them is the most valuable thing produced.

Exceptions discard that reasoning. A thrown `NotEligibleError` carries a message
and a stack trace — the stack being the one thing nobody needs.

## Decision

Every capability returns `Result<T, GoipError>`:

```ts
type Result<T, E = GoipError> = { ok: true; value: T } | { ok: false; error: E };
```

`GoipError` is a plain object — data that serialises and crosses an API
boundary — with `code`, `message`, structured `details` and `retryable`.

Exceptions are reserved for programmer error, via `GoipPanic`: a negative scale,
a sealed registry being written to, division by zero. Never for anything a
caller could cause.

## Consequences

**Good**

- The compiler forces every caller to handle failure. There is no forgotten
  `catch`.
- `details` carries structured specifics — the shortfall, the missing key, the
  available options — which a message string cannot.
- Errors serialise, so the API layer is a mapping table rather than a translation
  layer.
- Reasoning survives all the way to the caller.

**Bad**

- Verbose. `if (!result.ok) return result;` appears constantly.
- No `try`/`catch` convenience for a sequence of fallible steps.
- Two failure modes still exist — `Result` and `GoipPanic` — and the boundary
  has to be respected by every handler author.

## Style

```ts
const unit = economic.units.require(unitKey);
if (!unit.ok) return unit;          // propagate unchanged
// unit.value is narrowed here
```

`unwrap()` exists and throws. It is for tests and examples only, and nothing in
`src` calls it.

## Alternatives considered

**Exceptions with typed subclasses.** Rejected: the compiler cannot force
handling, and `instanceof` across module boundaries is fragile.

**Null returns.** Rejected: discards the reason entirely, which is the one thing
that must survive.

**A monad library.** Rejected: a dependency and a learning curve for a
discriminated union that TypeScript narrows natively.
