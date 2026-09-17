/**
 * Funding.
 *
 * Every benefit costs somebody something. A platform that computes discounts
 * without recording who pays for them produces a number that finance cannot
 * reconcile and legal cannot defend, which is the commonest failure mode of
 * promotion systems.
 *
 * A funding source is a budget held by a party. A funding spec says how the
 * cost of a benefit divides across sources. The allocator is the exact,
 * remainder-preserving one, so the splits always sum back to the cost.
 */
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";
import type { Amount } from "../universal/economic/amount.ts";

/** Who holds a budget. Kinds are registry-driven so new party types are data. */
export interface PartyRef {
  /** Key into the party-kind registry: merchant, brand, marketplace, bank... */
  readonly kind: string;
  readonly id: string;
}

export interface PartyKind extends RegistryEntry {
  /** May this party be paid out to, or only charged? */
  readonly payable: boolean;
}

export const DEFAULT_PARTY_KINDS: PartyKind[] = [
  { key: "merchant", label: "Merchant", payable: true },
  { key: "brand", label: "Brand or manufacturer", payable: true },
  { key: "marketplace", label: "Marketplace operator", payable: true },
  { key: "partner", label: "Commercial partner", payable: true },
  { key: "bank", label: "Bank or card issuer", payable: true },
  { key: "government", label: "Government body", payable: true },
  { key: "employer", label: "Employer", payable: true },
  { key: "platform", label: "The platform operator itself", payable: true },
  { key: "affiliate", label: "Affiliate", payable: true },
  { key: "creator", label: "Creator or influencer", payable: true },
  { key: "subject", label: "The end subject", payable: true },
];

export interface FundingSource {
  readonly id: string;
  /**
   * Owning tenant. Phase 1 addition: the reference adapter previously keyed
   * sources by id alone, so two tenants using the same source id would have
   * collided - and shared a budget.
   */
  readonly tenant: string;
  readonly label: string;
  readonly party: PartyRef;
  /** Unit this budget is denominated in. */
  readonly unit: string;
  /** Total budget. Absent means uncapped, which governance should discourage. */
  readonly budget?: Amount;
  /** Committed but not yet captured. */
  readonly reserved: Amount;
  /** Captured and owed or paid. */
  readonly spent: Amount;
  /** Warn when the remaining budget drops below this fraction, in percent. */
  readonly alertBelowPercent?: number;
}

export interface FundingSplit {
  readonly sourceId: string;
  /** Relative weight for proportional models; order matters for waterfall. */
  readonly weight?: number;
  /** Maximum this source contributes to a single benefit. */
  readonly cap?: { readonly decimal: string; readonly unit?: string };
}

export interface FundingModel extends RegistryEntry {
  readonly strategy: "proportional" | "waterfall";
}

export const DEFAULT_FUNDING_MODELS: FundingModel[] = [
  {
    key: "single",
    label: "Single funder",
    description: "One source bears the whole cost.",
    strategy: "proportional",
  },
  {
    key: "proportional",
    label: "Proportional split",
    description: "Cost divides by weight. Remainders go to the largest weight, deterministically.",
    strategy: "proportional",
  },
  {
    key: "waterfall",
    label: "Waterfall",
    description: "Sources absorb cost in order until each one's cap or budget is reached.",
    strategy: "waterfall",
  },
];

export interface FundingSpec {
  /** Key into the funding-model registry. */
  readonly model: string;
  readonly splits: readonly FundingSplit[];
}

/** One source's share of one benefit, produced by the settlement engine. */
export interface FundingAllocation {
  readonly sourceId: string;
  readonly party: PartyRef;
  readonly amount: Amount;
  /** Set when a cap or an exhausted budget reduced this source's share. */
  readonly limitedBy?: "cap" | "budget";
}

export function fundingModelRegistry(): Registry<FundingModel> {
  return new Registry<FundingModel>("funding-model").registerAll(DEFAULT_FUNDING_MODELS);
}

export function partyKindRegistry(): Registry<PartyKind> {
  return new Registry<PartyKind>("party-kind").registerAll(DEFAULT_PARTY_KINDS);
}
