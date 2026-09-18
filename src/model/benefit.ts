/**
 * Benefits.
 *
 * A benefit says what the subject gets. It is split into two halves that are
 * routinely confused and must not be:
 *
 *   - the *computation*: how much value, decided by a benefit-type handler
 *   - the *effect*: what that value does, decided by an effect kind
 *
 * A percentage discount and a percentage cashback compute identically and
 * differ only in effect - one reduces the price now, the other credits a wallet
 * later. Keeping them apart is why the same handler serves both, and why adding
 * "deferred cashback paid in carbon credits" is configuration rather than code.
 */
import type { Result } from "../kernel/result.ts";
import type { JsonObject } from "../kernel/types.ts";
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";
import type { Amount, RoundingMode } from "../universal/economic/amount.ts";
import type { EconomicAuthority } from "../universal/economic/authority.ts";
import type { CartLine, ResolvedContext } from "../context/context.ts";

/** What the computed value actually does to the world. */
export interface EffectKind extends RegistryEntry {
  /** Does this reduce the amount payable in this interaction? */
  readonly reducesPayable: boolean;
  /** Does it create a balance the platform owes the subject later? */
  readonly createsLiability: boolean;
  /** Must settlement move value between parties for this to be honoured? */
  readonly requiresSettlement: boolean;
  /**
   * Key into the posting-rule registry: where the credit side lands.
   *
   * Named rather than derived, so a new effect kind chooses its posting instead
   * of the ledger growing a branch for it. See `src/ledger/posting.ts`.
   */
  readonly posting: string;
}

export const DEFAULT_EFFECT_KINDS: EffectKind[] = [
  {
    key: "price_reduction",
    posting: "clearing",
    label: "Price reduction",
    description: "Reduces what the subject pays now. Discounts, promotions, subsidies at point of sale.",
    reducesPayable: true,
    createsLiability: false,
    requiresSettlement: true,
  },
  {
    key: "deferred_credit",
    posting: "subject_wallet",
    label: "Deferred credit",
    description: "Owed to the subject after a holding period. Classic cashback.",
    reducesPayable: false,
    createsLiability: true,
    requiresSettlement: true,
  },
  {
    key: "wallet_credit",
    posting: "subject_wallet",
    label: "Immediate wallet credit",
    reducesPayable: false,
    createsLiability: true,
    requiresSettlement: true,
  },
  {
    key: "points_grant",
    posting: "subject_points",
    label: "Points grant",
    description: "Programme currency. A liability, but usually not settled in cash.",
    reducesPayable: false,
    createsLiability: true,
    requiresSettlement: false,
  },
  {
    key: "item_grant",
    posting: "clearing",
    label: "Item grant",
    description: "A free product, service or sample added to the fulfilment.",
    reducesPayable: false,
    createsLiability: false,
    requiresSettlement: true,
  },
  {
    key: "fee_waiver",
    posting: "clearing",
    label: "Fee waiver",
    description: "Shipping, handling or service fee removed.",
    reducesPayable: true,
    createsLiability: false,
    requiresSettlement: true,
  },
  {
    key: "entitlement_grant",
    posting: "clearing",
    label: "Entitlement grant",
    description: "A right rather than a value: tier upgrade, lounge access, a seat.",
    reducesPayable: false,
    createsLiability: false,
    requiresSettlement: false,
  },
  {
    key: "commission",
    posting: "third_party_payable",
    label: "Commission",
    description: "Value owed to a third party - affiliate, creator, partner - not to the buyer.",
    reducesPayable: false,
    createsLiability: true,
    requiresSettlement: true,
  },
];

/** Which part of the interaction a benefit attaches to. */
export interface BenefitTarget {
  /** Restrict to lines in these categories. */
  readonly categories?: readonly string[];
  /** Restrict to lines whose SKU glob-matches. */
  readonly skus?: readonly string[];
  /** Restrict to lines from these merchants. */
  readonly merchants?: readonly string[];
  /** Pick a subset of the matching lines. */
  readonly select?: "all" | "cheapest" | "most_expensive";
  /** Cap on how many matching lines are affected. */
  readonly maxLines?: number;
  /** Cap on how many units per line are affected. */
  readonly maxQuantityPerLine?: number;
}

export interface BenefitSpec {
  readonly id: string;
  /** Key into the benefit-type registry. */
  readonly type: string;
  /** Handler-specific parameters, validated by the handler. */
  readonly params: JsonObject;
  /** Key into the effect-kind registry. */
  readonly effect: string;
  /** Unit the benefit is denominated in. Defaults to the context unit. */
  readonly unit?: string;
  /** Upper bound on the computed value, in `unit`. */
  readonly cap?: { readonly decimal: string; readonly unit?: string };
  /** Rounding applied by the handler. Defaults to the platform default. */
  readonly rounding?: RoundingMode;
  readonly target?: BenefitTarget;
  /** How long until a deferred effect matures, in frame seconds. */
  readonly maturitySeconds?: number;
}

/** Per-line attribution of the benefit, needed for refunds and reconciliation. */
export interface LineAllocation {
  readonly lineId: string;
  readonly amount: Amount;
}

export interface BenefitComputation {
  readonly benefitId: string;
  readonly type: string;
  readonly effect: string;
  /** The value granted. Never negative. */
  readonly value: Amount;
  /** How the value splits across cart lines, when the effect touches lines. */
  readonly allocations: readonly LineAllocation[];
  /** Non-monetary payload: the granted SKU, the new tier, the entitlement key. */
  readonly grant?: JsonObject;
  /** Explanation for the decision trace. */
  readonly detail: string;
  /** True when a cap reduced the computed value. */
  readonly capped?: boolean;
}

export interface BenefitInput {
  readonly spec: BenefitSpec;
  readonly context: ResolvedContext;
  readonly economic: EconomicAuthority;
  /** Lines this benefit may act on, after `target` filtering. */
  readonly lines: readonly CartLine[];
  /** Base the benefit computes against: the targeted subtotal. */
  readonly base: Amount;
  /** Unit resolved from spec.unit or the context. */
  readonly unit: string;
  readonly scale: number;
}

export interface BenefitType extends RegistryEntry {
  /** Parameter names the handler reads, for documentation and validation. */
  readonly params: readonly string[];
  /** Effects this type is allowed to produce. Empty means any. */
  readonly allowedEffects?: readonly string[];
  /**
   * Which unit the computed value comes out in.
   *
   *   "base"     - derived from the interaction: 10% of a USD basket is USD,
   *                and there is no meaningful sense in which it is points.
   *                Declaring a different `spec.unit` on such a benefit is an
   *                authoring error and the engine rejects it rather than
   *                silently ignoring the field.
   *   "declared" - the handler mints value in `spec.unit`: a points accrual, a
   *                flat grant, an item's declared cost.
   *
   * Conversions between units are never implicit. Crossing a unit boundary
   * needs an exchange rate, and a rate belongs in an audit record, not buried
   * inside a benefit calculation.
   */
  readonly unitPolicy: "base" | "declared";
  compute(input: BenefitInput): Result<BenefitComputation>;
}

export function benefitTypeRegistry(): Registry<BenefitType> {
  return new Registry<BenefitType>("benefit-type");
}

export function effectKindRegistry(): Registry<EffectKind> {
  return new Registry<EffectKind>("effect-kind").registerAll(DEFAULT_EFFECT_KINDS);
}
