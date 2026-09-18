# Ranking

"What should we show this customer first?" — the recommendation question.

---

## It used to be a union

```ts
readonly rank?: "value" | "priority" | "name";   // and a switch inside the engine
```

That is the shape this platform removes everywhere else. A tenant wanting to
rank by margin, inventory age or a fitted model had to edit an engine.

Ranking is now two registries.

| Registry | Is |
| --- | --- |
| `discovery-ranking` | A total order. Can be anything, including one no score expresses well. |
| `ranking-feature` | One bounded, named, explainable input to a score. |

A weighted set of features is a ranking that can show its working.

```ts
discover({ context, rank: "recommended" })
```

An unknown key is **refused**, not quietly defaulted. Ranking by something other
than what was asked for is worse than saying no.

---

## Shipped

| Ranking | Orders by |
| --- | --- |
| `value` (default) | What the subject would actually receive |
| `priority` | What the campaign author declared |
| `name` | Codepoint order — see [ADR 0020](../06-adr/0020-codepoint-ordering.md) |
| `recommended` | A weighted blend, with an explanation per result |

| Feature | Scores |
| --- | --- |
| `relative_value` | Value against the best in the cohort |
| `author_priority` | Priority against the highest present |
| `ending_soonest` | Urgency. Zero for anything with no end date — "never ends" is not urgent |
| `unconditional` | Whether it will actually apply to the basket the customer already has |
| `newest` | Recency, as a tiebreak that does not favour whatever was configured first |

Features are **relative to the cohort**, so a feature can express "the best value
here" rather than only absolutes.

The shipped `recommended` weights are a starting point, not a finding. Fit your
own.

---

## Three properties

**Deterministic.** Integer arithmetic, codepoint ordering, ties broken by id
rather than left to sort stability — which would otherwise inherit whatever
order the store returned rows in.

**Explainable.** A weighted ranking reports each feature's contribution, and the
total is exactly the sum of its parts. Nobody can appeal "the model liked it".

**Off the decision path.** Ranking orders what is *presented*. Objectives decide
what *applies*. A test registers a deliberately perverse ranking and asserts the
decision hash does not move.

```
eligible items always outrank ineligible ones, whatever the ranking says
```

A ranking orders what is on offer. Something the subject cannot have is not on
offer, and no weighting may promote it.

---

## Failure behaviour

A feature referenced with no registration is **skipped**, not fatal. Ranking is
presentation: an unknown feature must not take down discovery the way an
unevaluable condition once took down a whole response
([ADR 0017](../06-adr/0017-preview-as-a-publish-gate.md)).

That is the opposite of the scorecard rule, where a missing feature *is* an
error. The difference is what is at stake: a mis-ordered list is a worse
experience, a mis-scored block is a customer wrongly refused.

---

## Scale

Features return `0..scale`, where `scale` is `config.ranking.scale` (default
10000). It is configuration rather than a constant because it sets how finely
two close offers can be separated, and a deployment ranking thousands of
near-identical items needs more room than one ranking six.
