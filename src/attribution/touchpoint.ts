/**
 * Touchpoint shape.
 *
 * Split out of `attribution.ts` so the storage port can reference it without
 * importing the engine, which would make the dependency graph circular.
 */
import type { JsonObject } from "../kernel/types.ts";
import type { PartyRef } from "../model/funding.ts";

export const TOUCHPOINT_KINDS = ["view", "click", "share", "referral", "assist", "conversion"] as const;
export type TouchpointKind = (typeof TOUCHPOINT_KINDS)[number];

export interface Touchpoint {
  readonly id: string;
  readonly tenant: string;
  readonly subjectId?: string;
  /** Anonymous device or session key, for pre-identification touches. */
  readonly deviceId?: string;
  readonly valueExchangeId?: string;
  readonly kind: TouchpointKind;
  /** Who is claiming credit. */
  readonly party: PartyRef;
  readonly channel?: string;
  /** Instant tick, as a string, in the context chronology. */
  readonly at: string;
  readonly metadata?: JsonObject;
}
