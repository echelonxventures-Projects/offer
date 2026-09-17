/**
 * Value exchange construction.
 *
 * Profiles produce drafts; this turns a draft into a complete record with
 * defaults filled in. Keeping the defaults in one place is what makes it
 * possible to say "every exchange has a stacking spec" without every profile
 * having to remember one.
 */
import type { IdFactory } from "../kernel/ids.ts";
import type { ValueExchange, ValueExchangeDraft } from "../model/value-exchange.ts";

export interface CreateParams {
  readonly tenant: string;
  readonly draft: ValueExchangeDraft;
  readonly actor: string;
  readonly at: string;
  readonly ids: IdFactory;
  /** Explicit id, for deterministic seeding and for clones. */
  readonly id?: string;
}

export function createValueExchange(params: CreateParams): ValueExchange {
  const { tenant, draft, actor, at, ids } = params;
  return {
    id: params.id ?? ids.next("vx"),
    tenant,
    profile: draft.profile,
    name: draft.name,
    ...(draft.description === undefined ? {} : { description: draft.description }),
    version: 1,
    state: "draft",
    visibility: draft.visibility ?? "public",
    acquisition: draft.acquisition ?? { mode: "automatic" },
    ...(draft.window === undefined ? {} : { window: draft.window }),
    scope: draft.scope ?? {},
    ...(draft.conditions === undefined ? {} : { conditions: draft.conditions }),
    benefits: draft.benefits,
    funding: draft.funding,
    limits: draft.limits ?? {},
    // Sequential is the safe default: a second discount computing against the
    // original price is how a 30% and a 20% offer quietly become 50%.
    stacking: draft.stacking ?? { application: "sequential" },
    priority: draft.priority ?? 0,
    ...(draft.attribution === undefined ? {} : { attribution: draft.attribution }),
    governance: draft.governance ?? {},
    metadata: draft.metadata ?? {},
    createdAt: at,
    updatedAt: at,
    createdBy: actor,
  };
}

/** A clone is a fresh draft-state copy; nothing about its history carries over. */
export function cloneValueExchange(
  source: ValueExchange,
  params: { ids: IdFactory; actor: string; at: string; name?: string },
): ValueExchange {
  return {
    ...source,
    id: params.ids.next("vx"),
    name: params.name ?? `${source.name} (copy)`,
    version: 1,
    state: "draft",
    governance: { ...source.governance, approvals: [] },
    createdAt: params.at,
    updatedAt: params.at,
    createdBy: params.actor,
  };
}
