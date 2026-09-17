/**
 * Lifecycle.
 *
 * One state machine for every value exchange, whatever it is called in the
 * business. A coupon, a government subsidy and an affiliate commission plan all
 * move through the same states, because the questions are the same: has a human
 * approved it, is it live, has it run out, can it still be honoured.
 *
 * Transitions are data so that governance can require approval on some edges
 * for some tenants without a code change.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";

export const LIFECYCLE_STATES = [
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "active",
  "paused",
  "exhausted",
  "expired",
  "archived",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export interface LifecycleTransition extends RegistryEntry {
  readonly from: LifecycleState;
  readonly to: LifecycleState;
  /** Requires an approval record from the governance engine. */
  readonly requiresApproval?: boolean;
  /** The platform performs it automatically; no operator action. */
  readonly automatic?: boolean;
}

const t = (
  from: LifecycleState,
  to: LifecycleState,
  extra: Partial<LifecycleTransition> = {},
): LifecycleTransition => ({
  key: `${from}->${to}`,
  label: `${from} to ${to}`,
  from,
  to,
  ...extra,
});

export const DEFAULT_TRANSITIONS: LifecycleTransition[] = [
  t("draft", "in_review"),
  t("draft", "archived"),
  t("in_review", "draft"),
  t("in_review", "approved", { requiresApproval: true }),
  t("approved", "scheduled"),
  t("approved", "active"),
  t("approved", "draft"),
  t("scheduled", "active", { automatic: true }),
  t("scheduled", "archived"),
  t("active", "paused"),
  t("active", "exhausted", { automatic: true }),
  t("active", "expired", { automatic: true }),
  t("paused", "active"),
  t("paused", "archived"),
  t("exhausted", "active", { requiresApproval: true }),
  t("exhausted", "archived"),
  t("expired", "archived"),
];

export function lifecycleRegistry(): Registry<LifecycleTransition> {
  return new Registry<LifecycleTransition>("lifecycle-transition").registerAll(DEFAULT_TRANSITIONS);
}

/** States in which a value exchange may be evaluated for a live decision. */
export const REDEEMABLE_STATES: readonly LifecycleState[] = ["active"];

export function canTransition(
  registry: Registry<LifecycleTransition>,
  from: LifecycleState,
  to: LifecycleState,
): Result<LifecycleTransition> {
  const transition = registry.get(`${from}->${to}`);
  if (!transition) {
    return fail(ErrorCode.ILLEGAL_STATE, `cannot move from '${from}' to '${to}'`, {
      from,
      to,
      allowed: registry
        .list()
        .filter((x) => x.from === from)
        .map((x) => x.to),
    });
  }
  return ok(transition);
}
