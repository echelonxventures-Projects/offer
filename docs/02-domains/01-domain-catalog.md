# Domain catalog

The specification enumerates sixty-seven domains. This table maps every one to
where it actually lives, so the coverage claim can be checked rather than
believed.

They fall into four groups:

| Group | Count | Where it lives |
| --- | --- | --- |
| **Profile** — a kind of value exchange | 25 | `domain-profile` registry + data on the record |
| **Engine** — a platform behaviour | 24 | An engine in `src/engines`, `src/ledger`, `src/attribution` |
| **Registry** — a universal dimension | 11 | `src/universal` + its registries |
| **Aspect** — a cross-cutting concern | 7 | Fields on the record, or a mechanism |

The important number is the first one. Twenty-five "domains" of offer are
eleven profiles over **one record**, because most of the distinctions in that
list are a benefit type and an effect, not a different mechanism.

---

## The sixty-seven

| # | Domain | Group | Where it lives |
| --: | --- | --- | --- |
| 01 | Incentive | Profile | `incentive` profile |
| 02 | Offer | Profile | `incentive` profile |
| 03 | Coupon | Profile | `coupon` profile — `acquisition.mode: "code"` |
| 04 | Promotion | Profile | `promotion` profile — `acquisition.mode: "automatic"` |
| 05 | Discount | Profile | `promotion` profile — `percentage`/`flat` + `price_reduction` |
| 06 | Cashback | Profile | `cashback` profile — `percentage` + `deferred_credit` |
| 07 | Reward | Profile | `loyalty` profile — `points_accrual` + `points_grant` |
| 08 | Gift card | Profile | `stored_value` profile — `flat` + `wallet_credit` |
| 09 | Voucher | Profile | `stored_value` profile — unique-code acquisition |
| 10 | Loyalty | Profile | `loyalty` profile |
| 11 | Membership | Profile | `membership_benefit` profile — `subject.hasMembership` condition |
| 12 | Referral | Profile | `referral` profile — two exchanges, one per side |
| 13 | Affiliate | Profile | `affiliate_commission` profile — `commission` effect |
| 14 | Creator | Profile | `affiliate_commission` profile — party kind `creator` |
| 15 | Influencer | Profile | `affiliate_commission` profile — party kind `creator` |
| 16 | Deal | Profile | `promotion` profile |
| 17 | Pricing | Profile | `dynamic_pricing` profile — `fixed_price` benefit |
| 18 | Dynamic pricing | Profile | `dynamic_pricing` profile — rule-driven `tiered`/`volume` |
| 19 | Auction | Profile | `dynamic_pricing` profile — clearing price as a context facet |
| 20 | Subscription benefit | Profile | `membership_benefit` profile |
| 21 | Partner benefit | Profile | `membership_benefit` profile — party kind `partner` |
| 22 | Corporate benefit | Profile | `membership_benefit` profile — subject is the account |
| 23 | Government benefit | Profile | `government_benefit` profile — jurisdiction-scoped, state-funded |
| 24 | Employee benefit | Profile | `membership_benefit` profile — party kind `employer` |
| 25 | Gamification | Profile | `loyalty` profile — counters in context, `entitlement_grant` |
| 26 | Audience | Engine | `subject.segments` in context; `subject.hasSegment` operator |
| 27 | Segmentation | Engine | Context resolver at the `enrich` stage |
| 28 | Campaign | Aspect | `metadata` on the record; campaign id as a facet |
| 29 | Discovery | Engine | `DiscoveryEngine` |
| 30 | Search | Engine | `DiscoveryEngine` with `text` |
| 31 | Recommendation | Engine | `DiscoveryEngine` ranking + `decision-objective` |
| 32 | Personalization | Engine | Context facets + conditions. **No ML — see note.** |
| 33 | Distribution | Engine | **Not implemented.** See [known gaps](../08-roadmap/02-known-gaps.md) |
| 34 | Syndication | Engine | **Not implemented.** Partner feeds |
| 35 | Marketplace | Aspect | Party kind `marketplace`; merchant scoping |
| 36 | Merchant | Aspect | Party kind `merchant`; `scope.merchants` |
| 37 | Brand | Aspect | Party kind `brand` |
| 38 | Provider | Aspect | Party kind, tenant-defined |
| 39 | Partner | Aspect | Party kind `partner` |
| 40 | Exchange | Registry | `exchange-rate` registry; `EconomicAuthority.convert` |
| 41 | Attribution | Engine | `AttributionEngine`, five models |
| 42 | Tracking | Engine | `capabilities.track` → touchpoints |
| 43 | Wallet | Engine | `liab:wallet:*` ledger accounts |
| 44 | Treasury | Engine | `FundingStore` + `reconcile()` |
| 45 | Funding | Engine | `allocateFunding`, `funding-model` registry |
| 46 | Budget | Engine | `FundingSource.budget/reserved/spent`; `LimitSpec.totalBudget` |
| 47 | Payment | Engine | Out of scope — the platform records obligations, it does not move money |
| 48 | Settlement | Engine | `postBenefit`, double-entry ledger |
| 49 | Reconciliation | Engine | `reconcile()`, `verifyLedger()` |
| 50 | Payout | Engine | `requestPayout`, `capabilities.pay` |
| 51 | Fraud | Engine | `RiskEngine` signals |
| 52 | Risk | Engine | `RiskEngine` scoring and dispositions |
| 53 | Analytics | Engine | **Not implemented.** Derivable from ledger + audit |
| 54 | Forecasting | Engine | `capabilities.forecast` — linear extrapolation only |
| 55 | Simulation | Engine | `reality.effectsAreBinding: false` |
| 56 | AI | Engine | **Not implemented.** See note below |
| 57 | Agent | Engine | **Not implemented.** The capability layer is the surface one would use |
| 58 | Governance | Engine | `GovernanceEngine`, `policy` registry |
| 59 | Compliance | Engine | `policy` registry + `governance.compliance` |
| 60 | Knowledge | Aspect | `platform.describe()` + generated reference |
| 61 | Registry | Registry | `src/registry` — the mechanism itself |
| 62 | Universal context | Registry | `src/context` + `context-resolver` registry |
| 63 | Universal temporal | Registry | `src/universal/temporal` |
| 64 | Universal spatial | Registry | `src/universal/spatial` |
| 65 | Universal economic | Registry | `src/universal/economic` |
| 66 | Universal governance | Registry | `lifecycle-transition` + `policy` registries |
| 67 | Universal reality | Registry | `src/universal/reality` |

---

## Notes on the honest entries

**32 Personalization, 56 AI.** Conditions, segments, facets and objectives give
you rule-driven personalisation, which is what most of this domain actually is
in practice. There is no learned model, no embedding, no generated offer copy.
A tenant wanting a model registers it as a context resolver (producing a score
facet) or as a `decision-objective`. The hook is real; the model is not shipped.

**33 Distribution, 34 Syndication.** No email, SMS, push or partner feed. The
`channel` field on the context and `scope.channels` on the record are the
integration point — the platform decides *what* a channel should show, and does
not deliver it.

**47 Payment.** Deliberately out of scope, and the boundary is worth stating:
this platform records that a party is owed money and moves the balance to a
clearing account. Actually paying is a payment provider's job. Conflating the
two would put card networks and bank rails inside an incentive engine.

**53 Analytics.** Everything needed is in the ledger and the audit chain; no
reporting layer is built. [The incentive graph](../01-architecture/06-incentive-graph.md)
lists the queries and confirms each is derivable.

**54 Forecasting.** `capabilities.forecast` extrapolates from observed
spend-per-redemption. With no history it returns `null` rather than a confident
zero. That is the honest answer, not a placeholder.

---

## Coverage check

`test/platform.test.ts` → *"every profile maps to numbered specification
domains"* asserts that domains 1–25 are each claimed by a profile, and that
every profile declares which it covers. If a profile is added without a
`specDomains` entry, or a domain in 1–25 loses its profile, the test fails.

Domains 26–67 are not asserted mechanically; they are engines and registries,
and their coverage is the table above plus the code it points at.
