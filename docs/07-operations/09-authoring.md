# Authoring safely

How to check an offer before it can hurt anybody.

---

## The loop

```ts
// 1. Check a draft before saving it.
const { report, preview } = unwrap(await caps.validate({ tenant, draft }));

// 2. Save and publish. Publishing re-runs preview and refuses on errors.
const created = unwrap(await caps.create({ tenant, actor, draft }));
await caps.publish({ tenant, actor, valueExchangeId: created.id, approvedBy });

// 3. For a revision, show the approver what changes.
await caps.compareVersions({ tenant, valueExchangeId, draft: revised });
```

## Why policy is not enough

`validate` returns two things because they fail differently:

| | Catches | Misses |
| --- | --- | --- |
| **Policy** | Unfunded, unowned, unbounded, unregistered types | Anything about whether the offer *works* |
| **Preview** | Conditions that cannot be evaluated, offers that apply nowhere, benefits that grant nothing, uncapped exposure | Business correctness |

A condition comparing a customer id to a number passes every policy. It is
funded, owned, bounded and uses registered types. It is also broken, and the
only way to find out is to run it — which is what preview does.

**An unevaluable condition blocks publication.** That failure is otherwise
silent: the offer applies to nobody and nothing errors visibly.

## Samples are the whole game

```ts
platform.registries["context-sample"].register({
  key: "acme.subscription-renewal",
  label: "Subscription renewal",
  summary: "An existing subscriber renewing, 49.00 USD, no discretionary items",
  context: { /* ... */ },
  tags: ["core"],
});
```

The shipped samples are generic and catch structural mistakes: a condition that
needs a subject, one that needs a basket, an uncapped percentage on a large
order. **They cannot catch business mistakes.** Replace them with samples drawn
from your own traffic — that is the only way preview tells you about the cases
you actually have.

Samples carry no tenant, so they are portable and cannot name the wrong one.
Preview re-denominates them into the offer's unit, so an INR offer is not failed
for a mismatch with a USD sample.

## Reading a report

```
coverage       2 of 5 sample contexts
  ✗ anonymous    conditions: 'gte' was not satisfied: 0 vs 1
  ✓ high-value   750.00 USD
  ✓ typical      15.00 USD
```

| Finding | Severity | Means |
| --- | --- | --- |
| `rule.unevaluable` | **error** | Blocks publication. The offer would deliver nothing. |
| `coverage.none` | warning | Applies nowhere. Either targeting is narrower than intended, or the samples do not cover the case. |
| `benefit.zero` | warning | Qualifies but grants nothing — usually a tier nobody meets or a target matching no lines. |
| `benefit.uncapped` | warning | A large benefit with no cap. A larger basket grants proportionally more. |
| `coverage.universal` | info | Applies to everything, including anonymous. Confirm that is intended. |
| `requires.subject` / `requires.cart` | info | Expected for targeted offers; worth knowing for discovery. |

Warnings are heuristics and say so. An offer applying to none of the samples
might be correctly aimed at a case the samples do not represent.

## Reviewing a revision

`compareVersions` classifies each change by its effect on **exposure**, because
that is the approver's actual question:

```
benefits.d.params        increases — the benefit is larger
benefits.d.cap           increases — the cap was raised or removed
limits.totalRedemptions  decreases — the limit was tightened
conditions               unknown   — preview both versions to see who now qualifies
```

A textual diff shows four edits of similar size. This shows which of them can
cost money. `unknown` is honest: no static comparison can tell whether a changed
condition widens or narrows the audience — preview answers that.

## Answering "why didn't I get the discount?"

```ts
renderExplanation(explainOffer(decision, valueExchangeId));
```

```
'Returning customer 15%' did not apply: the basket or the customer does not
meet the conditions
  Check that failed: conditions ('gte' was not satisfied: 0 vs 1)
  The condition that decided it: 'gte' — 0 vs 1
```

No log required. The decision already carries the ten checks, the rule trace and
the displacement reasons; these functions render them. They are pure, so a
support tool can explain a decision it was handed.

## There is no console

Deliberately. A console is a client, and bundling one would mean choosing a
framework and a build step — which the rest of this system avoids on purpose.

What a console needs exists: `validate` with preview on an unsaved draft,
`compareVersions`, the explanation functions, and a generated OpenAPI document.
Building the UI is downstream work. See
[ADR 0017](../06-adr/0017-preview-as-a-publish-gate.md).
