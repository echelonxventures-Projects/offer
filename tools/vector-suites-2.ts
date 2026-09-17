/**
 * Conformance vectors, L3 and L4: decisioning and distribution.
 *
 * Normative amount shape. Anywhere an amount appears in a vector - including
 * nested inside a context - it is exactly:
 *
 *     { "unit": "<string>", "minor": "<decimal integer string>", "scale": <int> }
 *
 * `minor` is a string so it is exact in every language. An implementation
 * hydrates these into its own integer type before evaluating, and renders them
 * back the same way. No other shape has all three of those keys.
 */
import type { VectorCase, VectorSuite } from "./vector-suites.ts";
import { wire, unwrap } from "./vector-suites.ts";
import { SpatialAuthority } from "../src/universal/spatial/authority.ts";
import { DEFAULT_SPATIAL_NODES } from "../src/universal/spatial/node.ts";
import { TemporalAuthority, fixedClock } from "../src/universal/temporal/authority.ts";
import { instant } from "../src/universal/temporal/chronology.ts";
import { RuleEvaluator } from "../src/rules/evaluator.ts";
import { ruleOperatorRegistry } from "../src/rules/operators.ts";
import { ruleFunctionRegistry } from "../src/rules/functions.ts";
import { EconomicAuthority } from "../src/universal/economic/authority.ts";
import { fromDecimal } from "../src/universal/economic/amount.ts";
import type { Amount } from "../src/universal/economic/amount.ts";
import type { RuleNode } from "../src/rules/ast.ts";
import type { ResolvedContext } from "../src/context/context.ts";
import { findBreach } from "../src/adapters/limit-rules.ts";
import type { CounterSnapshot } from "../src/adapters/store.ts";
import type { LimitSpec } from "../src/model/limits.ts";
import { DEFAULT_BENEFIT_TYPES } from "../src/model/benefit-types.ts";
import type { BenefitSpec } from "../src/model/benefit.ts";
import type { CartLine } from "../src/context/context.ts";
import { AttributionEngine, attributionModelRegistry } from "../src/attribution/attribution.ts";
import type { Touchpoint } from "../src/attribution/touchpoint.ts";
import { MemoryPlatformStore } from "../src/adapters/memory-store.ts";

const usd = (decimal: string): Amount => fromDecimal("USD", decimal, 2);

/** The one context every rule vector runs against, in wire form. */
const RULE_CONTEXT = {
  reality: "production",
  tenant: "t",
  correlationId: "c-1",
  instant: { chronology: "earth.unix.ms", tick: "1789813800000" },
  temporal: {
    chronology: "earth.unix.ms",
    calendar: "gregorian",
    zone: "UTC",
    fields: { year: 2026, month: 9, day: 19, hour: 10, minute: 30, second: 0, dayOfWeek: 6, dayOfYear: 262, quarter: 3 },
  },
  spatial: { place: "earth.in.br.patna", path: ["sol", "earth", "earth.in", "earth.in.br", "earth.in.br.patna"], jurisdiction: "IN-BR" },
  economic: { unit: "USD", scale: 2 },
  subject: {
    id: "s1",
    anonymous: false,
    segments: ["member", "new-customer"],
    tier: "gold",
    memberships: ["club"],
    counters: { "redemptions.total": 1, "orders.lifetime": 5 },
    attributes: { jurisdiction: "IN-BR" },
  },
  cart: {
    lines: [
      { id: "l1", sku: "TEA-500", quantity: 2, unitPrice: wire(usd("30.00")), categories: ["grocery", "beverage"], merchant: "m1" },
      { id: "l2", sku: "MUG-CERAMIC", quantity: 1, unitPrice: wire(usd("40.00")), categories: ["homeware"], merchant: "m2" },
    ],
    subtotal: wire(usd("100.00")),
    itemCount: 3,
    lineCount: 2,
  },
  channel: "web",
  facets: { risk: { score: 12 }, flags: ["a", "b"] },
  trace: [],
};

/** Hydrate wire amounts into native ones, for the reference evaluator. */
function hydrate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrate);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 3 && keys.includes("unit") && keys.includes("minor") && keys.includes("scale")) {
      return { unit: record.unit, minor: BigInt(String(record.minor)), scale: record.scale };
    }
    if (keys.length === 2 && keys.includes("chronology") && keys.includes("tick")) {
      return { chronology: record.chronology, tick: BigInt(String(record.tick)) };
    }
    return Object.fromEntries(keys.map((k) => [k, hydrate(record[k])]));
  }
  return value;
}

function rulesSuite(): VectorSuite {
  const economic = new EconomicAuthority();
  const temporal = new TemporalAuthority({ clock: fixedClock(0n) });
  const spatial = new SpatialAuthority();
  const evaluator = new RuleEvaluator({
    temporal,
    spatial,
    economic,
    operators: ruleOperatorRegistry(),
    functions: ruleFunctionRegistry(),
  });
  const context = hydrate(RULE_CONTEXT) as ResolvedContext;

  const rules: [string, RuleNode, string?][] = [
    ["always", { op: "always" }],
    ["never", { op: "never" }],
    ["not", { op: "not", of: { op: "never" } }],
    ["all-true", { op: "all", of: [{ op: "always" }, { op: "always" }] }],
    ["all-short-circuits", { op: "all", of: [{ op: "always" }, { op: "never" }, { op: "always" }] }, "the third child MUST NOT be evaluated"],
    ["any-short-circuits", { op: "any", of: [{ op: "never" }, { op: "always" }, { op: "never" }] }],
    ["none", { op: "none", of: [{ op: "never" }, { op: "never" }] }],
    ["gte-money-true", { op: "gte", left: { path: "cart.subtotal" }, right: { amount: { unit: "USD", decimal: "100.00" } } }],
    ["gt-money-false", { op: "gt", left: { path: "cart.subtotal" }, right: { amount: { unit: "USD", decimal: "100.00" } } }],
    ["lt-money", { op: "lt", left: { path: "cart.subtotal" }, right: { amount: { unit: "USD", decimal: "200.00" } } }],
    ["eq-string", { op: "eq", left: { path: "subject.tier" }, right: { literal: "gold" } }],
    ["ne-string", { op: "ne", left: { path: "subject.tier" }, right: { literal: "silver" } }],
    ["between", { op: "between", value: { path: "cart.itemCount" }, low: { literal: 2 }, high: { literal: 5 } }],
    ["exists-true", { op: "exists", value: { path: "subject.id" } }],
    ["exists-false", { op: "exists", value: { path: "subject.nope" } }],
    ["path-default", { op: "eq", left: { path: "subject.nope", default: 7 }, right: { literal: 7 } }],
    ["in", { op: "in", value: { path: "subject.tier" }, options: { literal: ["gold", "platinum"] } }],
    ["notIn", { op: "notIn", value: { path: "subject.tier" }, options: { literal: ["bronze"] } }],
    ["includesAny", { op: "includesAny", collection: { path: "subject.segments" }, values: { literal: ["vip", "member"] } }],
    ["includesAll-false", { op: "includesAll", collection: { path: "subject.segments" }, values: { literal: ["member", "vip"] } }],
    ["sizeOf", { op: "sizeOf", collection: { path: "cart.lines" }, gte: { literal: 2 }, lte: { literal: 3 } }],
    ["glob-true", { op: "glob", value: { path: "cart.lines.0.sku" }, pattern: { literal: "TEA-*" } }],
    ["glob-false", { op: "glob", value: { path: "cart.lines.0.sku" }, pattern: { literal: "COFFEE-*" } }],
    ["temporal-field-in", { op: "temporal.field", field: "dayOfWeek", in: [6, 7] }],
    ["temporal-field-miss", { op: "temporal.field", field: "dayOfWeek", in: [1] }],
    ["temporal-field-absent", { op: "temporal.field", field: "sol", in: [1] }, "a field the calendar does not publish is false, not an error"],
    ["temporal-field-range", { op: "temporal.field", field: "hour", min: 9, max: 17 }],
    ["subject-segment-any", { op: "subject.hasSegment", segments: ["vip", "member"] }],
    ["subject-segment-all", { op: "subject.hasSegment", segments: ["vip", "member"], mode: "all" }],
    ["subject-membership", { op: "subject.hasMembership", memberships: ["club"] }],
    ["spatial-within", { op: "spatial.within", nodes: ["earth.in"] }],
    ["spatial-within-excluded", { op: "spatial.within", nodes: ["earth"], exclude: ["earth.in.br"] }],
    ["spatial-jurisdiction", { op: "spatial.jurisdiction", in: ["IN-BR", "IN-MH"] }],
    ["fn-quantity-in", { op: "eq", left: { fn: "cart.quantityIn", args: [{ literal: ["grocery"] }] }, right: { literal: 2 } }],
    ["fn-subtotal-of", { op: "eq", left: { fn: "cart.subtotalOf", args: [{ literal: ["homeware"] }] }, right: { amount: { unit: "USD", decimal: "40.00" } } }],
    ["fn-has-sku", { op: "eq", left: { fn: "cart.hasSku", args: [{ literal: ["MUG-*"] }] }, right: { literal: true } }],
    ["fn-merchants", { op: "includesAll", collection: { fn: "cart.merchants" }, values: { literal: ["m1", "m2"] } }],
    ["fn-counter", { op: "lt", left: { fn: "subject.counter", args: [{ literal: "redemptions.total" }] }, right: { literal: 3 } }],
    ["fn-counter-missing", { op: "eq", left: { fn: "subject.counter", args: [{ literal: "never.seen" }] }, right: { literal: 0 } }],
    ["fn-facet", { op: "eq", left: { fn: "facet", args: [{ literal: "risk" }, { literal: null }] }, right: { literal: { score: 12 } } }],
    ["fn-facet-default", { op: "eq", left: { fn: "facet", args: [{ literal: "absent" }, { literal: 99 }] }, right: { literal: 99 } }],
    [
      "realistic-composite",
      {
        op: "all",
        of: [
          { op: "gte", left: { path: "cart.subtotal" }, right: { amount: { unit: "USD", decimal: "50.00" } } },
          { op: "spatial.within", nodes: ["earth.in"] },
          { op: "temporal.field", field: "dayOfWeek", in: [6, 7] },
          { op: "subject.hasSegment", segments: ["new-customer"] },
          { op: "lt", left: { fn: "subject.counter", args: [{ literal: "redemptions.total" }] }, right: { literal: 3 } },
        ],
      },
    ],
  ];

  const cases: VectorCase[] = rules.map(([id, rule, note]) => {
    const outcome = unwrap(evaluator.evaluate(rule, context));
    return {
      id,
      ...(note === undefined ? {} : { note }),
      input: { rule },
      expect: {
        satisfied: outcome.satisfied,
        trace: outcome.trace.map((t) => ({ op: t.op, result: t.result, depth: t.depth })),
      },
    };
  });

  const errors: [string, RuleNode, string][] = [
    ["error:incomparable", { op: "gt", left: { path: "subject.id" }, right: { amount: { unit: "USD", decimal: "1.00" } } }, "RULE_ERROR"],
    ["error:unknown-op", { op: "acme.nope" }, "UNKNOWN_REGISTRY_ENTRY"],
    ["error:unknown-fn", { op: "eq", left: { fn: "acme.nope" }, right: { literal: 1 } }, "UNKNOWN_REGISTRY_ENTRY"],
    ["error:bad-arity", { op: "eq", left: { fn: "subject.counter" }, right: { literal: 0 } }, "RULE_ERROR"],
  ];
  for (const [id, rule, code] of errors) {
    cases.push({ id, input: { rule }, expect: { error: code } });
  }

  return {
    suite: "rules",
    level: "L3",
    description:
      "Condition evaluation against a fixed context. The trace is normative: short-circuiting " +
      "MUST leave un-evaluated children out of it, and depth MUST match. Incomparable operands " +
      "are an error, never a silent false.",
    cases: [{ id: "__context__", input: { context: RULE_CONTEXT }, expect: {} }, ...cases],
  };
}

function limitsSuite(): VectorSuite {
  const snapshot = (over: Partial<CounterSnapshot> = {}): CounterSnapshot => ({
    issued: 0,
    redemptions: 0,
    subjectRedemptions: 0,
    subjectRecent: [],
    grantedByUnit: new Map(),
    ...over,
  });

  const wireSnapshot = (s: CounterSnapshot) => ({
    issued: s.issued,
    redemptions: s.redemptions,
    subjectRedemptions: s.subjectRedemptions,
    subjectRecent: s.subjectRecent,
    grantedByUnit: Object.fromEntries([...s.grantedByUnit].map(([k, v]) => [k, wire(v)])),
  });

  const rows: [string, CounterSnapshot, LimitSpec, string | undefined, number, Amount[], "advisory" | "authoritative", string?][] = [
    ["no-limits", snapshot(), {}, "s1", 1000, [], "authoritative"],
    ["total-redemptions-room", snapshot({ redemptions: 2 }), { totalRedemptions: 3 }, "s1", 1000, [], "authoritative"],
    ["total-redemptions-full", snapshot({ redemptions: 3 }), { totalRedemptions: 3 }, "s1", 1000, [], "authoritative"],
    ["per-subject-room", snapshot({ subjectRedemptions: 0 }), { perSubject: 1 }, "s1", 1000, [], "authoritative"],
    ["per-subject-full", snapshot({ subjectRedemptions: 1 }), { perSubject: 1 }, "s1", 1000, [], "authoritative"],
    ["per-subject-anonymous", snapshot(), { perSubject: 1 }, undefined, 1000, [], "authoritative", "an anonymous subject cannot satisfy a per-subject limit"],
    ["per-period-room", snapshot({ subjectRecent: [900] }), { perSubjectPerPeriod: { max: 2, windowSeconds: 200 } }, "s1", 1000, [], "authoritative"],
    ["per-period-full", snapshot({ subjectRecent: [900, 950] }), { perSubjectPerPeriod: { max: 2, windowSeconds: 200 } }, "s1", 1000, [], "authoritative"],
    ["per-period-expired", snapshot({ subjectRecent: [100, 200] }), { perSubjectPerPeriod: { max: 2, windowSeconds: 200 } }, "s1", 1000, [], "authoritative", "timestamps outside the window do not count"],
    ["budget-fits", snapshot({ grantedByUnit: new Map([["USD", usd("10.00")]]) }), { totalBudget: { unit: "USD", decimal: "20.00" } }, "s1", 1000, [usd("10.00")], "authoritative", "exactly exhausting the budget is allowed"],
    ["budget-exceeds", snapshot({ grantedByUnit: new Map([["USD", usd("10.00")]]) }), { totalBudget: { unit: "USD", decimal: "15.00" } }, "s1", 1000, [usd("10.00")], "authoritative"],
    ["budget-advisory-has-room", snapshot({ grantedByUnit: new Map([["USD", usd("10.00")]]) }), { totalBudget: { unit: "USD", decimal: "15.00" } }, "s1", 1000, [], "advisory", "advisory mode asks only whether any headroom remains"],
    ["budget-advisory-exhausted", snapshot({ grantedByUnit: new Map([["USD", usd("20.00")]]) }), { totalBudget: { unit: "USD", decimal: "20.00" } }, "s1", 1000, [], "advisory"],
    ["ordering", snapshot({ redemptions: 5, subjectRedemptions: 5 }), { totalRedemptions: 5, perSubject: 5 }, "s1", 1000, [], "authoritative", "totalRedemptions is checked before perSubject; the first breach wins"],
  ];

  return {
    suite: "limits",
    level: "L3",
    description:
      "Limit semantics. Check order is normative - the reported breach MUST be the first one " +
      "in this order: totalRedemptions, perSubject, perSubjectPerPeriod, totalBudget. " +
      "Advisory mode exists because eligibility runs before benefits are resolved.",
    cases: rows.map(([id, snap, limits, subjectId, atSeconds, granted, mode, note]) => ({
      id,
      ...(note === undefined ? {} : { note }),
      input: {
        snapshot: wireSnapshot(snap),
        limits,
        subjectId: subjectId ?? null,
        atSeconds,
        granted: granted.map(wire),
        mode,
      },
      expect: { breach: findBreach(snap, limits, subjectId, atSeconds, granted, mode) },
    })),
  };
}

function benefitsSuite(): VectorSuite {
  const economic = new EconomicAuthority();
  const handlers = new Map(DEFAULT_BENEFIT_TYPES.map((h) => [h.key, h]));

  const lines: CartLine[] = [
    { id: "l1", sku: "TEA-500", quantity: 2, unitPrice: usd("30.00"), categories: ["grocery"], merchant: "m1" },
    { id: "l2", sku: "MUG-CERAMIC", quantity: 1, unitPrice: usd("40.00"), categories: ["homeware"], merchant: "m2" },
  ];

  const rows: [string, BenefitSpec, Amount, CartLine[], string?][] = [
    ["percentage-10", { id: "b", type: "percentage", params: { rate: "10" }, effect: "price_reduction" }, usd("100.00"), lines],
    ["percentage-12.5-odd", { id: "b", type: "percentage", params: { rate: "12.5" }, effect: "price_reduction" }, usd("12.34"), lines],
    ["percentage-rounding", { id: "b", type: "percentage", params: { rate: "33.333" }, effect: "price_reduction", rounding: "half_up" }, usd("100.00"), lines],
    ["flat-under-base", { id: "b", type: "flat", params: { amount: "25.00" }, effect: "price_reduction" }, usd("100.00"), lines],
    ["flat-over-base", { id: "b", type: "flat", params: { amount: "500.00" }, effect: "price_reduction" }, usd("100.00"), lines, "a flat discount is clipped to the base it applies to"],
    ["tiered-middle", { id: "b", type: "tiered", params: { tiers: [{ min: "50.00", rate: "5" }, { min: "100.00", rate: "15" }, { min: "500.00", rate: "25" }] }, effect: "price_reduction" }, usd("100.00"), lines],
    ["tiered-none-met", { id: "b", type: "tiered", params: { tiers: [{ min: "500.00", rate: "25" }] }, effect: "price_reduction" }, usd("100.00"), lines],
    ["tiered-flat-amount", { id: "b", type: "tiered", params: { tiers: [{ min: "50.00", amount: "7.50" }] }, effect: "price_reduction" }, usd("100.00"), lines],
    ["volume-met", { id: "b", type: "volume", params: { tiers: [{ minQuantity: 2, rate: "10" }, { minQuantity: 10, rate: "30" }] }, effect: "price_reduction" }, usd("100.00"), lines],
    ["volume-none-met", { id: "b", type: "volume", params: { tiers: [{ minQuantity: 99, rate: "30" }] }, effect: "price_reduction" }, usd("100.00"), lines],
    ["fixed-price", { id: "b", type: "fixed_price", params: { price: "25.00" }, effect: "price_reduction" }, usd("100.00"), lines],
    ["fixed-price-above", { id: "b", type: "fixed_price", params: { price: "999.00" }, effect: "price_reduction" }, usd("100.00"), lines, "never a negative benefit"],
    ["free-quantity", { id: "b", type: "free_quantity", params: { buy: 2, free: 1 }, effect: "price_reduction" }, usd("100.00"), lines, "the cheapest units are the free ones"],
    ["item-grant", { id: "b", type: "item_grant", params: { sku: "FREE-MUG", quantity: 2, value: "4.50" }, effect: "item_grant" }, usd("100.00"), lines],
    ["points-accrual", { id: "b", type: "points_accrual", params: { points: 2, per: 1 }, effect: "points_grant", unit: "POINTS" }, usd("100.00"), lines],
    ["points-accrual-per-5", { id: "b", type: "points_accrual", params: { points: 1, per: 5 }, effect: "points_grant", unit: "POINTS" }, usd("100.00"), lines],
  ];

  return {
    suite: "benefits",
    level: "L3",
    description:
      "Benefit computation. Line allocations MUST sum exactly to the computed value, spread " +
      "proportionally to line totals using the same remainder rule as `allocate`.",
    cases: rows.map(([id, spec, base, targeted, note]) => {
      const unitKey = handlers.get(spec.type)!.unitPolicy === "base" ? base.unit : (spec.unit ?? base.unit);
      const scale = unwrap(economic.units.require(unitKey)).scale;
      const computed = unwrap(
        handlers.get(spec.type)!.compute({
          spec,
          context: {} as ResolvedContext,
          economic,
          lines: targeted,
          base,
          unit: unitKey,
          scale,
        }),
      );
      return {
        id,
        ...(note === undefined ? {} : { note }),
        input: { spec, base: wire(base), lines: targeted.map((l) => ({ ...l, unitPrice: wire(l.unitPrice) })), unit: unitKey, scale },
        expect: {
          value: wire(computed.value),
          allocations: computed.allocations.map((a) => ({ lineId: a.lineId, amount: wire(a.amount) })),
          detail: computed.detail,
          ...(computed.grant === undefined ? {} : { grant: computed.grant }),
        },
      };
    }),
  };
}

function spatialSuite(): VectorSuite {
  const spatial = new SpatialAuthority();
  const queries: [string, { include?: string[]; exclude?: string[] }, string][] = [
    ["unscoped", {}, "mars.olympus"],
    ["include-country", { include: ["earth.in"] }, "earth.in.br.patna"],
    ["include-miss", { include: ["earth.in"] }, "earth.us.ny"],
    ["exclude-beats-include", { include: ["earth.in"], exclude: ["earth.in.mh.mumbai"] }, "earth.in.mh.mumbai"],
    ["exclude-sibling-unaffected", { include: ["earth.in"], exclude: ["earth.in.mh.mumbai"] }, "earth.in.br.patna"],
    ["self-containment", { include: ["earth.in.br.patna"] }, "earth.in.br.patna"],
    ["virtual-outside-physical", { include: ["earth"] }, "net.marketplace.app"],
    ["off-world", { include: ["mars.olympus"] }, "mars.olympus.sector-7"],
  ];

  const cases: VectorCase[] = queries.map(([id, scope, place]) => ({
    id,
    input: { scope, place },
    expect: { verdict: unwrap(spatial.evaluateScope(scope, place)) },
  }));

  for (const key of ["earth.in.br.patna.store-01", "mars.olympus.sector-7", "net.marketplace.app", "sol"]) {
    cases.push({
      id: `path:${key}`,
      input: { op: "path", key },
      expect: { path: unwrap(spatial.path(key)), jurisdiction: unwrap(spatial.jurisdictionOf(key)) ?? null },
    });
  }

  return {
    suite: "spatial",
    level: "L3",
    description:
      "Containment over a node tree. Exclude always beats include. The node table is supplied " +
      "with the vectors, so an implementation needs no built-in geography - which is the point.",
    cases: [
      { id: "__nodes__", input: { nodes: DEFAULT_SPATIAL_NODES }, expect: {} },
      ...cases,
    ],
  };
}

function temporalSuite(): VectorSuite {
  const temporal = new TemporalAuthority({ clock: fixedClock(0n) });
  const cases: VectorCase[] = [];

  const moments: [string, number][] = [
    ["epoch", Date.UTC(1970, 0, 1)],
    ["leap-day-2000", Date.UTC(2000, 1, 29)],
    ["saturday-2026", Date.UTC(2026, 8, 19, 10, 30)],
    ["century-1900", Date.UTC(1900, 2, 1)],
    ["pre-epoch", Date.UTC(1969, 6, 20)],
    ["year-end", Date.UTC(2024, 11, 31, 23, 59, 59)],
  ];

  for (const [id, ms] of moments) {
    for (const [calendar, zone] of [["gregorian", "UTC"], ["gregorian", "Asia/Kolkata"], ["fiscal.in", "UTC"]] as const) {
      cases.push({
        id: `${calendar}@${zone}:${id}`,
        input: { calendar, zone, instant: { chronology: "earth.unix.ms", tick: String(ms) } },
        expect: { fields: unwrap(temporal.fields(instant("earth.unix.ms", BigInt(ms)), calendar, zone)) },
      });
    }
  }

  // Mars: a calendar with no months and no weeks, on a shared SI frame.
  const marsInstant = unwrap(temporal.convert(instant("earth.unix.ms", BigInt(Date.UTC(2026, 8, 19, 10, 30))), "mars.sol.msd"));
  cases.push({
    id: "mars:conversion-and-fields",
    note: "converting to a coarser tick floors; the loss is bounded by one target tick",
    input: { op: "convert", from: { chronology: "earth.unix.ms", tick: String(Date.UTC(2026, 8, 19, 10, 30)) }, to: "mars.sol.msd" },
    expect: {
      instant: { chronology: marsInstant.chronology, tick: marsInstant.tick.toString() },
      fields: unwrap(temporal.fields(marsInstant, "mars.msd")),
    },
  });

  const window = {
    from: instant("earth.unix.ms", BigInt(Date.UTC(2026, 0, 1))),
    to: instant("earth.unix.ms", BigInt(Date.UTC(2027, 0, 1))),
    calendar: "gregorian",
    constraints: [{ field: "dayOfWeek", in: [6, 7] }],
  };
  for (const [id, ms] of [["inside-saturday", Date.UTC(2026, 8, 19)], ["outside-monday", Date.UTC(2026, 8, 21)], ["before-start", Date.UTC(2025, 5, 1)], ["after-end", Date.UTC(2027, 5, 1)]] as const) {
    cases.push({
      id: `window:${id}`,
      input: {
        op: "contains",
        window: { from: { chronology: "earth.unix.ms", tick: String(Date.UTC(2026, 0, 1)) }, to: { chronology: "earth.unix.ms", tick: String(Date.UTC(2027, 0, 1)) }, calendar: "gregorian", constraints: [{ field: "dayOfWeek", in: [6, 7] }] },
        instant: { chronology: "earth.unix.ms", tick: String(ms) },
      },
      expect: { verdict: unwrap(temporal.contains(window, instant("earth.unix.ms", BigInt(ms)))) },
    });
  }

  return {
    suite: "temporal",
    level: "L3",
    description:
      "Calendars publish named integer fields; nothing assumes a year, a week or a planet. " +
      "Window bounds are inclusive at the start and exclusive at the end.",
    cases,
  };
}

async function attributionSuite(): Promise<VectorSuite> {
  const store = new MemoryPlatformStore();
  const engine = new AttributionEngine(attributionModelRegistry(), store.touchpoints);
  const cases: VectorCase[] = [];

  const makeJourney = (length: number): Touchpoint[] =>
    Array.from({ length }, (_, i) => ({
      id: `t${i}`,
      tenant: "t",
      subjectId: "s1",
      kind: "click" as const,
      party: { kind: "affiliate", id: `p${i}` },
      at: String((i + 1) * 1000),
    }));

  for (const model of attributionModelRegistry().keys()) {
    for (const length of [1, 2, 3, 5, 7]) {
      const touchpoints = makeJourney(length);
      const shares = unwrap(engine.attribute(model, { touchpoints, value: usd("100.00") }));
      cases.push({
        id: `${model}:${length}`,
        input: { model, touchpointCount: length, value: wire(usd("100.00")) },
        expect: {
          basisPoints: shares.map((s) => s.basisPoints),
          amounts: shares.map((s) => wire(s.amount as Amount)),
          basisPointsSum: shares.reduce((t, s) => t + s.basisPoints, 0),
        },
      });
    }
  }

  cases.push({
    id: "empty-journey",
    input: { model: "linear", touchpointCount: 0 },
    expect: { basisPoints: [], amounts: [], basisPointsSum: 0 },
  });

  return {
    suite: "attribution",
    level: "L4",
    description:
      "Credit division. Basis points MUST sum to exactly 10000 and money MUST sum to exactly " +
      "the attributed value, for every model at every journey length.",
    cases,
  };
}

export async function buildLevel3And4(): Promise<VectorSuite[]> {
  return [rulesSuite(), limitsSuite(), benefitsSuite(), spatialSuite(), temporalSuite(), await attributionSuite()];
}
