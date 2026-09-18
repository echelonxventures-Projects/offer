# ADR 0019 — Analysis is a downstream layer

**Status:** Accepted · **Date:** 2026-09-18 · **Phase:** 6

## Context

Phase 6 is "make it clever": recommendation, a learned risk model, budget
optimisation, graph projection, anomaly detection. The roadmap has said from the
start that none of it requires an engine change, and that leaving it until last
is the right call, because "a clever platform that cannot balance its books is
worth less than a dull one that can".

The risk in this phase is not that the features are hard. It is that each one
has an obvious implementation that would quietly undo something the previous
five phases paid for.

- A recommender that reads a subject's history **on the decision path** makes
  decision latency a function of how much history a subject has, and makes a
  decision unreplayable, because replaying it would mean reconstructing the
  graph as it stood at the time.
- A learned model that returns a score and no reasons makes a block
  unappealable, and every incentive platform eventually has to explain a block
  to a real person standing at a till.
- An optimiser with write access is an optimiser that can empty a campaign at
  three in the morning.
- A projection stored rather than derived is a second source of truth that
  drifts.

## Decision

**A new layer, `src/intelligence/`, that is strictly downstream.** It reads what
the platform recorded and never feeds a decision. Two guard tests enforce it:

- No module in `engines`, `rules`, `context`, `ledger`, `model` or `universal`
  may import it.
- Nothing in it may call `put`, `append`, `register`, `saveSnapshot`,
  `saveCheckpoint` or `tryConsume`. Analysis is read-only.

Within that boundary:

**Graph projection.** The projector the architecture document described and
deliberately did not ship. Derived, bounded, and honest: it takes an explicit
record budget, stops at it, and reports `truncated` rather than returning a
partial graph that looks complete. The spine is the audit chain, so a projection
inherits the chain's tamper evidence.

**Named queries.** The six questions the graph document lists as "painful
without the graph", implemented by name — including "if we retire this funding
source, which offers stop working?" and "which live campaigns have never
delivered anything?".

**Anomaly detection.** Integer statistics over closed buckets, with a registry
of detectors. Median and MAD rather than mean and standard deviation, because
incentive traffic is spiky and one flash sale in the baseline inflates a
standard deviation enough to hide the next real incident.

**Scorecards.** A linear model held as *data*: named features, integer weights,
an intercept. Fitted elsewhere, executed here, decomposing into one contribution
per feature. It registers as one more `risk-signal` and the risk engine cannot
tell the difference.

**Budget allocation.** Advisory only. Returns a proposal using the same
remainder-preserving `allocate()` the ledger uses.

**Ranking as a registry.** `discovery-ranking` and `ranking-feature` replace a
closed `"value" | "priority" | "name"` union and a `switch` inside the discovery
engine — the exact shape this platform removes everywhere else.

## Consequences

**Good**

- The graph document's guarantee stops being a design claim and becomes running
  code with tests.
- "Which campaigns were configured and never delivered anything" is now
  answerable. A campaign that quietly does nothing raises no errors at all, so
  nothing else in the platform notices it.
- A deployment can rank by margin, inventory age or a fitted model without
  editing an engine.
- The "register a learned model as one more signal" claim in `risk.ts` is now
  something you can point at rather than a promise.

**Bad**

- A projection is a scan. It is bounded and it reports its cost, but it is not
  cheap, and it is not something to put behind a per-request endpoint.
- Bundle versions cover the registries; they do not cover a scorecard's weights.
  A deployment that changes a fitted model must version that file itself.
- The shipped `recommended` weights are a starting point, not a finding. They
  were chosen to be defensible, not because they were fitted on anything.

## What changed outside the new layer

Two things, both because the queries could not be honest without them.

**`execution.reserved` now records which exchanges applied.** Without it the
chain says a reservation happened but not what it was for, and every "what did
this campaign deliver" question becomes a replay. Rejections are deliberately
still not recorded: they belong to the quote, which is not a material event, and
storing every non-qualifying candidate on every reservation would multiply audit
volume for something `replayDecision` reconstructs exactly.

**`AuditStore.range`.** `recent` walks backwards from the head, which is what an
operator wants and the wrong shape for anything that must read the whole chain:
it cannot be resumed, so the only way to cover everything is one enormous call.
`range` is the ledger's `entriesSince` for the audit chain.

## The honesty clause

Nothing here trains anything. There is no gradient descent, no inference over a
neural network, and nothing that should be called learning. The platform
executes a model somebody else fitted. The known-gaps list says so in those
words, and this ADR exists partly so that claim stays written down next to the
code that would otherwise invite the opposite reading.

## Alternatives considered

**A graph database alongside the store.** Rejected, as the architecture document
already argued: a second source of truth that drifts, for edges that are each
already implied by a field on a record.

**Embedding a model runtime.** Rejected. It would end the zero-dependency,
zero-build promise, and buy an unexplainable score in return for it.

**Letting the recommender run inside `apply`.** Rejected — this is the decision
the whole ADR is about. Ranking orders what is *presented*; objectives decide
what *applies*. A test asserts that registering a deliberately perverse ranking
does not change a decision hash.
