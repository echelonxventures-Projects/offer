/**
 * Context Resolution Engine.
 *
 * Turns a thin request into a complete, frozen `ResolvedContext` by running an
 * ordered pipeline of resolvers. Resolvers are registry entries, so a tenant
 * adds "look up the device risk score" or "attach the loyalty tier" without the
 * engine knowing those concepts exist.
 *
 * Three stages, and the order matters:
 *   base    - structural facts: reality, instant, place, unit
 *   enrich  - external lookups: subject profile, risk score, inventory
 *   derive  - computed from what enrich produced: cart totals, segments
 *
 * Every resolver is recorded in the trace, including the ones that did nothing.
 * A decision you cannot explain is a decision you cannot defend.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/types.ts";
import type { Json } from "../kernel/types.ts";
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";
import type { EconomicAuthority } from "../universal/economic/authority.ts";
import type { TemporalAuthority } from "../universal/temporal/authority.ts";
import type { SpatialAuthority } from "../universal/spatial/authority.ts";
import type { Reality } from "../universal/reality/reality.ts";
import type { Telemetry } from "../observability/telemetry.ts";
import { noopTelemetry } from "../observability/telemetry.ts";
import { METRICS } from "../observability/metrics.ts";
import { add, zero } from "../universal/economic/amount.ts";
import type {
  CartFacet,
  ContextRequest,
  ContextTraceEntry,
  ResolvedContext,
  SubjectFacet,
} from "./context.ts";

export const RESOLVER_STAGES = ["base", "enrich", "derive"] as const;
export type ResolverStage = (typeof RESOLVER_STAGES)[number];

/** Mutable working copy assembled by the pipeline. */
export interface DraftContext {
  reality: string;
  tenant: string;
  correlationId: string;
  instant: ResolvedContext["instant"] | null;
  temporal: ResolvedContext["temporal"] | null;
  spatial: ResolvedContext["spatial"];
  economic: ResolvedContext["economic"] | null;
  subject: SubjectFacet;
  cart?: CartFacet;
  channel?: string;
  facets: Record<string, Json>;
}

export interface ContextDeps {
  readonly temporal: TemporalAuthority;
  readonly spatial: SpatialAuthority;
  readonly economic: EconomicAuthority;
  readonly realities: Registry<Reality>;
  readonly telemetry?: Telemetry;
}

export interface ResolverInput {
  readonly request: ContextRequest;
  readonly draft: DraftContext;
  readonly deps: ContextDeps;
  readonly reality: Reality;
}

export interface ContextResolver extends RegistryEntry {
  readonly stage: ResolverStage;
  /** Lower runs first within a stage. Ties break on key, for determinism. */
  readonly order?: number;
  /**
   * Mutate `draft`. Return a note for the trace, or null to record a skip.
   *
   * May be async: a resolver is where an external lookup belongs, precisely so
   * that rule evaluation can stay pure and bounded. The latency then shows up
   * in the context trace, where it can be measured, rather than hidden inside a
   * condition.
   */
  resolve(input: ResolverInput): Result<string | null> | Promise<Result<string | null>>;
}

export function contextResolverRegistry(): Registry<ContextResolver> {
  return new Registry<ContextResolver>("context-resolver");
}

/* ------------------------------------------------------------------ *
 * Built-in resolvers
 * ------------------------------------------------------------------ */

const temporalResolver: ContextResolver = {
  key: "core.temporal",
  label: "Temporal context",
  stage: "base",
  order: 10,
  resolve({ request, draft, deps, reality }) {
    const chronology = request.instant?.chronology ?? reality.defaultChronology;
    const instant = request.instant ? ok(request.instant) : deps.temporal.now(chronology);
    if (!instant.ok) return instant;

    const calendar = request.calendar ?? "gregorian";
    const zone = request.zone ?? "UTC";
    const fields = deps.temporal.fields(instant.value, calendar, zone);
    if (!fields.ok) return fields;

    draft.instant = instant.value;
    draft.temporal = { chronology: instant.value.chronology, calendar, zone, fields: fields.value };
    return ok(`instant=${instant.value.tick} calendar=${calendar} zone=${zone}`);
  },
};

const spatialResolver: ContextResolver = {
  key: "core.spatial",
  label: "Spatial context",
  stage: "base",
  order: 20,
  resolve({ request, draft, deps }) {
    if (!request.place) {
      draft.spatial = { path: [] };
      return ok(null);
    }
    const path = deps.spatial.path(request.place);
    if (!path.ok) return path;
    const jurisdiction = deps.spatial.jurisdictionOf(request.place);
    if (!jurisdiction.ok) return jurisdiction;

    draft.spatial = {
      place: request.place,
      path: path.value,
      ...(jurisdiction.value === undefined ? {} : { jurisdiction: jurisdiction.value }),
    };
    return ok(`place=${request.place} jurisdiction=${jurisdiction.value ?? "none"}`);
  },
};

const economicResolver: ContextResolver = {
  key: "core.economic",
  label: "Economic context",
  stage: "base",
  order: 30,
  resolve({ request, draft, deps }) {
    const unitKey = request.unit ?? request.cart?.lines[0]?.unitPrice.unit;
    if (!unitKey) {
      return fail(
        ErrorCode.INVALID_REQUEST,
        "context needs an economic unit: pass `unit`, or a cart with priced lines",
      );
    }
    const unit = deps.economic.units.require(unitKey);
    if (!unit.ok) return unit;
    draft.economic = { unit: unitKey, scale: unit.value.scale };
    return ok(`unit=${unitKey}`);
  },
};

const subjectResolver: ContextResolver = {
  key: "core.subject",
  label: "Subject context",
  stage: "enrich",
  order: 10,
  resolve({ request, draft }) {
    const supplied = request.subject ?? {};
    draft.subject = {
      ...(supplied.id === undefined ? {} : { id: supplied.id }),
      anonymous: supplied.anonymous ?? supplied.id === undefined,
      segments: supplied.segments ?? [],
      ...(supplied.tier === undefined ? {} : { tier: supplied.tier }),
      memberships: supplied.memberships ?? [],
      counters: supplied.counters ?? {},
      attributes: supplied.attributes ?? {},
    };
    return ok(draft.subject.anonymous ? "anonymous subject" : `subject=${draft.subject.id}`);
  },
};

const cartResolver: ContextResolver = {
  key: "core.cart",
  label: "Cart totals",
  stage: "derive",
  order: 10,
  resolve({ request, draft }) {
    if (!request.cart || !draft.economic) return ok(null);

    const { unit, scale } = draft.economic;
    let subtotal = zero(unit, scale);
    let itemCount = 0;

    for (const line of request.cart.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 0) {
        return fail(ErrorCode.INVALID_REQUEST, `cart line '${line.id}' has a non-integer quantity`, {
          line: line.id,
          quantity: line.quantity,
        });
      }
      const lineTotal = { ...line.unitPrice, minor: line.unitPrice.minor * BigInt(line.quantity) };
      const next = add(subtotal, lineTotal);
      if (!next.ok) return next;
      subtotal = next.value;
      itemCount += line.quantity;
    }

    draft.cart = {
      lines: request.cart.lines,
      subtotal,
      itemCount,
      lineCount: request.cart.lines.length,
    };
    return ok(`subtotal=${subtotal.minor} items=${itemCount}`);
  },
};

export const CORE_RESOLVERS: ContextResolver[] = [
  temporalResolver,
  spatialResolver,
  economicResolver,
  subjectResolver,
  cartResolver,
];

/* ------------------------------------------------------------------ */

export class ContextResolutionEngine {
  readonly resolvers: Registry<ContextResolver>;
  readonly #deps: ContextDeps;

  constructor(deps: ContextDeps, resolvers?: Registry<ContextResolver>) {
    this.#deps = deps;
    this.resolvers = resolvers ?? contextResolverRegistry().registerAll(CORE_RESOLVERS);
  }

  async resolve(request: ContextRequest): Promise<Result<ResolvedContext>> {
    const telemetry = this.#deps.telemetry ?? noopTelemetry;
    const stopTotal = telemetry.timer(METRICS.contextDuration, { tenant: request.tenant });

    const realityKey = request.reality ?? "production";
    const reality = this.#deps.realities.require(realityKey);
    if (!reality.ok) return reality;

    const draft: DraftContext = {
      reality: realityKey,
      tenant: request.tenant,
      correlationId: request.correlationId ?? "",
      instant: null,
      temporal: null,
      spatial: { path: [] },
      economic: null,
      subject: { anonymous: true, segments: [], memberships: [], counters: {}, attributes: {} },
      facets: { ...(request.facets ?? {}) },
      ...(request.channel === undefined ? {} : { channel: request.channel }),
    };

    const trace: ContextTraceEntry[] = [];

    for (const stage of RESOLVER_STAGES) {
      const staged = this.resolvers
        .list()
        .filter((r) => r.stage === stage)
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.key.localeCompare(b.key));

      for (const resolver of staged) {
        // Timed per resolver, not just in aggregate. A resolver making an
        // external call is the commonest cause of a latency regression here,
        // and a single total would hide which one.
        const stopResolver = telemetry.timer(METRICS.resolverDuration, { resolver: resolver.key });
        const outcome = await resolver.resolve({ request, draft, deps: this.#deps, reality: reality.value });
        stopResolver();
        if (!outcome.ok) {
          telemetry.count(METRICS.resolverOutcome, 1, { resolver: resolver.key, outcome: "failed" });
          trace.push({ resolver: resolver.key, outcome: "failed", note: outcome.error.message });
          return fail(outcome.error.code, `context resolver '${resolver.key}': ${outcome.error.message}`, {
            resolver: resolver.key,
            ...outcome.error.details,
            trace,
          });
        }
        telemetry.count(METRICS.resolverOutcome, 1, {
          resolver: resolver.key,
          outcome: outcome.value === null ? "skipped" : "applied",
        });
        trace.push({
          resolver: resolver.key,
          outcome: outcome.value === null ? "skipped" : "applied",
          ...(outcome.value === null ? {} : { note: outcome.value }),
        });
      }
    }

    if (!draft.instant || !draft.temporal || !draft.economic) {
      stopTotal();
      return fail(ErrorCode.INVALID_REQUEST, "context resolution finished without a complete structural core");
    }
    stopTotal();

    return ok(
      deepFreeze({
        reality: draft.reality,
        tenant: draft.tenant,
        correlationId: draft.correlationId,
        instant: draft.instant,
        temporal: draft.temporal,
        spatial: draft.spatial,
        economic: draft.economic,
        subject: draft.subject,
        ...(draft.cart === undefined ? {} : { cart: draft.cart }),
        ...(draft.channel === undefined ? {} : { channel: draft.channel }),
        facets: draft.facets,
        trace,
      }) as ResolvedContext,
    );
  }
}
