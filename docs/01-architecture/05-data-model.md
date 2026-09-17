# Data model

One stored record, and the types it is built from.

---

## ValueExchange

`src/model/value-exchange.ts`

```ts
interface ValueExchange {
  id, tenant, profile, name, description?, version, state

  visibility:  "public" | "targeted" | "private"
  acquisition: AcquisitionSpec
  window?:     TemporalWindow
  scope:       ValueExchangeScope
  conditions?: RuleNode

  benefits:    BenefitSpec[]
  funding:     FundingSpec
  limits:      LimitSpec
  stacking:    StackingSpec
  priority:    number

  attribution?: AttributionSpec
  governance:   GovernanceSpec
  metadata:     JsonObject

  createdAt, updatedAt, createdBy
}
```

### Field by field

| Field | Meaning | Notes |
| --- | --- | --- |
| `profile` | Which family this belongs to | Presentation and policy only. **Never** control flow. |
| `version` | Monotonic | A published change mints a new version; executions record the version they used. |
| `state` | Lifecycle position | Only `active` is redeemable. |
| `visibility` | Who may *discover* it | Not who may *receive* it. See [ADR 0008](../06-adr/0008-visibility-is-not-applicability.md). |
| `acquisition` | How a subject comes to hold it | `automatic`, `code`, `issued`, `earned`, `referred`. |
| `window` | When it is live | Bounds plus calendar-field constraints. |
| `scope` | Where, on which channels, for which merchants, in which realities | Empty means unrestricted. |
| `conditions` | Everything else that must hold | A serialisable rule AST. |
| `benefits` | What the subject gets | Several apply together. |
| `funding` | Who pays | Required; governance refuses publication without it. |
| `limits` | Issuance, redemption, budget and minimum-spend caps | |
| `stacking` | How it behaves beside others | Groups, exclusivity, application mode. |
| `priority` | Application order and tie-breaks | Higher first. |
| `attribution` | Which model credits this | Only meaningful for commission-style exchanges. |
| `governance` | Owner, approvals, policies, compliance | |
| `metadata` | Tenant's own data | Campaign ids, creative, external keys. |

---

## AcquisitionSpec

```ts
{ mode: "automatic" | "code" | "issued" | "earned" | "referred",
  code?: string, codeSharing?: "shared" | "unique", requiresActivation?: boolean }
```

| Mode | Requires | Typical use |
| --- | --- | --- |
| `automatic` | nothing | Sitewide promotions, cashback, commissions |
| `code` + `shared` | the code presented | A public coupon code |
| `code` + `unique` | a grant whose code matches | Personalised codes, gift cards |
| `issued` | a grant held by an identified subject | Subsidies, employee benefits |
| `earned` | as `issued`, unlocked by achievement | Loyalty rewards |
| `referred` | as `issued`, via a referral | Referral bonuses |

Codes are matched case- and whitespace-insensitively.

## BenefitSpec

```ts
{ id, type, params, effect,
  unit?, cap?, rounding?, target?, maturitySeconds? }
```

The `type` / `effect` split is the central modelling decision:

| Construct | type | effect |
| --- | --- | --- |
| Percentage discount | `percentage` | `price_reduction` |
| Cashback | `percentage` | `deferred_credit` |
| Affiliate commission | `percentage` | `commission` |
| Gift card | `flat` | `wallet_credit` |
| Free shipping | `flat` | `fee_waiver` |
| Loyalty accrual | `points_accrual` | `points_grant` |

Three of those share one handler. That is why eight handlers cover the
specification's twenty-six benefit types.

**`target`** restricts which cart lines participate: by category, SKU glob or
merchant, optionally selecting the cheapest or most expensive and capping the
line count.

**`cap`** bounds the computed value. When it binds, the line allocations are
re-spread so they still sum exactly to the capped value.

**`maturitySeconds`** is how long a deferred effect waits before it is payable.

## FundingSpec and FundingSource

```ts
FundingSpec   { model: string, splits: [{ sourceId, weight?, cap? }] }
FundingSource { id, label, party, unit, budget?, reserved, spent, alertBelowPercent? }
```

`reserved` and `spent` are tracked separately, which is what makes the two-phase
execution meaningful: an abandoned basket releases the reservation without ever
having touched `spent`.

Headroom is `budget − reserved − spent`. An absent `budget` means uncapped,
which the `budget.bounded` policy warns about.

## LimitSpec

```ts
{ totalIssuance?, totalRedemptions?, perSubject?,
  perSubjectPerPeriod?: { max, windowSeconds },
  totalBudget?, maxPerRedemption?, minimumBase? }
```

Limits are checked at eligibility and consumed at **reserve**, not at capture.
The gap between quoting and taking payment is exactly where over-redemption
happens, and a reservation closes it.

## StackingSpec

```ts
{ exclusive?, groups?, excludes?, combinesWith?,
  application?: "sequential" | "parallel" }
```

| Field | Effect |
| --- | --- |
| `exclusive` | If applied, nothing else may apply |
| `groups` | Exchanges sharing a group compete; best one wins |
| `excludes` | Named exchanges this refuses to sit with |
| `combinesWith` | Whitelist; overrides the group rule when **mutual** |
| `application` | Whether it computes on the remaining base or the original |

A one-sided `combinesWith` is not enough — both must name the other. Asserted in
`test/decision.test.ts`.

## Grant

```ts
{ id, tenant, valueExchangeId, valueExchangeVersion, subjectId?, code?,
  state: "issued" | "activated" | "reserved" | "redeemed" | "expired" | "revoked",
  issuedAt, activatedAt?, redeemedAt?, expiresAt?, uses, maxUses, metadata }
```

A grant pins the version it was issued against, so a subject holding an old
grant is not silently moved onto new terms.

## Execution

`src/model/execution.ts`

```ts
{ id, tenant, reality, decisionId, subjectId?, state, idempotencyKey?,
  benefits: ExecutedBenefit[],
  payableReduction, grantedTotals,
  createdAt, capturedAt?, releasedAt?, reversedAt?, settledAt?, metadata }
```

States: `reserved` → `captured` → `settled`, or `reserved` → `released`, or
`captured` → `reversed`.

Each `ExecutedBenefit` carries the funding allocations that paid for it, which
is what lets a refund reverse the exact split rather than re-deriving it.

## LedgerEntry

```ts
{ id, tenant, reality, transactionId, accountId, direction, amount, at,
  reference: { kind, id }, memo?, metadata? }
```

Amounts are always non-negative; `direction` carries the sign. Every
transaction nets to zero within every unit or the write is refused.

Account ids are derived, not looked up:

```
exp:<funderId>:<unit>              funder expense
clr:<tenant>:<unit>                clearing, netted at merchant settlement
liab:wallet:<subjectId>:<unit>     owed to a subject
liab:points:<subjectId>:<unit>     owed in programme currency
pay:<partyKind>:<partyId>:<unit>   owed to a third party
```

## AuditRecord

```ts
{ seq, tenant, reality, kind, subject: { kind, id }, actor, at,
  correlationId?, payload, previousHash, hash }
```

`hash = SHA-256(previousHash ‖ canonical(everything else))`. Editing any record
invalidates every hash after it, and `verify()` reports the sequence number
where the chain first breaks.

---

## What is deliberately absent

**No soft-delete flag.** Archival is a lifecycle state.

**No denormalised totals on the exchange.** Counters live in `CounterStore`, so
the exchange record is immutable between versions and can be cached hard.

**No embedded audit.** Audit is a separate append-only chain, so the exchange
record does not grow without bound.

**No polymorphic subtype table.** There is no `coupons` table beside an `offers`
table. That is the whole point.
