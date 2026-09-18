/**
 * Built-in operators.
 *
 * This list is not the language; the registry is. Each entry is self-contained
 * and a tenant adds `op: "acme.hasValidPrescription"` without touching any of
 * this. The built-ins cover logic, ordering, membership, string shape, and the
 * two domain questions that every incentive in every industry eventually asks:
 * where are we, and when are we.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import { Registry } from "../registry/registry.ts";
import type { RuleNode } from "./ast.ts";
import type { EvalContext, OperatorOutcome, RuleOperator } from "./types.ts";
import { compareValues, describe, equalValues, globMatch } from "./compare.ts";
import type { TemporalWindow } from "../universal/temporal/window.ts";
import type { Instant } from "../universal/temporal/chronology.ts";

const yes = (detail?: string): Result<OperatorOutcome> =>
  ok(detail === undefined ? { result: true } : { result: true, detail });
const no = (detail?: string): Result<OperatorOutcome> =>
  ok(detail === undefined ? { result: false } : { result: false, detail });

function childNodes(node: RuleNode, key: string): Result<unknown[]> {
  const value = node[key];
  if (!Array.isArray(value)) {
    return fail(ErrorCode.RULE_ERROR, `'${node.op}' needs an array in '${key}'`);
  }
  return ok(value);
}

/** Resolve the conventional `left`/`right` pair and order them. */
function ordered(node: RuleNode, ctx: EvalContext): Result<{ ord: -1 | 0 | 1 | null; detail: string }> {
  const left = ctx.resolve(node.left);
  if (!left.ok) return left;
  const right = ctx.resolve(node.right);
  if (!right.ok) return right;
  const ord = compareValues(left.value, right.value);
  if (!ord.ok) return ord;
  return ok({ ord: ord.value, detail: `${render(left.value)} vs ${render(right.value)}` });
}

function render(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && value !== null && "minor" in value && "unit" in value) {
    const a = value as { minor: bigint; unit: string };
    return `${a.minor}${a.unit}`;
  }
  if (Array.isArray(value)) return `[${value.length} items]`;
  return String(value);
}

const LOGICAL: RuleOperator[] = [
  {
    key: "always",
    label: "Always true",
    args: [],
    logical: true,
    evaluate: () => yes(),
  },
  {
    key: "never",
    label: "Always false",
    args: [],
    logical: true,
    evaluate: () => no(),
  },
  {
    key: "all",
    label: "All of",
    description: "Short-circuits on the first false child, so the trace names the reason.",
    args: ["of"],
    logical: true,
    evaluate(node, ctx) {
      const children = childNodes(node, "of");
      if (!children.ok) return children;
      for (const [index, child] of children.value.entries()) {
        const outcome = ctx.evaluate(child);
        if (!outcome.ok) return outcome;
        if (!outcome.value) return no(`child ${index} failed`);
      }
      return yes(`${children.value.length} children satisfied`);
    },
  },
  {
    key: "any",
    label: "Any of",
    args: ["of"],
    logical: true,
    evaluate(node, ctx) {
      const children = childNodes(node, "of");
      if (!children.ok) return children;
      for (const [index, child] of children.value.entries()) {
        const outcome = ctx.evaluate(child);
        if (!outcome.ok) return outcome;
        if (outcome.value) return yes(`child ${index} satisfied`);
      }
      return no(`none of ${children.value.length} children satisfied`);
    },
  },
  {
    key: "none",
    label: "None of",
    args: ["of"],
    logical: true,
    evaluate(node, ctx) {
      const children = childNodes(node, "of");
      if (!children.ok) return children;
      for (const [index, child] of children.value.entries()) {
        const outcome = ctx.evaluate(child);
        if (!outcome.ok) return outcome;
        if (outcome.value) return no(`child ${index} matched`);
      }
      return yes();
    },
  },
  {
    key: "not",
    label: "Not",
    args: ["of"],
    logical: true,
    evaluate(node, ctx) {
      const outcome = ctx.evaluate(node.of);
      if (!outcome.ok) return outcome;
      return outcome.value ? no() : yes();
    },
  },
];

const COMPARISON: RuleOperator[] = [
  {
    key: "eq",
    label: "Equals",
    args: ["left", "right"],
    evaluate(node, ctx) {
      const left = ctx.resolve(node.left);
      if (!left.ok) return left;
      const right = ctx.resolve(node.right);
      if (!right.ok) return right;
      const same = equalValues(left.value, right.value);
      return ok({ result: same, detail: `${render(left.value)} ${same ? "==" : "!="} ${render(right.value)}` });
    },
  },
  {
    key: "ne",
    label: "Not equals",
    args: ["left", "right"],
    evaluate(node, ctx) {
      const left = ctx.resolve(node.left);
      if (!left.ok) return left;
      const right = ctx.resolve(node.right);
      if (!right.ok) return right;
      return ok({ result: !equalValues(left.value, right.value) });
    },
  },
  {
    key: "gt",
    label: "Greater than",
    args: ["left", "right"],
    evaluate: (node, ctx) => withOrdering(node, ctx, (o) => o > 0),
  },
  {
    key: "gte",
    label: "Greater than or equal",
    args: ["left", "right"],
    evaluate: (node, ctx) => withOrdering(node, ctx, (o) => o >= 0),
  },
  {
    key: "lt",
    label: "Less than",
    args: ["left", "right"],
    evaluate: (node, ctx) => withOrdering(node, ctx, (o) => o < 0),
  },
  {
    key: "lte",
    label: "Less than or equal",
    args: ["left", "right"],
    evaluate: (node, ctx) => withOrdering(node, ctx, (o) => o <= 0),
  },
  {
    key: "between",
    label: "Between (inclusive)",
    args: ["value", "low", "high"],
    evaluate(node, ctx) {
      const value = ctx.resolve(node.value);
      if (!value.ok) return value;
      const low = ctx.resolve(node.low);
      if (!low.ok) return low;
      const high = ctx.resolve(node.high);
      if (!high.ok) return high;
      const lowCmp = compareValues(value.value, low.value);
      if (!lowCmp.ok) return lowCmp;
      const highCmp = compareValues(value.value, high.value);
      if (!highCmp.ok) return highCmp;
      if (lowCmp.value === null || highCmp.value === null) {
        return no(`${render(value.value)} is absent or unbounded`);
      }
      const inside = lowCmp.value >= 0 && highCmp.value <= 0;
      return ok({
        result: inside,
        detail: `${render(low.value)} <= ${render(value.value)} <= ${render(high.value)} is ${inside}`,
      });
    },
  },
];

function withOrdering(
  node: RuleNode,
  ctx: EvalContext,
  test: (ordering: number) => boolean,
): Result<OperatorOutcome> {
  const cmp = ordered(node, ctx);
  if (!cmp.ok) return cmp;
  // An absent operand cannot satisfy an ordering. It is reported in the trace
  // so the reason is visible, rather than looking like a failed comparison.
  if (cmp.value.ord === null) {
    return ok({ result: false, detail: `${cmp.value.detail} (a value was absent)` });
  }
  return ok({ result: test(cmp.value.ord), detail: cmp.value.detail });
}

const MEMBERSHIP: RuleOperator[] = [
  {
    key: "exists",
    label: "Exists",
    description: "True when the term resolves to something other than null or undefined.",
    args: ["value"],
    evaluate(node, ctx) {
      const value = ctx.resolve(node.value);
      if (!value.ok) return value;
      const present = value.value !== undefined && value.value !== null;
      return ok({ result: present, detail: describe(value.value) });
    },
  },
  {
    key: "in",
    label: "In",
    description: "Value appears in a list of options.",
    args: ["value", "options"],
    evaluate(node, ctx) {
      const value = ctx.resolve(node.value);
      if (!value.ok) return value;
      const options = ctx.resolve(node.options);
      if (!options.ok) return options;
      if (!Array.isArray(options.value)) {
        return fail(ErrorCode.RULE_ERROR, "'in' needs an array in 'options'");
      }
      const found = options.value.some((candidate) => equalValues(value.value, candidate));
      return ok({ result: found, detail: `${render(value.value)} in ${options.value.length} options` });
    },
  },
  {
    key: "notIn",
    label: "Not in",
    args: ["value", "options"],
    evaluate(node, ctx) {
      const value = ctx.resolve(node.value);
      if (!value.ok) return value;
      const options = ctx.resolve(node.options);
      if (!options.ok) return options;
      if (!Array.isArray(options.value)) {
        return fail(ErrorCode.RULE_ERROR, "'notIn' needs an array in 'options'");
      }
      return ok({ result: !options.value.some((candidate) => equalValues(value.value, candidate)) });
    },
  },
  {
    key: "includesAny",
    label: "Collection includes any",
    args: ["collection", "values"],
    evaluate: (node, ctx) => setOperator(node, ctx, "any"),
  },
  {
    key: "includesAll",
    label: "Collection includes all",
    args: ["collection", "values"],
    evaluate: (node, ctx) => setOperator(node, ctx, "all"),
  },
  {
    key: "sizeOf",
    label: "Collection size comparison",
    description: "Compares the length of a collection against a term.",
    args: ["collection", "gte", "lte"],
    evaluate(node, ctx) {
      const collection = ctx.resolve(node.collection);
      if (!collection.ok) return collection;
      if (!Array.isArray(collection.value)) {
        return fail(ErrorCode.RULE_ERROR, "'sizeOf' needs an array in 'collection'");
      }
      const size = collection.value.length;
      if (node.gte !== undefined) {
        const lower = ctx.resolve(node.gte);
        if (!lower.ok) return lower;
        if (size < Number(lower.value)) return no(`size ${size} < ${String(lower.value)}`);
      }
      if (node.lte !== undefined) {
        const upper = ctx.resolve(node.lte);
        if (!upper.ok) return upper;
        if (size > Number(upper.value)) return no(`size ${size} > ${String(upper.value)}`);
      }
      return yes(`size ${size}`);
    },
  },
  {
    key: "glob",
    label: "Glob match",
    description: "Non-backtracking wildcard match with * and ?. There is no regex operator by design.",
    args: ["value", "pattern"],
    evaluate(node, ctx) {
      const value = ctx.resolve(node.value);
      if (!value.ok) return value;
      const pattern = ctx.resolve(node.pattern);
      if (!pattern.ok) return pattern;
      if (typeof value.value !== "string" || typeof pattern.value !== "string") {
        return fail(ErrorCode.RULE_ERROR, "'glob' needs strings in 'value' and 'pattern'");
      }
      const matched = globMatch(pattern.value, value.value);
      return ok({ result: matched, detail: `'${value.value}' ~ '${pattern.value}'` });
    },
  },
];

function setOperator(node: RuleNode, ctx: EvalContext, mode: "any" | "all"): Result<OperatorOutcome> {
  const collection = ctx.resolve(node.collection);
  if (!collection.ok) return collection;
  const values = ctx.resolve(node.values);
  if (!values.ok) return values;
  if (!Array.isArray(collection.value)) {
    return fail(ErrorCode.RULE_ERROR, `'${node.op}' needs an array in 'collection'`);
  }
  const wanted = Array.isArray(values.value) ? values.value : [values.value];
  const hit = (candidate: unknown) =>
    (collection.value as unknown[]).some((item) => equalValues(item, candidate));
  const result = mode === "any" ? wanted.some(hit) : wanted.every(hit);
  return ok({ result, detail: `${mode} of ${wanted.length} against ${collection.value.length}` });
}

const DOMAIN: RuleOperator[] = [
  {
    key: "spatial.within",
    label: "Place is within",
    description: "True when the context place sits inside any of the listed spatial nodes.",
    args: ["nodes", "exclude"],
    evaluate(node, ctx) {
      const { place, path } = ctx.context.spatial;
      if (!place) return no("context has no place");

      // Read the ancestry the context resolver already computed rather than
      // re-walking the spatial registry. Same answer, and it keeps rule
      // evaluation a pure function of the context - which is what lets a rule
      // be evaluated by an implementation that has no node table loaded.
      const include = Array.isArray(node.nodes) ? (node.nodes as string[]) : [];
      const exclude = Array.isArray(node.exclude) ? (node.exclude as string[]) : [];

      for (const excluded of exclude) {
        if (path.includes(excluded)) return no(`excluded by ${excluded}`);
      }
      if (include.length === 0) return yes("unscoped");
      for (const included of include) {
        if (path.includes(included)) return yes(`matched ${included}`);
      }
      return no(`place ${place} not in scope`);
    },
  },
  {
    key: "spatial.jurisdiction",
    label: "Jurisdiction is",
    args: ["in"],
    evaluate(node, ctx) {
      const jurisdiction = ctx.context.spatial.jurisdiction;
      const allowed = Array.isArray(node.in) ? (node.in as string[]) : [];
      const result = jurisdiction !== undefined && allowed.includes(jurisdiction);
      return ok({ result, detail: `jurisdiction=${jurisdiction ?? "none"}` });
    },
  },
  {
    key: "temporal.within",
    label: "Instant is within window",
    description: "Evaluates a temporal window, including its calendar field constraints.",
    args: ["window"],
    evaluate(node, ctx) {
      const window = node.window as TemporalWindow | undefined;
      if (!window || typeof window !== "object") {
        return fail(ErrorCode.RULE_ERROR, "'temporal.within' needs a 'window' object");
      }
      const verdict = ctx.deps.temporal.contains(normaliseWindow(window), ctx.context.instant);
      if (!verdict.ok) return verdict;
      return ok({
        result: verdict.value.inside,
        detail: verdict.value.reason ?? "inside window",
      });
    },
  },
  {
    key: "temporal.field",
    label: "Calendar field matches",
    description: "Reads a named field of the context calendar, e.g. dayOfWeek or fiscalQuarter.",
    args: ["field", "in", "min", "max"],
    evaluate(node, ctx) {
      const field = typeof node.field === "string" ? node.field : null;
      if (!field) return fail(ErrorCode.RULE_ERROR, "'temporal.field' needs a 'field' name");
      const value = ctx.context.temporal.fields[field];
      if (value === undefined) {
        return no(`calendar '${ctx.context.temporal.calendar}' has no field '${field}'`);
      }
      if (Array.isArray(node.in) && !(node.in as number[]).includes(value)) {
        return no(`${field}=${value} not in list`);
      }
      if (typeof node.min === "number" && value < node.min) return no(`${field}=${value} < ${node.min}`);
      if (typeof node.max === "number" && value > node.max) return no(`${field}=${value} > ${node.max}`);
      return yes(`${field}=${value}`);
    },
  },
  {
    key: "subject.hasSegment",
    label: "Subject is in segment",
    args: ["segments", "mode"],
    evaluate(node, ctx) {
      const wanted = Array.isArray(node.segments) ? (node.segments as string[]) : [];
      const held = ctx.context.subject.segments;
      const mode = node.mode === "all" ? "all" : "any";
      const result = mode === "all" ? wanted.every((s) => held.includes(s)) : wanted.some((s) => held.includes(s));
      return ok({ result, detail: `holds [${held.join(", ")}]` });
    },
  },
  {
    key: "subject.hasMembership",
    label: "Subject holds membership",
    args: ["memberships"],
    evaluate(node, ctx) {
      const wanted = Array.isArray(node.memberships) ? (node.memberships as string[]) : [];
      const held = ctx.context.subject.memberships;
      return ok({ result: wanted.some((m) => held.includes(m)), detail: `holds [${held.join(", ")}]` });
    },
  },
];

export function ruleOperatorRegistry(): Registry<RuleOperator> {
  return new Registry<RuleOperator>("rule-operator").registerAll([
    ...LOGICAL,
    ...COMPARISON,
    ...MEMBERSHIP,
    ...DOMAIN,
  ]);
}

/** Windows arriving as JSON have plain-number ticks; restore them to bigint. */
function normaliseWindow(window: TemporalWindow): TemporalWindow {
  const fix = (value: Instant | undefined): Instant | undefined =>
    value === undefined ? undefined : { chronology: value.chronology, tick: BigInt(value.tick) };
  return {
    ...window,
    ...(window.from === undefined ? {} : { from: fix(window.from) as Instant }),
    ...(window.to === undefined ? {} : { to: fix(window.to) as Instant }),
  };
}
