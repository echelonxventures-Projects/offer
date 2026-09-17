# Rule language

The condition AST, specified independently of any evaluator.

- **Machine-readable:** `schema/rule.schema.json`
- **Behaviour:** `vectors/rules.json` — 46 cases against one fixed context
- **Tutorial with worked examples:** [`docs/05-api/03-rule-language.md`](../docs/05-api/03-rule-language.md)

This file states only what is **normative**.

---

## Shape

A rule is a node: `{ "op": "...", ...arguments }`. Arguments are terms or
nested nodes. A term is one of `path`, `literal`, `amount`, or `fn`. Bare JSON
in an argument position is a literal.

## Totality

An evaluator MUST be total. It MUST NOT perform I/O, and it MUST enforce:

| Guard | Value |
| --- | --- |
| Maximum nesting depth | 32 |
| Maximum nodes and terms evaluated | 5000 |

Exceeding either is a `RULE_ERROR` naming the limit, not a `false`.

External facts belong in a **context resolver**, which runs before evaluation
and puts the answer in the context. That is what keeps evaluation replayable:
re-running a rule cannot produce a different answer because a service changed.

## Four rules that are easy to get wrong

**1. Short-circuiting is observable.** `all` stops at the first false child and
`any` at the first true one. Children after that MUST NOT be evaluated, and the
trace MUST NOT contain them. The vectors pin this.

**2. Incomparable operands are an error.** Comparing a string to money is
`RULE_ERROR`. Returning `false` would hide an authoring mistake until it cost
somebody money.

**3. An absent calendar field is `false`, not an error.** A rule written against
`sol` simply never fires on a Gregorian calendar. This is what lets the same
rule vocabulary work across calendars.

**4. There is no regular-expression operator.** String matching is a glob with
`*` and `?`, implemented as a two-pointer scan with a single backtrack point.
Tenant-authored patterns evaluated on the request path are a denial-of-service
vector; catastrophic backtracking turns a 40-character pattern into seconds of
CPU. An implementation that adds a regex operator is not conforming.

## The trace

Every evaluated node appends `{ op, result, depth }`, in evaluation order,
children before parents. The trace is part of the contract, not a debugging
aid: "why didn't I get the discount?" is the most frequent question this
platform will ever be asked.

## Purity

Rule evaluation MUST be a pure function of the rule and the resolved context.

This constraint was tightened by the Go implementation: `spatial.within`
previously consulted the spatial registry, which would have forced every
implementation to load a node table just to evaluate a condition. It now reads
`context.spatial.path`, which the context resolver has already computed. Same
answer, no dependency.
