# Capability reference

Twenty-two verbs. The entire external surface. A caller reaches nothing else.

Every capability returns `Result<T, GoipError>`. Every capability that needs
context takes a `ContextRequest` and resolves it internally, so callers never
assemble a context themselves.

Search this page for "coupon" or "cashback" — they do not appear, and that is
the point.

---

## Author

### `create`

```ts
create({ tenant, actor, draft, id? }): Result<ValueExchange>
```

Creates a value exchange in `draft` state. The profile must be registered.
Audits `value_exchange.created`.

### `clone`

```ts
clone({ tenant, actor, valueExchangeId, name? }): Result<ValueExchange>
```

A fresh `draft` copy with a new id. Approvals are **not** inherited — a clone
must be approved on its own merits.

### `publish`

```ts
publish({ tenant, actor, valueExchangeId, approvedBy? }): Result<ValueExchange>
```

Records the approval if given, then walks the shortest legal route to `active`.
Policy review runs at `approved` and at `active`. Refuses with
`GOVERNANCE_REJECTED` if a policy error blocks it, or if `approvedBy` equals the
author.

### `govern`

```ts
govern({ tenant, actor, valueExchangeId, to? }): Result<{ report, exchange }>
```

Runs policy review. With `to`, also attempts that transition.

### `validate`

```ts
validate({ tenant, valueExchangeId }): Result<PolicyReport>
```

Review only. Changes nothing.

---

## Distribute

### `discover`

```ts
discover({ context, profile?, includeIneligible?, limit?, rank? })
  : Result<{ results: DiscoveredExchange[], context }>
```

What is available to this subject. Private exchanges are excluded. Each result
reports its **standalone** value, never a stacked total.

`rank` is a key into the `discovery-ranking` registry — `value` (default),
`priority`, `name` or `recommended` — and an unknown key is refused rather than
quietly falling back. A ranking built from weighted features also returns its
`ranking` explanation on each result. See
[intelligence](../09-intelligence/01-overview.md).

### `search`

```ts
search({ context, text, limit? }): Result<{ results, context }>
```

Discovery narrowed by case-insensitive substring over name and description.

### `compare`

```ts
compare({ context, objectives, codes?, candidateIds? })
  : Result<{ objective, decision }[]>
```

The same context under several objectives. Useful for showing a campaign owner
what a different objective would cost.

### `issue`

```ts
issue({ tenant, actor, valueExchangeId, subjectId, code?, maxUses?, expiresAt?, metadata? })
  : Result<Grant>
```

Grants an exchange to a named subject. Enforces `limits.totalIssuance`. The
grant starts `activated` unless the exchange requires activation.

### `activate`

```ts
activate({ tenant, actor, grantId }): Result<Grant>
```

Turns an `issued` grant into an `activated` one. Idempotent.

---

## Decide

### `apply`

```ts
apply({ context, codes?, candidateIds?, objective?, assessRisk? })
  : Result<{ decision, context, risk? }>
```

**The main one.** Quote what this subject would get. Commits nothing.

With `assessRisk: true`, a `block` disposition refuses the call with
`RISK_BLOCKED`.

### `optimize`

```ts
optimize({ context, objective, ... }): Result<{ decision, context, risk? }>
```

`apply` with an explicit objective.

### `simulate`

```ts
simulate({ context, reality?, ... }): Result<{ decision, context, risk? }>
```

Runs in a non-binding reality (`"simulation"` by default). **Refuses** if the
named reality is binding — checked, not assumed.

### `forecast`

```ts
forecast({ tenant, sourceIds? }): Result<ForecastResult[]>
```

Budget burn per funding source: committed, available, utilisation percentage,
and projected remaining redemptions at the observed mean spend.

Returns `null` for projections when there is no history, rather than a confident
zero.

---

## Execute

### `reserve`

```ts
reserve({ context, actor, idempotencyKey?, codes?, metadata? })
  : Result<{ decision, context, execution }>
```

Decides, then holds budget and consumes limits. **Writes nothing to the ledger.**
Always pass an `idempotencyKey`.

### `redeem`

```ts
redeem({ context, actor, idempotencyKey?, codes?, payee?, metadata? })
  : Result<{ decision, context, execution, entries }>
```

`reserve` followed by capture. Posts balanced double entries — unless the
reality is non-binding, in which case everything runs and nothing is written.

`payee` names who a commission is owed to.

### `release`

```ts
release({ context, executionId }): Result<Execution>
```

Gives back the holds and the limits. Only from `reserved`.

### `reverse`

```ts
reverse({ context, executionId, reason }): Result<Execution>
```

Contra entries, `spent` restored, limits given back. Only from `captured` or
`settled`.

---

## Observe

### `track`

```ts
track({ tenant, kind, party, subjectId?, deviceId?, valueExchangeId?, channel?, metadata? })
  : Result<Touchpoint>
```

Records a touchpoint. Kinds: `view`, `click`, `share`, `referral`, `assist`,
`conversion`.

### `attribute`

```ts
attribute({ tenant, subjectId?, deviceId?, valueExchangeId?, model?, value?, lookbackSeconds? })
  : Result<{ shares: AttributionShare[], touchpoints: number }>
```

Divides credit across the journey. Basis points always sum to exactly 10 000;
money always sums to exactly the value.

### `audit`

```ts
audit({ tenant, limit? }): Result<{ verified, head, records, recent }>
```

Verifies the chain and returns the most recent records. `verified: false` means
a stored record no longer matches its hash — see
[the runbook](../07-operations/06-runbook.md).

---

## Settle

### `fund`

```ts
fund({ tenant, actor, sourceId, label, party, unit, budgetDecimal? })
  : Result<FundingSource>
```

Creates a funding source, or tops up an existing one when `budgetDecimal` is
given for a source that already exists.

### `settle`

```ts
settle({ tenant }): Result<{ positions, balanced, entries }>
```

Nets the ledger into per-account positions and verifies it sums to zero in every
unit.

**If `balanced` is ever `false`, stop and investigate.**

### `pay`

```ts
pay({ tenant, reality?, fromAccountId, destination, unit, decimal, memo? })
  : Result<{ payoutId, entries }>
```

Draws down a credit balance to a clearing account. Refuses a non-transferable
unit, an overdraw, or a non-positive amount.

The platform stops at the clearing account; moving money is a payment provider's
job.

---

## Introspection

```ts
platform.capabilities.list();   // CapabilityDescriptor[]
platform.describe();            // every registry and its entries
```

Each descriptor carries `phase`, `mutating` and `financial`. The five financial
capabilities are exactly `fund`, `pay`, `redeem`, `reserve` and `settle` —
asserted in `test/platform.test.ts`, and the right basis for an alerting rule.

## Mapping to HTTP

Mechanical, because the surface is closed and the errors are typed:

```
POST /v1/value-exchanges              → create
POST /v1/value-exchanges/:id/publish  → publish
POST /v1/decisions                    → apply
POST /v1/executions                   → reserve
POST /v1/executions/:id/capture       → (redeem, split)
GET  /v1/discovery                    → discover
GET  /v1/audit                        → audit
```

Status codes come from [the error table](02-errors.md).
