# Profiles

A profile is a **label**, not a subtype. It carries presentation metadata and
selects governance policies. No engine branches on it.

The test for whether this is true: delete `src/profiles` and the platform still
decides, executes and settles correctly. Only the names change.

---

## The eleven

| Key | Covers spec domains | Default effect | Typical acquisition |
| --- | --- | --- | --- |
| `incentive` | 1, 2 | `price_reduction` | automatic |
| `coupon` | 3 | `price_reduction` | code |
| `promotion` | 4, 5, 16 | `price_reduction` | automatic |
| `cashback` | 6 | `deferred_credit` | automatic |
| `loyalty` | 7, 10, 25 | `points_grant` | automatic |
| `stored_value` | 8, 9 | `wallet_credit` | unique code |
| `membership_benefit` | 11, 20, 21, 22, 24 | `price_reduction` | automatic + condition |
| `referral` | 12 | `wallet_credit` | referred |
| `affiliate_commission` | 13, 14, 15 | `commission` | automatic |
| `dynamic_pricing` | 17, 18, 19 | `price_reduction` | automatic |
| `government_benefit` | 23 | `price_reduction` | issued |

## What a profile entry contains

```ts
{
  key, label, description?,
  specDomains?: number[],       // traceability back to the specification
  defaultEffect?: string,       // what this family usually does
  requiredPolicies?: string[],  // governance applied to every member
}
```

That is the whole thing. No behaviour, no handler, no dispatch table.

## The builders

`src/profiles/builders.ts` holds one function per profile family. Read them side
by side — it is the clearest statement of the architecture's central claim.

```ts
coupon({  name, code: "WEEKEND15", percentOff: "15", cap: "200.00", ... })
cashback({ name, percent: "5", maturityDays: 30, parallel: true, ... })
governmentBenefit({ name, percentOff: "30", jurisdictions: ["IN-BR"], ... })
affiliateCommission({ name, percent: "8", attributionModel: "position_based", ... })
giftCard({ name, faceValue: "50.00", code: "GC-...", ... })
loyaltyAccrual({ name, points: 2, per: 1, ... })
membershipBenefit({ name, memberships: ["gold"], percentOff: "10", ... })
```

All seven return `ValueExchangeDraft`. The differences:

| Builder | acquisition | benefit type | effect | stacking |
| --- | --- | --- | --- | --- |
| `coupon` | `code` / shared | `percentage` or `flat` | `price_reduction` | sequential |
| `cashback` | `automatic` | `percentage` | `deferred_credit` | **parallel** |
| `loyaltyAccrual` | `automatic` | `points_accrual` | `points_grant` | **parallel** |
| `governmentBenefit` | `issued` | `percentage` or `flat` | `price_reduction` | sequential |
| `affiliateCommission` | `automatic` | `percentage` | `commission` | **parallel** |
| `giftCard` | `code` / unique | `flat` | `wallet_credit` | sequential |
| `membershipBenefit` | `automatic` + condition | `percentage` | `price_reduction` | sequential |

Four columns of data. That is the entire difference between a coupon and a
government subsidy.

## Why three of them are parallel

Cashback, loyalty accrual and commission all use
`stacking.application: "parallel"`, and the reason is the same each time: they
must not shrink because a discount ran first.

A customer told "5% back" on a 40 000 basket expects 2 000, not 1 800 computed
on the post-discount 36 000. A partner on 8% commission expects it on order
value. Example 2 demonstrates this with the numbers printed.

Discounts are sequential because compounding is the honest reading of "20% off
and then 10% off".

## Adding a profile

```ts
platform.deps.profiles.register({
  key: "insurance_no_claims",
  label: "No-claims discount",
  description: "Premium reduction that grows with claim-free years.",
  specDomains: [],
  defaultEffect: "price_reduction",
  requiredPolicies: ["funding.declared"],
});
```

Then a builder, if the shape recurs:

```ts
export function noClaimsDiscount(params: { years: number; ... }): ValueExchangeDraft {
  return {
    profile: "insurance_no_claims",
    conditions: gte(fn("subject.counter", lit("claimFreeYears")), lit(params.years)),
    benefits: [{ id: "ncd", type: "tiered", params: { tiers: [...] }, effect: "price_reduction" }],
    // ... the same fields as every other draft
  };
}
```

No engine changes. No new tables. No dispatch.

## The trap to avoid

The moment someone writes this in an engine:

```ts
if (exchange.profile === "government_benefit") {
  // special handling
}
```

…the architecture is over. Whatever that special handling is, it belongs in one
of: a condition, a policy, a benefit type, an effect kind, or a funding model.
`test/platform.test.ts` greps the engines for domain vocabulary precisely to
catch the first instance of this.
