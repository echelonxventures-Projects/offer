# Settlement

`src/ledger/settlement.ts`, `src/ledger/ledger.ts`, `src/ledger/payout.ts`

Two separate jobs: deciding who pays, and recording it.

## Funding allocation

`allocateFunding()` divides a benefit's cost across sources, exactly.

### Proportional

1. Split by weight using the remainder-preserving allocator.
2. Clip each share to that source's cap and remaining budget.
3. Offer any shortfall to sources with headroom, in declaration order.
4. If it still cannot be placed **in full**, fail.

Step 4 matters: a half-funded benefit is worse than a refused one, because the
subject has already been told a price.

### Waterfall

Each source absorbs cost in order, up to its cap or remaining budget, until the
cost is covered.

`examples/03-government-subsidy.ts` uses this: the state pays up to 150.00 per
transaction, the retailer covers the rest. A 270.00 subsidy splits 150.00 /
120.00, and the allocation records `limitedBy: "cap"` so the report explains
itself.

### Headroom

`budget − reserved − spent`. An absent budget means uncapped, which the
`budget.bounded` policy warns about.

## Posting convention

Stated once, so it is not re-derived per effect. The funder always takes a debit
to an expense account; the credit goes wherever the value landed.

| Effect | Debit | Credit |
| --- | --- | --- |
| `price_reduction`, `fee_waiver` | `exp:<funder>:<unit>` | `clr:<tenant>:<unit>` |
| `deferred_credit`, `wallet_credit` | `exp:<funder>:<unit>` | `liab:wallet:<subject>:<unit>` |
| `points_grant` | `exp:<funder>:<unit>` | `liab:points:<subject>:<unit>` |
| `commission` | `exp:<funder>:<unit>` | `pay:<kind>:<party>:<unit>` |

Account ids are derived from the event, not looked up in a mapping table. The
same economic event always lands in the same account.

## The balance rule

Every transaction nets to zero within **every** unit, or the write is refused.
Units balance independently — a transaction that balances in USD but not in
POINTS is rejected.

Amounts are always non-negative; `direction` carries the sign. Allowing negative
amounts would give two ways to express the same movement and guarantee that one
of them eventually appears in a report.

## Multi-unit transactions

Never. A conversion is two transactions plus an explicit exchange record, so the
rate used is always visible in the audit trail. See
[ADR 0010](../06-adr/0010-no-implicit-unit-conversion.md).

## Reconciliation

`reconcile()` nets every account by unit. `verifyLedger()` asserts the whole
ledger nets to zero in every unit and reports which do not.

`capabilities.settle()` returns both, and it is the fastest health check
available: if `balanced` is ever `false`, stop and investigate before anything
else.

## Payout

`requestPayout()` draws down a credit balance to a clearing account.

Three refusals:

| Condition | Why |
| --- | --- |
| Non-positive amount | Nothing to pay |
| Insufficient balance | Cannot pay what is not owed |
| Non-transferable unit | Loyalty points cannot be wired to a bank |

The third is enforced by the unit's **class**, not by a hardcoded list, so it
works for units nobody has invented yet.

The platform stops at the clearing account. Actually moving money is a payment
provider's job — putting card rails inside an incentive engine is how both
become unmaintainable.
