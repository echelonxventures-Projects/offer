/**
 * The Value Exchange.
 *
 * This is the whole data model. A coupon is one of these. So is a cashback
 * programme, a government fuel subsidy, an affiliate commission plan, an
 * employee benefit, a loyalty accrual rule, a creator payout and a tier
 * upgrade. They differ in their `profile`, their conditions, their benefits and
 * who funds them - never in their shape.
 *
 * The test of this claim is `src/profiles`: every profile in there is a
 * function that returns one of these records, with no branch anywhere in the
 * engines keyed on which profile it was.
 */
import type { JsonObject } from "../kernel/types.ts";
import type { RuleNode } from "../rules/ast.ts";
import type { TemporalWindow } from "../universal/temporal/window.ts";
import type { SpatialScope } from "../universal/spatial/authority.ts";
import type { BenefitSpec } from "./benefit.ts";
import type { FundingSpec } from "./funding.ts";
import type { LimitSpec } from "./limits.ts";
import type { LifecycleState } from "./lifecycle.ts";

/** How a subject comes to hold this exchange. */
export interface AcquisitionSpec {
  /**
   * automatic - applies whenever conditions hold, no action needed
   * code      - the subject presents a code
   * issued    - granted to a named subject in advance
   * earned    - unlocked by meeting a condition (a loyalty threshold)
   * referred  - obtained through another subject's referral link
   */
  readonly mode: "automatic" | "code" | "issued" | "earned" | "referred";
  /** For `code`: the literal code, or a pattern for bulk generation. */
  readonly code?: string;
  /** For `code`: whether one code serves everyone or each subject gets one. */
  readonly codeSharing?: "shared" | "unique";
  /** Must the subject activate it before it can be redeemed? */
  readonly requiresActivation?: boolean;
}

/** How this exchange behaves next to others. */
export interface StackingSpec {
  /** When true, nothing else may apply in the same decision. */
  readonly exclusive?: boolean;
  /** Group keys. Exchanges in the same group compete; the best one wins. */
  readonly groups?: readonly string[];
  /** Keys of exchanges this one refuses to combine with. */
  readonly excludes?: readonly string[];
  /** Keys of exchanges this one will combine with even across groups. */
  readonly combinesWith?: readonly string[];
  /**
   * Whether this benefit computes against the original base or the base left
   * after earlier benefits. Sequential is the honest default for discounts;
   * parallel is right for cashback that should not shrink as discounts stack.
   */
  readonly application?: "sequential" | "parallel";
}

export interface AttributionSpec {
  /** Key into the attribution-model registry. */
  readonly model: string;
  /** Lookback for click and view attribution, in frame seconds. */
  readonly lookbackSeconds?: number;
  /** Parties who may be credited: affiliate, creator, partner, channel. */
  readonly creditable?: readonly string[];
}

export interface GovernanceSpec {
  /** Policy keys that must pass before this may go live. */
  readonly policies?: readonly string[];
  /** Approvals recorded against this exchange. */
  readonly approvals?: readonly { readonly by: string; readonly at: string; readonly note?: string }[];
  /** Compliance regimes this exchange claims to satisfy. */
  readonly compliance?: readonly string[];
  /** Human owner accountable for it. */
  readonly owner?: string;
}

export interface ValueExchangeScope {
  readonly spatial?: SpatialScope;
  /** Distribution or experience channels this applies on. Empty means all. */
  readonly channels?: readonly string[];
  /** Merchants whose lines this applies to. Empty means all. */
  readonly merchants?: readonly string[];
  /** Realities this exchange exists in. Defaults to the one it was created in. */
  readonly realities?: readonly string[];
}

export interface ValueExchange {
  readonly id: string;
  readonly tenant: string;
  /**
   * Key into the domain-profile registry: "coupon", "cashback", "subsidy",
   * "affiliate_commission", and so on. Used for presentation, reporting and
   * governance policy selection - never for control flow in an engine.
   */
  readonly profile: string;
  readonly name: string;
  readonly description?: string;
  /** Monotonic; every published change mints a new version. */
  readonly version: number;
  readonly state: LifecycleState;

  /** Who may see it in discovery. */
  readonly visibility: "public" | "targeted" | "private";
  readonly acquisition: AcquisitionSpec;

  /** When it is live. */
  readonly window?: TemporalWindow;
  readonly scope: ValueExchangeScope;

  /** Everything that must hold for it to apply. */
  readonly conditions?: RuleNode;

  /** What the subject gets. Multiple benefits apply together. */
  readonly benefits: readonly BenefitSpec[];

  readonly funding: FundingSpec;
  readonly limits: LimitSpec;
  readonly stacking: StackingSpec;

  /**
   * Ranking weight when several exchanges compete. Higher wins ties; the
   * optimiser prefers subject value first and uses this only to break them.
   */
  readonly priority: number;

  readonly attribution?: AttributionSpec;
  readonly governance: GovernanceSpec;

  /** Free-form tenant data: campaign ids, creative assets, external keys. */
  readonly metadata: JsonObject;

  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
}

/** A value exchange held by a specific subject: an issued code, a grant. */
export interface Grant {
  readonly id: string;
  readonly tenant: string;
  readonly valueExchangeId: string;
  readonly valueExchangeVersion: number;
  readonly subjectId?: string;
  /** The code presented at redemption, when acquisition is by code. */
  readonly code?: string;
  readonly state: "issued" | "activated" | "reserved" | "redeemed" | "expired" | "revoked";
  readonly issuedAt: string;
  readonly activatedAt?: string;
  readonly redeemedAt?: string;
  readonly expiresAt?: string;
  /** Redemptions consumed, for multi-use grants. */
  readonly uses: number;
  readonly maxUses: number;
  readonly metadata: JsonObject;
}

/** Everything a profile must supply; the rest of the record is defaulted. */
export interface ValueExchangeDraft {
  readonly profile: string;
  readonly name: string;
  readonly description?: string;
  readonly visibility?: ValueExchange["visibility"];
  readonly acquisition?: AcquisitionSpec;
  readonly window?: TemporalWindow;
  readonly scope?: ValueExchangeScope;
  readonly conditions?: RuleNode;
  readonly benefits: readonly BenefitSpec[];
  readonly funding: FundingSpec;
  readonly limits?: LimitSpec;
  readonly stacking?: StackingSpec;
  readonly priority?: number;
  readonly attribution?: AttributionSpec;
  readonly governance?: GovernanceSpec;
  readonly metadata?: JsonObject;
}

/** Domain profiles: presentation and policy metadata for a family of exchanges. */
export interface DomainProfile {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /** The specification's domain numbers this profile covers, for traceability. */
  readonly specDomains?: readonly number[];
  /** Default benefit effect for this family. */
  readonly defaultEffect?: string;
  /** Policies governance applies to every exchange with this profile. */
  readonly requiredPolicies?: readonly string[];
}
