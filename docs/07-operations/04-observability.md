# Observability

What to emit, measure and alert on.

The platform produces structured traces natively; the job of an operator is
mostly to forward them rather than to reconstruct anything.

---

## What the platform already gives you

| Structure | Where | Contains |
| --- | --- | --- |
| `context.trace` | Every resolved context | Every resolver, applied/skipped/failed, with a note |
| `verdict.checks` | Every eligibility verdict | All ten checks, pass/fail, with details |
| `verdict.ruleTrace` | Every rule evaluation | Each predicate, its result, the values compared |
| `decision.displaced` | Every decision | Eligible offers that lost, and why |
| `decision.hash` | Every decision | Canonical hash of the whole decision |
| `audit chain` | Every mutation | Actor, subject, payload, hash |

## Correlation

Pass `correlationId` on the context request. It flows into the resolved context,
the decision, and every audit record.

```ts
caps.apply({ context: { tenant, correlationId: requestId, ... } });
```

Without it, tying a customer complaint to a decision means searching by
timestamp and subject, which works until two requests arrive in the same second.

---

## The telemetry port

Four methods, no vendor. `noopTelemetry` is the default, so a deployment that
collects nothing pays nothing for the calls.

```ts
const telemetry = new MemoryTelemetry();
const platform = new GoipPlatform({ telemetry, metricReader: telemetry });
```

`multiTelemetry(memory, yourExporter)` fans out, which is how you collect in
memory for health and alerting while shipping to a backend.

An adapter for Prometheus, OTel or StatsD is a short file over this interface.
See [ADR 0014](../06-adr/0014-observability-as-ports-not-vendors.md) for why
there is no SDK in the core.

## The catalogue

Metric names are data, in `src/observability/metrics.ts`. Each entry carries its
kind, unit, labels and what it is *for*.

```ts
describeMetrics();  // name, type, unit, help, labels - generate your exporter from this
```

Nine of the twenty-nine are marked `actionable`, meaning an operator should be
able to alert on them directly. The rest are for diagnosis.

## Metrics worth having

### Decision path

| Metric | Type | Why |
| --- | --- | --- |
| `decision.duration` | histogram, by tenant | The core latency SLO |
| `context.resolver.duration` | histogram, **by resolver key** | Finds the resolver making an external call |
| `decision.candidates` | histogram | Rising means campaign-portfolio growth |
| `decision.eligible` | histogram | Approaching 10 means stacking is about to go greedy |
| `decision.search_mode` | counter, by mode | **Alert if `greedy` appears** |
| `decision.applied` | histogram | How often anything applies at all |
| `rule.nodes_evaluated` | histogram | Rising means rules are getting complex |

### Eligibility

| Metric | Type | Why |
| --- | --- | --- |
| `eligibility.failed` | counter, **by check name** | The most useful single metric here |

Break it down by `check`. A spike in `acquisition` means codes are not reaching
customers. A spike in `limit.total_redemptions` means a campaign has ended and
somebody should know. A spike in `conditions` means a rule change did something
unintended.

### Execution and money

| Metric | Type | Why |
| --- | --- | --- |
| `execution.reserved` / `captured` / `released` / `reversed` | counters | The funnel |
| `execution.reserve_to_capture` | histogram | Rising means checkout is slowing |
| `funding.utilisation` | gauge, by source | Budget burn |
| `funding.insufficient` | counter, by source | **Alert immediately** |
| `ledger.balanced` | gauge (0/1) | **Page if 0** |

### Governance and risk

| Metric | Type | Why |
| --- | --- | --- |
| `governance.rejected` | counter, by policy | Which policy blocks most often |
| `risk.disposition` | counter, by disposition | Block rate |
| `audit.verify_failed` | gauge | **Page immediately** |

---

## Alerts

**Page:**

| Condition | Means |
| --- | --- |
| `ledger.balanced == 0` | Value has been created or destroyed |
| `audit.verify_failed` | A stored record no longer matches its hash |
| `RULE_ERROR` rate > 0 | A campaign's conditions are broken; it is silently delivering nothing |
| `funding.insufficient` on an active campaign | Customers are being refused a price they were shown |

**Warn:**

| Condition | Means |
| --- | --- |
| `search_mode == greedy` | Stacking is no longer optimal |
| `funding.utilisation > 80%` | Budget will run out |
| Reservations outstanding > 1 hour | The reaper is not running, or does not exist |
| `decision.duration` p99 regression | Usually a resolver |

`RULE_ERROR` deserves its place in the page list. It looks like a client error
and is not: it means an authored condition cannot be evaluated, so the offer
never applies and nobody finds out until a campaign owner asks why revenue is
flat.

---

## Logging a decision

Log the structure, not a message. Sample the full trace; always log the summary.

```ts
log.info("decision", {
  correlationId: decision.correlationId,
  decisionId: decision.id,
  decisionHash: decision.hash,
  tenant: decision.tenant,
  reality: decision.reality,
  objective: decision.objective,
  candidates: decision.candidatesConsidered,
  applied: decision.applied.map((a) => a.valueExchangeId),
  reduction: decision.payableReduction.minor.toString(),   // bigint!
  searchMode: decision.searchMode,
  durationMs,
});
```

Note `.toString()` on the bigint. `JSON.stringify` throws on bigints; use
`canonicalize()` from the kernel if you want the whole object.

**Log the full trace when:** the decision applied nothing, a `RULE_ERROR`
occurred, the search went greedy, or a sampling rule fires. That is a small
fraction of traffic and covers every case anyone will ask about.

---

## Answering "why didn't I get the discount?"

The workflow this platform is designed to make short:

1. Find the decision by `correlationId`.
2. Read `decision.rejected[]` for that exchange.
3. Read `verdict.primaryReason` — usually the answer.
4. If it is `conditions`, read `verdict.ruleTrace` for the predicate that failed
   and the values it compared.
5. If the offer was eligible but did not apply, read `decision.displaced[]`.

Every step is a field lookup. None requires reading a log line.

---

## Health

Four checks, each chosen because it is a question somebody would otherwise
answer by hand at three in the morning.

```ts
const report = await platform.health.check("acme");
// { status: "healthy" | "degraded" | "unhealthy", checks: [...] }
```

| Check | Asks | Unhealthy when |
| --- | --- | --- |
| `ledger` | Has value been created or destroyed? | The ledger does not net to zero |
| `audit` | Has stored history been altered? | The chain does not verify |
| `funding` | Is a campaign about to refuse customers? | A source is exhausted (degraded above 80%) |
| `reservations` | Is the sweep actually running? | — (degraded when reservations are stale) |

This is an **integrity** check, not a liveness probe. It reads real state and can
be slow, so run it on a schedule — the `health.check` maintenance job does, every
minute — and serve the cached result.

As the chain grows, verification resumes from the last checkpoint rather than
walking from genesis. The `audit.checkpoint` job maintains it.

## Alerting

Rules are registry entries, and each one **must** carry a `runbook` link. An
alert without a defined response cannot be added, which is the only reliable
defence against alert fatigue.

```ts
const firings = platform.alerts.evaluate({ tenant, metrics: telemetry, health });
// [{ rule, severity: "page" | "warn", message, runbook, data }]
```

| Rule | Severity |
| --- | --- |
| `ledger.unbalanced` | page |
| `audit.unverified` | page |
| `rules.broken` | page |
| `funding.exhausted` | page |
| `funding.utilisation` | warn |
| `stacking.greedy` | warn |
| `reservations.stale` | warn |

`rules.broken` earns its page: it looks like a client error and is not. An
authored condition that cannot be evaluated means the offer silently delivers
nothing until somebody fixes it.

### Counter alerts use deltas, not totals

Rules ask `input.delta(metric)` — "what happened since I last looked". Written
against cumulative totals, one funding refusal at 09:00 would page on every
evaluation for the rest of the process's life. This was a real bug; there is a
test that evaluates three times and asserts the quiet interval does not re-page.

The maintenance runner evaluates alerts after every pass and emits each one as a
telemetry event, so a deployment can forward them without polling.
