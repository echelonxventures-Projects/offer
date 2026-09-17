/**
 * Profile builders.
 *
 * Each of these returns a `ValueExchangeDraft` - the same shape, every time.
 * Read them side by side: the differences between a coupon, a cashback scheme,
 * a government subsidy and an affiliate commission are entirely in the data.
 * That is the claim the whole architecture rests on, so it is worth having the
 * evidence in one short file.
 */
import type { JsonObject } from "../kernel/types.ts";
import type { RuleNode } from "../rules/ast.ts";
import type { TemporalWindow } from "../universal/temporal/window.ts";
import type { ValueExchangeDraft } from "../model/value-exchange.ts";
import type { BenefitSpec } from "../model/benefit.ts";
import type { FundingSpec } from "../model/funding.ts";
import type { LimitSpec } from "../model/limits.ts";
import type { SpatialScope } from "../universal/spatial/authority.ts";

interface CommonParams {
  readonly name: string;
  readonly description?: string;
  readonly funding: FundingSpec;
  readonly conditions?: RuleNode;
  readonly window?: TemporalWindow;
  readonly spatial?: SpatialScope;
  readonly channels?: readonly string[];
  readonly limits?: LimitSpec;
  readonly priority?: number;
  readonly owner?: string;
  readonly metadata?: JsonObject;
  readonly stackingGroups?: readonly string[];
  readonly exclusive?: boolean;
}

function common(params: CommonParams): Omit<ValueExchangeDraft, "profile" | "benefits"> {
  return {
    name: params.name,
    ...(params.description === undefined ? {} : { description: params.description }),
    ...(params.conditions === undefined ? {} : { conditions: params.conditions }),
    ...(params.window === undefined ? {} : { window: params.window }),
    scope: {
      ...(params.spatial === undefined ? {} : { spatial: params.spatial }),
      ...(params.channels === undefined ? {} : { channels: params.channels }),
    },
    funding: params.funding,
    limits: params.limits ?? {},
    stacking: {
      ...(params.stackingGroups === undefined ? {} : { groups: params.stackingGroups }),
      ...(params.exclusive === undefined ? {} : { exclusive: params.exclusive }),
      application: "sequential",
    },
    priority: params.priority ?? 0,
    governance: params.owner === undefined ? {} : { owner: params.owner },
    metadata: params.metadata ?? {},
  };
}

/** A code-acquired discount. The archetype everyone recognises. */
export function coupon(
  params: CommonParams & {
    code: string;
    percentOff?: string;
    amountOff?: string;
    unit?: string;
    cap?: string;
    perSubject?: number;
  },
): ValueExchangeDraft {
  const benefit: BenefitSpec = params.percentOff
    ? {
        id: "discount",
        type: "percentage",
        params: { rate: params.percentOff },
        effect: "price_reduction",
        ...(params.cap === undefined ? {} : { cap: { decimal: params.cap } }),
      }
    : {
        id: "discount",
        type: "flat",
        params: { amount: params.amountOff ?? "0" },
        effect: "price_reduction",
      };

  return {
    ...common(params),
    profile: "coupon",
    visibility: "public",
    acquisition: { mode: "code", code: params.code, codeSharing: "shared" },
    benefits: [benefit],
    limits: { ...(params.limits ?? {}), ...(params.perSubject === undefined ? {} : { perSubject: params.perSubject }) },
  };
}

/** Deferred value returned to the subject. Identical maths, different effect. */
export function cashback(
  params: CommonParams & {
    percent: string;
    cap?: string;
    unit?: string;
    maturityDays?: number;
    /** Parallel keeps the cashback from shrinking when a discount also applies. */
    parallel?: boolean;
  },
): ValueExchangeDraft {
  const draft = common(params);
  return {
    ...draft,
    profile: "cashback",
    visibility: "public",
    acquisition: { mode: "automatic" },
    benefits: [
      {
        id: "cashback",
        type: "percentage",
        params: { rate: params.percent },
        effect: "deferred_credit",
        ...(params.unit === undefined ? {} : { unit: params.unit }),
        ...(params.cap === undefined ? {} : { cap: { decimal: params.cap } }),
        ...(params.maturityDays === undefined ? {} : { maturitySeconds: params.maturityDays * 86_400 }),
      },
    ],
    stacking: { ...draft.stacking, application: params.parallel === false ? "sequential" : "parallel" },
  };
}

/** Points accrual. The unit is programme currency, not money. */
export function loyaltyAccrual(
  params: CommonParams & { points: number; per: number; unit?: string },
): ValueExchangeDraft {
  const draft = common(params);
  return {
    ...draft,
    profile: "loyalty",
    visibility: "public",
    acquisition: { mode: "automatic" },
    benefits: [
      {
        id: "accrual",
        type: "points_accrual",
        params: { points: params.points, per: params.per },
        effect: "points_grant",
        unit: params.unit ?? "POINTS",
      },
    ],
    // Points should not shrink because a discount ran first.
    stacking: { ...draft.stacking, application: "parallel" },
  };
}

/** Publicly funded, jurisdiction-scoped, issued to named subjects. */
export function governmentBenefit(
  params: CommonParams & {
    percentOff?: string;
    amountOff?: string;
    jurisdictions?: readonly string[];
    perSubjectPerMonth?: number;
  },
): ValueExchangeDraft {
  const conditions: RuleNode | undefined = params.jurisdictions?.length
    ? params.conditions
      ? { op: "all", of: [params.conditions, { op: "spatial.jurisdiction", in: params.jurisdictions }] }
      : { op: "spatial.jurisdiction", in: params.jurisdictions }
    : params.conditions;

  return {
    ...common(params),
    ...(conditions === undefined ? {} : { conditions }),
    profile: "government_benefit",
    visibility: "targeted",
    acquisition: { mode: "issued", requiresActivation: false },
    benefits: [
      params.percentOff
        ? { id: "subsidy", type: "percentage", params: { rate: params.percentOff }, effect: "price_reduction" }
        : { id: "subsidy", type: "flat", params: { amount: params.amountOff ?? "0" }, effect: "price_reduction" },
    ],
    limits: {
      ...(params.limits ?? {}),
      ...(params.perSubjectPerMonth === undefined
        ? {}
        : { perSubjectPerPeriod: { max: params.perSubjectPerMonth, windowSeconds: 30 * 86_400 } }),
    },
  };
}

/** Value owed to a third party, never to the buyer. */
export function affiliateCommission(
  params: CommonParams & {
    percent: string;
    unit?: string;
    attributionModel?: string;
    lookbackDays?: number;
  },
): ValueExchangeDraft {
  const draft = common(params);
  return {
    ...draft,
    profile: "affiliate_commission",
    visibility: "private",
    acquisition: { mode: "automatic" },
    benefits: [
      {
        id: "commission",
        type: "percentage",
        params: { rate: params.percent },
        effect: "commission",
        ...(params.unit === undefined ? {} : { unit: params.unit }),
      },
    ],
    attribution: {
      model: params.attributionModel ?? "last_touch",
      ...(params.lookbackDays === undefined ? {} : { lookbackSeconds: params.lookbackDays * 86_400 }),
      creditable: ["affiliate", "creator", "partner"],
    },
    // A commission is not a discount and must never compete with one.
    stacking: { ...draft.stacking, application: "parallel" },
  };
}

/** Pre-funded value the subject holds and spends down. */
export function giftCard(
  params: CommonParams & { faceValue: string; unit?: string; code: string },
): ValueExchangeDraft {
  return {
    ...common(params),
    profile: "stored_value",
    visibility: "private",
    acquisition: { mode: "code", code: params.code, codeSharing: "unique" },
    benefits: [
      {
        id: "face_value",
        type: "flat",
        params: { amount: params.faceValue },
        effect: "wallet_credit",
        ...(params.unit === undefined ? {} : { unit: params.unit }),
      },
    ],
  };
}

/** An entitlement that follows from who the subject is. */
export function membershipBenefit(
  params: CommonParams & { memberships: readonly string[]; percentOff: string; cap?: string },
): ValueExchangeDraft {
  const membershipRule: RuleNode = { op: "subject.hasMembership", memberships: params.memberships };
  const conditions: RuleNode = params.conditions
    ? { op: "all", of: [params.conditions, membershipRule] }
    : membershipRule;

  return {
    ...common(params),
    conditions,
    profile: "membership_benefit",
    visibility: "targeted",
    acquisition: { mode: "automatic" },
    benefits: [
      {
        id: "member_discount",
        type: "percentage",
        params: { rate: params.percentOff },
        effect: "price_reduction",
        ...(params.cap === undefined ? {} : { cap: { decimal: params.cap } }),
      },
    ],
  };
}
