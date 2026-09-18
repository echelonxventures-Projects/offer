# ADR 0017 — Preview as a publish gate

**Status:** Accepted · **Date:** 2026-09-18 · **Phase:** 4

## Context

The worst production failure this platform can have is not a crash.

`validate` checked policy — is it funded, owned, bounded, using registered
types — but never ran the condition. So an offer whose condition could not be
evaluated passed review, went live, and failed at runtime with `RULE_ERROR`.
That failure is *silent*: the offer simply never applies. Nobody finds out until
somebody asks why the campaign did nothing, which can be weeks.

The gap was listed in the runbook from Phase 0 with the note "no rule preview
before publishing". Conditions are pure functions of a context, so the check was
always possible; it just had not been written.

## Decision

**Run the offer against representative contexts before it can be published.**

- A `context-sample` registry holds representative interactions: a typical
  basket, an anonymous visitor, no basket at all, a high-value order, a minimal
  one. Shipped samples are generic; a deployment replaces them with samples
  drawn from its own traffic, which is the only way preview catches what
  actually happens.
- `PreviewEngine` evaluates the offer against each, reporting per-sample
  outcomes plus findings: unevaluable conditions (**error**), applies-nowhere,
  grants-nothing, uncapped-on-a-large-basket (**warnings**).
- `rules.evaluable` is a **governance policy**, so it runs inside the existing
  publish gate rather than as a special case inside `publish`. It composes with
  the other policies, appears in the same report, and can be removed by a
  deployment with its own validation.
- `validate` gained preview, and can check a **draft that was never saved** —
  the feedback arrives while the author is still editing.

No new capability. The list stays closed at 22; `validate` and `simulate` were
extended instead.

## Consequences

**Good**

- The silent failure is now a refused publish with the reason attached.
- Authors get coverage ("applies to 2 of 5 samples") and exposure ("750.00
  against the high-value basket, uncapped") before committing.
- `explainOffer` renders the decision a support agent already has into the
  sentence they need, including the predicate that decided it.
- `diffValueExchange` answers the only question an approver has: *does this
  increase what we could end up paying?* A rate rise, a removed cap and a raised
  limit all look like small textual edits, and one of them is unbounded.

**Bad**

- Preview is only as good as the samples. Generic samples catch structural
  mistakes, not business ones, and the report says so rather than implying
  coverage it does not have.
- The findings are heuristics. "Applies to none of the samples" might be a
  correctly-targeted offer aimed at a case the samples do not cover, so it is a
  warning, not an error.
- Publishing is slower: each publish now evaluates the offer five times.
- Tests that deliberately publish broken offers needed a `publishUnchecked`
  helper. That is not only a test affordance — it models the real case the
  runtime handling still exists for: an offer that was valid when published and
  broke afterwards because a registry entry was removed.

## Two changes this forced, both improvements

**An absent operand is no longer an error.** Preview immediately failed a sound
offer against the no-basket sample, because `cart.subtotal` is undefined during
discovery and comparing undefined to money was a `RULE_ERROR`. That was a real
robustness bug well beyond preview: **a single offer with a cart-based condition
failed the entire discovery response for everybody**.

The fix draws the line properly. A *missing path* is a runtime state — discovery
genuinely happens before a basket exists — so an ordering against it is `false`.
A *present but wrong-typed* value is an authoring mistake and stays an error,
because returning false would hide it until it cost money. A missing path is
also not equal to an explicit `null`; conflating those hides typos.

This is a **specification change**: six vectors were added and the Go
implementation updated, which needed a `missing` sentinel because Go's `any`
uses `nil` for both states. The conformance suite caught the divergence
immediately, which is exactly what it is for.

**Failed conditions now name the predicate that decided.** The eligibility check
reported "4 node(s) evaluated", which is true and useless. It now reports
`'gte' was not satisfied: 0 vs 1`. The trace always held this; nothing surfaced
it.

## What was deliberately not built

Four of the six items originally sketched for this phase were user interfaces:
an authoring console, a visual rule builder, a simulation UI, a budget
dashboard.

**None were built, and that is a decision rather than an omission.** A console
is a client. Bundling one would mean choosing a framework, a build step and a
design system — contradicting the agnosticism the rest of the system pays for,
and producing something most deployments would replace anyway.

What a console needs is the *capabilities*, and those now exist: `validate` with
preview for a draft, `compareVersions` for review, the explanation functions for
rendering, and an OpenAPI document describing all of it. The UI is downstream
work for whoever deploys this, and it is listed as such rather than claimed.
