/**
 * Rule AST.
 *
 * Conditions are data, not code. A rule is JSON: it can be stored, versioned,
 * diffed, approved, shipped to an edge node, replayed three years later and
 * shown to a regulator. Nothing in a rule can call out, loop unboundedly or
 * allocate - the evaluator is total by construction.
 *
 * Deliberate omission: there is no regular-expression operator. Tenant-authored
 * patterns evaluated on the request path are a denial-of-service waiting to
 * happen, so string matching is limited to a non-backtracking glob. See
 * docs/06-adr/0004-no-regex-in-rules.md.
 */
import type { Json } from "../kernel/types.ts";

/** A value inside a rule: a context path, a literal, money, or a function. */
export type Term =
  /** Dotted path into the resolved context, e.g. "cart.subtotal". */
  | { readonly path: string; readonly default?: Json }
  /** A constant. */
  | { readonly literal: Json }
  /** Money literal, parsed against the unit registry at compile time. */
  | { readonly amount: { readonly unit: string; readonly decimal: string } }
  /** A registered rule function, e.g. `{ fn: "cart.quantityIn", args: [...] }`. */
  | { readonly fn: string; readonly args?: readonly Term[] };

/**
 * A rule node. `op` selects a registered operator; the remaining properties are
 * that operator's own arguments, which it validates itself.
 */
export interface RuleNode {
  readonly op: string;
  readonly [argument: string]: unknown;
}

/** Result of evaluating one node, kept for the decision trace. */
export interface RuleTraceEntry {
  readonly op: string;
  readonly result: boolean;
  readonly depth: number;
  /** Operator-supplied explanation: which values were compared. */
  readonly detail?: string;
}

export const isTerm = (value: unknown): value is Term =>
  typeof value === "object" &&
  value !== null &&
  ("path" in value || "literal" in value || "amount" in value || "fn" in value);

/* --------------------------------------------------------------- *
 * Builders. Rules are usually authored as JSON by a console, but
 * writing them by hand in tests and seed data should not be painful.
 * --------------------------------------------------------------- */

export const path = (p: string, fallback?: Json): Term =>
  fallback === undefined ? { path: p } : { path: p, default: fallback };
export const lit = (value: Json): Term => ({ literal: value });
export const money = (unit: string, decimal: string): Term => ({ amount: { unit, decimal } });
export const fn = (name: string, ...args: Term[]): Term => ({ fn: name, args });

export const all = (...of: RuleNode[]): RuleNode => ({ op: "all", of });
export const any = (...of: RuleNode[]): RuleNode => ({ op: "any", of });
export const none = (...of: RuleNode[]): RuleNode => ({ op: "none", of });
export const not = (of: RuleNode): RuleNode => ({ op: "not", of });
export const always: RuleNode = { op: "always" };
export const never: RuleNode = { op: "never" };

export const eq = (left: Term, right: Term): RuleNode => ({ op: "eq", left, right });
export const ne = (left: Term, right: Term): RuleNode => ({ op: "ne", left, right });
export const gt = (left: Term, right: Term): RuleNode => ({ op: "gt", left, right });
export const gte = (left: Term, right: Term): RuleNode => ({ op: "gte", left, right });
export const lt = (left: Term, right: Term): RuleNode => ({ op: "lt", left, right });
export const lte = (left: Term, right: Term): RuleNode => ({ op: "lte", left, right });
export const between = (value: Term, low: Term, high: Term): RuleNode => ({ op: "between", value, low, high });
export const oneOf = (value: Term, options: Term): RuleNode => ({ op: "in", value, options });
export const exists = (value: Term): RuleNode => ({ op: "exists", value });
export const includesAny = (collection: Term, values: Term): RuleNode => ({ op: "includesAny", collection, values });
export const includesAll = (collection: Term, values: Term): RuleNode => ({ op: "includesAll", collection, values });
export const glob = (value: Term, pattern: Term): RuleNode => ({ op: "glob", value, pattern });
export const withinPlace = (nodes: string[]): RuleNode => ({ op: "spatial.within", nodes });
export const withinWindow = (window: Json): RuleNode => ({ op: "temporal.within", window });
