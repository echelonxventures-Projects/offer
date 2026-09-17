# ADR 0004 — No regular expressions in rules

**Status:** Accepted · **Date:** 2026-09-17

## Context

Conditions are authored by tenants and evaluated on the request path. Rules need
some string matching: SKU prefixes, code patterns, category names.

Regular expressions are the obvious answer and the wrong one. Backtracking
engines — including V8's — have catastrophic worst cases. `(a+)+b` against a
few thousand `a`s takes seconds of CPU. A tenant could do this by accident;
anyone who can author a rule could do it deliberately.

## Decision

**No regex operator.** String matching is `glob`, with `*` and `?`, implemented
as a two-pointer scan with a single backtrack point.

```ts
globMatch("SKU-*", "SKU-123")    // true
globMatch("?-1", "AB-1")         // false
```

Linear in the input. There is no pattern that makes it blow up.

## Consequences

**Good**

- No ReDoS. Not mitigated, not rate-limited — absent.
- Evaluation cost is predictable, which is what lets the node budget be a
  meaningful guard.
- Globs are what most authors actually want, and are far easier to get right.

**Bad**

- Genuinely complex matching is not expressible. Validating a code format, say.
- A tenant migrating from a regex-based system must rewrite patterns.

## Mitigation

If a tenant truly needs regex matching, the answer is a **context resolver**,
not a rule operator: match upstream, where you control the timeout and the
concurrency, and expose the boolean as a facet.

```ts
draft.facets.codeIsValid = /^[A-Z]{3}-\d{4}$/.test(code);
```

Then `{ "op": "eq", "left": { "path": "facets.codeIsValid" }, "right": { "literal": true } }`.

This puts the risk where it can be bounded and keeps rule evaluation total.

**Enforced by** `test/rules.test.ts` → *"stays linear on the input that would
blow up a backtracking regex"*.

## Alternatives considered

**Regex with a timeout.** Rejected: JavaScript has no way to interrupt a running
regex on the main thread.

**A non-backtracking regex engine (RE2).** Rejected: a native dependency, for a
capability a glob covers.

**Regex behind a governance policy.** Rejected: the policy would have to decide
which patterns are safe, which is the halting problem wearing a hat.
