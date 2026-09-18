# Analysis

Everything the platform can tell you about what it already did. Nothing here is
consulted while it is deciding.

| | |
| --- | --- |
| Module | `src/intelligence/` |
| Enforced by | Two guard tests in `test/extensibility.test.ts` |
| Verified by | `test/intelligence.test.ts` (34), `test/ranking.test.ts` (14) |
| Demonstrated by | `examples/12-intelligence.ts` |
| Decided in | [ADR 0019](../06-adr/0019-analysis-is-a-downstream-layer.md) |

---

## The boundary, and why it is the whole point

> **Never traverse the graph inside a decision.**
> — [the incentive graph](../01-architecture/06-incentive-graph.md)

A decision walks a fixed pipeline. If it instead traversed a graph, two things
would break at once: latency would become a function of how much history a
subject has, and a decision would stop being replayable, because replaying it
would mean reconstructing the graph as it stood at the time.

So the rule is structural, not remembered:

- Nothing in `engines`, `rules`, `context`, `ledger`, `model` or `universal` may
  import `src/intelligence/`.
- Nothing in `src/intelligence/` may write — no `put`, `append`, `register`,
  `saveSnapshot`, `saveCheckpoint` or `tryConsume`.

If an eligibility rule needs a graph-derived fact — "has this subject ever been
referred by a partner" — that fact is computed here, upstream, and placed in the
context as a facet or a counter by a context resolver. The decision then reads a
value, not a traversal.

---

## Graph projection

```ts
const projection = await platform.graph.project({ tenant, includeLedger: true });
projection.nodes;                     // ValueExchange, Subject, Execution, Decision, ...
projection.edges;                     // FUNDED_BY, HELD_BY, DECIDED, REDEEMED_BY, ...
projection.scanned.auditRecords;      // what it cost
projection.truncated;                 // whether history is missing from the result
```

Derived, never stored. Delete a projection and the next one is identical,
because every edge is already implied by a field on a record.

**Bounded, and honest about it.** Phase 5's lesson was that a read which folds
an append-only table from genesis gets slower forever. A projection is
inherently a scan, so it takes an explicit budget, stops at it, and reports
`truncated`. A partial graph that looks complete is worse than a refusal.

The spine is the audit chain, so a projection inherits the chain's tamper
evidence. It also inherits the chain's silences: a quote that was never reserved
leaves no trace, by design, because a price somebody was shown and did not take
is not a material event.

### Node and edge kinds

Exactly the tables in [the incentive graph](../01-architecture/06-incentive-graph.md),
with one difference. There is no `REJECTED` edge: rejections belong to quotes,
and recording every non-qualifying candidate on every reservation would multiply
audit volume for something `replayDecision` reconstructs exactly.

---

## The named questions

Implemented by name, so what each one means is fixed rather than reinvented per
caller. All are pure over a projection — project once, ask many.

```ts
dependentsOfFundingSource(projection, "merchant-acme")
```
**"If we retire this funding source, which offers stop working?"** The single
most useful pre-change safety query, and the reason `funding.sources_exist` is a
governance policy rather than a warning.

```ts
neverDelivered(projection)
```
**"Which live campaigns have never delivered anything?"** The least available
report in this domain, because a campaign that quietly does nothing raises no
errors at all — nothing else in the platform notices it. Evidence, not proof:
read it against the window the projection actually covers, since a campaign
published this morning has not failed.

```ts
historyOfSubject(projection, "shopper-7")   // what they took, and when
claimsByParty(projection)                   // which partner claims what
costOfCampaign(projection, valueExchangeId) // who bore it
summarise(projection)                       // shape, and anything unconnected
```

---

## Anomaly detection

Alerting ([observability](../07-operations/04-observability.md)) answers "is a
threshold breached?" — the failures you predicted. This covers the ones you did
not: a redemption rate that quietly triples, a campaign that stops delivering
overnight, a release rate climbing because something downstream started timing
out.

```ts
const report = await platform.anomalies.scan({ tenant, nowTick, bucketTicks });
report.findings;   // each with observed, baseline and a sentence
report.truncated;  // whether the baseline may be short
```

**Median and MAD, not mean and standard deviation.** Incentive traffic is spiky.
One flash sale in the baseline inflates a standard deviation enough to hide the
next real incident; a median absolute deviation ignores the outlier it is
measuring against.

**Closed buckets only.** The bucket containing "now" is still filling. Comparing
a half-finished bucket against full ones reports a collapse in volume every
single time it runs, which is the classic way an alerting system teaches people
to ignore it.

**The bucket being judged is excluded from its own baseline.** Including it
drags the baseline towards the value under test and hides exactly the spikes
worth catching.

**Too little history produces nothing.** Below `minimumBuckets`, or under
`minimumBaseline`, a detector returns no findings rather than a guess. Three
redemptions becoming one is not an incident.

**Findings describe; they never act.** A finding is evidence for a human or an
alert rule, never an automatic block — a false positive that pauses a live
campaign costs more than the anomaly it was guessing at.

| Detector | Catches |
| --- | --- |
| `volume_spike` | A bucket far above the recent median |
| `volume_collapse` | A bucket far below it, including a stop dead at zero |
| `sustained_shift` | A drift too gradual for any single bucket to look wrong |

---

## Scorecards: a fitted model that explains itself

`risk.ts` has always said a tenant wanting a learned model "registers it as one
more signal and keeps the explanation surface intact". This is that, made
concrete — an extension point nobody has built against is a claim, not a feature.

A scorecard is a linear model held **as data**: named features, integer weights,
an intercept. Fitting happens outside this platform, in whatever statistical
tooling a deployment already owns. What arrives is a table of numbers.

```ts
platform.registries["risk-signal"].register(
  scorecardSignal({ weights: { key: "fraud_v3", intercept: -10,
    weights: { recent_redemptions: 8, is_anonymous: 25 }, /* ... */ } }),
);
```

The risk engine cannot tell the difference, which is the point: thresholds,
explanation and the appeal path are unchanged.

**It explains itself by construction.** Every score decomposes into one
contribution per feature. *"Blocked because the anonymous feature contributed 25
of 85"* can be appealed. *"Blocked, score 0.91"* cannot, and every incentive
platform eventually has to explain a block to a real person standing at a till.

**A missing feature is an error.** Scoring while silently skipping a weighted
feature changes the model's meaning without anybody noticing.

**Weights are summed in sorted key order**, so reordering a weights file is the
same model. Integer weights, because floating point would make the total depend
on summation order.

### What this is not

No training, no gradient descent, no inference over a neural network. The
platform executes a model somebody else fitted. Calling that machine learning
would be a marketing claim, and [known gaps](../08-roadmap/02-known-gaps.md)
says so.

---

## Budget allocation

```ts
const plan = planAllocation(strategies, "by_redemptions", { total, demands });
compareToCurrent(plan, currentBudgets);   // the delta, so nobody has to subtract
```

**Advisory.** Nothing writes a budget, moves money or touches a funding source.
Applying a plan is a separate, deliberate act by somebody holding `fund` — an
optimiser with write access is an optimiser that can empty a campaign at three
in the morning.

**Exact.** The same remainder-preserving `allocate()` the ledger uses, so parts
sum to the total to the minor unit. A plan that loses a cent per campaign will
not reconcile.

**It shows its reasoning.** Every line carries its weight and a sentence, and a
campaign given nothing is listed with a reason rather than dropped.

| Strategy | Right for | Wrong for |
| --- | --- | --- |
| `equal` | No history to learn from | Campaigns of different sizes |
| `by_priority` | Author intent | Anything measured |
| `by_historic_spend` | Renewal | Anything new |
| `by_redemptions` | Acquisition reach | Margin |

---

## Ranking

Discovery ranking is a registry, not a union. See
[ranking](02-ranking.md).

---

## Related

- [The incentive graph](../01-architecture/06-incentive-graph.md) — the design this implements
- [ADR 0019](../06-adr/0019-analysis-is-a-downstream-layer.md) — why it is a separate layer
- [Observability](../07-operations/04-observability.md) — thresholds, which anomalies complement
