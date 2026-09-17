/**
 * Domain profiles.
 *
 * A profile is presentation and policy metadata for a family of value
 * exchanges. It is *not* a subtype: no engine branches on it, and removing the
 * whole profiles module would change what things are called and nothing else.
 *
 * `specDomains` traces each profile back to the numbered domains in the
 * constitutional specification, so the mapping from "67 domains" to "one record
 * and eleven labels" is checkable rather than asserted. The domains that do not
 * appear here are not missing - they are platform capabilities rather than
 * kinds of offer, and docs/02-domains/domain-catalog.md maps every one of the
 * sixty-seven to where it actually lives.
 */
import type { DomainProfile } from "../model/value-exchange.ts";

export const DEFAULT_PROFILES: DomainProfile[] = [
  {
    key: "incentive",
    label: "Generic incentive",
    description: "The unadorned base case. Use it when no more specific profile fits.",
    specDomains: [1, 2],
    defaultEffect: "price_reduction",
  },
  {
    key: "coupon",
    label: "Coupon",
    description: "Code-acquired, single-use by default, usually merchant-funded.",
    specDomains: [3],
    defaultEffect: "price_reduction",
  },
  {
    key: "promotion",
    label: "Promotion or deal",
    description: "Automatic price reduction with no code: sales, deals, bundles, flash offers.",
    specDomains: [4, 5, 16],
    defaultEffect: "price_reduction",
  },
  {
    key: "cashback",
    label: "Cashback",
    description: "Value returned after the fact. Same arithmetic as a discount, different effect.",
    specDomains: [6],
    defaultEffect: "deferred_credit",
  },
  {
    key: "loyalty",
    label: "Loyalty and gamification",
    description: "Points, coins, streaks, tiers. Programme currency rather than money.",
    specDomains: [7, 10, 25],
    defaultEffect: "points_grant",
  },
  {
    key: "stored_value",
    label: "Gift card or voucher",
    description: "Pre-funded value the subject holds and spends down.",
    specDomains: [8, 9],
    defaultEffect: "wallet_credit",
    requiredPolicies: ["funding.declared"],
  },
  {
    key: "membership_benefit",
    label: "Membership, subscription and corporate benefit",
    description: "Entitlements that follow from who the subject is, not what they bought.",
    specDomains: [11, 20, 21, 22, 24],
    defaultEffect: "price_reduction",
  },
  {
    key: "referral",
    label: "Referral",
    description: "Two-sided: the referrer and the referred each hold their own exchange.",
    specDomains: [12],
    defaultEffect: "wallet_credit",
  },
  {
    key: "affiliate_commission",
    label: "Affiliate, creator and influencer commission",
    description: "Value owed to a third party for driving the interaction, not to the buyer.",
    specDomains: [13, 14, 15],
    defaultEffect: "commission",
    requiredPolicies: ["commission.payable_unit"],
  },
  {
    key: "dynamic_pricing",
    label: "Pricing and auction",
    description: "Price set by rule or by market rather than by a fixed list.",
    specDomains: [17, 18, 19],
    defaultEffect: "price_reduction",
  },
  {
    key: "government_benefit",
    label: "Government benefit or subsidy",
    description: "Publicly funded, jurisdiction-scoped, and usually the strictest on audit.",
    specDomains: [23],
    defaultEffect: "price_reduction",
    requiredPolicies: ["funding.declared", "owner.named"],
  },
];

export * from "./builders.ts";
