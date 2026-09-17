/**
 * Universal Context.
 *
 * The specification lists twenty-five kinds of context. Modelling twenty-five
 * fixed fields would be a lie: the twenty-sixth arrives next quarter. So the
 * context has a small *structural* core - the facts every engine genuinely
 * needs to do arithmetic and containment - plus an open `facets` map whose keys
 * are declared in the context-facet registry and whose contents are plain JSON.
 *
 * Structural core: reality, tenant, instant, place, unit, subject, cart.
 * Everything else (risk, device, inventory, campaign, AI, weather, whatever)
 * is a facet. Rules address both through the same dotted paths.
 *
 * A resolved context is deep-frozen. Two engines reading the same context must
 * see identical bytes, or the decision cannot be replayed.
 */
import type { Json, JsonObject } from "../kernel/types.ts";
import type { Amount } from "../universal/economic/amount.ts";
import type { Instant } from "../universal/temporal/chronology.ts";
import type { CalendarFields } from "../universal/temporal/calendar.ts";

export interface SubjectFacet {
  /** Absent for a genuinely anonymous visitor. */
  readonly id?: string;
  readonly anonymous: boolean;
  /** Segment keys the subject belongs to, resolved upstream or by a resolver. */
  readonly segments: readonly string[];
  /** Loyalty or membership tier key, if any. */
  readonly tier?: string;
  /** Membership/programme keys the subject holds. */
  readonly memberships: readonly string[];
  /** Counters the eligibility engine needs: prior redemptions, lifetime value. */
  readonly counters: Readonly<Record<string, number>>;
  /** Open attributes; anything the tenant knows about the subject. */
  readonly attributes: JsonObject;
}

export interface CartLine {
  readonly id: string;
  /** Product identifier in the tenant's catalogue. */
  readonly sku: string;
  readonly quantity: number;
  /** Price of one unit, before any incentive. */
  readonly unitPrice: Amount;
  /** Category keys, used by product-scoped offers. */
  readonly categories: readonly string[];
  /** Brand, merchant or supplier key for funding attribution. */
  readonly merchant?: string;
  readonly attributes?: JsonObject;
}

export interface CartFacet {
  readonly lines: readonly CartLine[];
  /** Sum of line totals before incentives. Computed by the resolver. */
  readonly subtotal: Amount;
  /** Sum of quantities. Computed by the resolver. */
  readonly itemCount: number;
  /** Distinct SKU count. Computed by the resolver. */
  readonly lineCount: number;
}

export interface TemporalFacet {
  readonly chronology: string;
  readonly calendar: string;
  readonly zone: string;
  /** Named calendar fields for `instant`, e.g. `{year, month, dayOfWeek}`. */
  readonly fields: CalendarFields;
}

export interface SpatialFacet {
  /** Spatial node key the interaction happens at, if known. */
  readonly place?: string;
  /** Root-to-leaf ancestry of `place`. Containment checks read this. */
  readonly path: readonly string[];
  readonly jurisdiction?: string;
}

export interface EconomicFacet {
  /** Unit prices and benefits are presented in. */
  readonly unit: string;
  readonly scale: number;
}

/** One step of how the context was built, for the decision trace. */
export interface ContextTraceEntry {
  readonly resolver: string;
  readonly outcome: "applied" | "skipped" | "failed";
  readonly note?: string;
}

export interface ResolvedContext {
  readonly reality: string;
  readonly tenant: string;
  readonly correlationId: string;
  readonly instant: Instant;
  readonly temporal: TemporalFacet;
  readonly spatial: SpatialFacet;
  readonly economic: EconomicFacet;
  readonly subject: SubjectFacet;
  readonly cart?: CartFacet;
  /** Distribution/experience surface: "web", "pos", "partner-feed", "agent". */
  readonly channel?: string;
  /** Registry-declared open facets: risk, device, inventory, campaign, ... */
  readonly facets: Readonly<Record<string, Json>>;
  readonly trace: readonly ContextTraceEntry[];
}

/** What a caller supplies. Everything optional except tenant and reality. */
export interface ContextRequest {
  readonly tenant: string;
  readonly reality?: string;
  readonly correlationId?: string;
  /** Override "now"; required for replay and back-testing. */
  readonly instant?: Instant;
  readonly calendar?: string;
  readonly zone?: string;
  readonly place?: string;
  readonly unit?: string;
  readonly channel?: string;
  readonly subject?: Partial<SubjectFacet>;
  readonly cart?: { readonly lines: readonly CartLine[] };
  readonly facets?: Readonly<Record<string, Json>>;
}

/**
 * Read a dotted path out of a context. This is the one accessor rules use, so
 * `cart.subtotal`, `subject.counters.redemptions` and `facets.risk.score` are
 * all the same kind of lookup and none of them can throw.
 */
export function readPath(root: unknown, path: string): unknown {
  if (path === "") return root;
  let cursor: unknown = root;
  for (const segment of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
      continue;
    }
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Duck-typed Amount check. Rules need to know when to use money comparison. */
export function isAmount(value: unknown): value is Amount {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Amount).unit === "string" &&
    typeof (value as Amount).minor === "bigint" &&
    typeof (value as Amount).scale === "number"
  );
}
