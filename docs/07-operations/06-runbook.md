# Runbook

The incidents you will actually have, in roughly the order you will have them.

---

## 1. "The offer isn't applying"

The most common report by a wide margin. It is almost never a platform bug.

```ts
const quote = caps.apply({ context, codes, candidateIds: [suspectId] });
const rejection = quote.value.decision.rejected[0];

rejection.reason;          // "acquisition: code not presented"
rejection.verdict.checks;  // all ten, pass and fail
rejection.verdict.ruleTrace;
```

| `primaryReason` | Cause | Fix |
| --- | --- | --- |
| `reality: ...` | Scoped to another reality | Check `scope.realities` |
| `lifecycle: state 'draft'` | Never published | `publish` it |
| `window: before window start` | Not live yet | Check `window.from` |
| `window: calendar field ... outside constraint` | Weekend-only, and it is Tuesday | Expected |
| `spatial: place ... is out of scope` | Wrong location | Check `scope.spatial` |
| `channel: context channel 'web'` | Wrong channel | Check `scope.channels` |
| `merchant: no matching lines` | No cart line from a scoped merchant | Check `scope.merchants` |
| `acquisition: code not presented` | Code missing or mistyped | Check the code |
| `acquisition: subject holds no usable grant` | Not issued, or uses exhausted | `issue` it |
| `minimum_base: ...` | Basket too small | Expected |
| `limit.*` | Campaign exhausted | Expected — tell the owner |
| `conditions: ...` | A rule said no | Read `ruleTrace` |

If it is `conditions`, the rule trace names the predicate and prints the values
it compared. That is usually the whole diagnosis.

---

## 2. `RULE_ERROR` in production

**Severity: page.** This looks like a client error and is not.

It means an authored condition cannot be evaluated, so the offer never applies
and the campaign is silently delivering nothing.

```
operator 'gt': cannot order string against amount(INR)
```

**Do:**
1. Identify the exchange from the correlation id.
2. `caps.govern({ tenant, actor, valueExchangeId, to: "paused" })` — stop it
   looking live while broken.
3. Fix the condition, re-publish.
4. Check how long it was broken; the campaign owner will want to know.

**Prevention:** evaluate conditions against a representative context in the
sandbox reality before publishing. `validate` checks policy, not rule semantics
— a gap listed in [known gaps](../08-roadmap/02-known-gaps.md).

---

## 3. Ledger does not balance

**Severity: page. Stop and investigate before anything else.**

```ts
const settled = caps.settle({ tenant });
settled.value.balanced;    // false
```

This should be impossible — `assertBalanced` refuses unbalanced transactions at
the write boundary. If it happens, one of:

- Entries were written directly to the store, bypassing the engine.
- A partial transaction committed (a capture that wrote some entries and
  crashed). This is the likely cause, and it points at a missing transaction
  boundary in the storage adapter.
- Data corruption or a bad migration.

**Do:**
1. Stop financial capabilities (`redeem`, `reserve`, `pay`).
2. `reconcile()` and find the account and unit that do not net.
3. Find the `transactionId` with an odd number of sides.
4. Correct with a compensating entry — **never** by editing a stored row.
5. Fix the transaction boundary that allowed it.

---

## 4. Audit chain verification fails

**Severity: page. Treat as a security incident.**

```ts
caps.audit({ tenant }).value.verified;   // false
```

The error names the sequence number where the chain first breaks.

**Do:**
1. Do not write to the audit store.
2. Compare the head hash against your external anchor, if you have one. If the
   anchor agrees with the chain up to sequence *N*, the break is after *N*.
3. Establish who had write access to the audit table.
4. Preserve the records; they are evidence.

If you have no external anchor, you cannot distinguish tampering from
corruption. Set one up — see [security](03-security.md).

---

## 5. Budget exhausted mid-campaign

```
INSUFFICIENT_FUNDS: funding sources cannot cover 4550 INR
  shortfallMinor: "1200", sources: ["merchant-acme"]
```

Customers are being refused a price they may already have been shown.

**Do:**
1. `caps.fund({ ..., sourceId, budgetDecimal })` to top up — it adds to the
   existing budget for a source that already exists.
2. Or pause the campaign: `govern({ to: "paused" })`.

**Prevention:** alert at 80% on `funding.utilisation`, and use
`caps.forecast()` to project the exhaustion date from observed burn.

---

## 6. Reservations accumulating

Budget held by executions that were never captured or released.

```ts
const stale = executions.filter(
  (e) => e.state === "reserved" && Number(e.createdAt) < nowMs - 3_600_000,
);
for (const e of stale) caps.release({ context, executionId: e.id });
```

**There is no reaper in this implementation.** A deployment must add one. Until
then this incident is not a possibility but a certainty. It is the first entry
in [known gaps](../08-roadmap/02-known-gaps.md).

---

## 7. Stacking went greedy

```ts
decision.searchMode === "greedy"
```

Not an outage. It means more than ten offers were simultaneously eligible and
the chosen combination may not be optimal.

**Do:** look at `decision.displaced`. Usually several offers should have been in
the same stacking group and are not. Tighten the groups; the search returns to
exhaustive and the answers get better as well as faster.

---

## 8. A customer disputes a decision

1. Find the decision by `correlationId` or by the execution.
2. `decision.hash` — the canonical hash of what was decided.
3. The `execution.reserved` audit record carries the same hash. If they match,
   the execution followed that exact decision.
4. `decision.contextTrace` shows the facts it was made on.
5. Re-run it: same context, same registry version, injected clock set to the
   recorded instant. The hash should reproduce.

If the hash does not reproduce, the registries have changed since. Registry
bundle versioning would pin this and is **not implemented** — a real limitation
for dispute resolution, listed in [known gaps](../08-roadmap/02-known-gaps.md).

---

## 9. Over-redemption

A limit of 1 000 was redeemed 1 040 times.

Almost certainly the counter adapter is not atomic. The reference adapter is
safe only because it is single-threaded.

**Do:**
1. Pause the campaign.
2. Count actual captures from the ledger, not from the counters.
3. Reconcile the counters to reality.
4. **Fix the adapter** — conditional update or row lock. See
   [persistence](01-persistence.md).

Over-redemption is not recoverable after the fact; the benefits have been given.
The fix is preventing the next one.
