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

## Health check

```ts
const settled = caps.settle({ tenant });
const audit = caps.audit({ tenant, limit: 1 });

healthy = settled.ok && settled.value.balanced && audit.ok && audit.value.verified;
```

Cheap enough to run per minute at moderate volume. As the ledger grows, verify
from a checkpoint rather than from genesis — see
[persistence](01-persistence.md).
