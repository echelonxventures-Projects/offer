/**
 * Built-in rule functions.
 *
 * Functions exist for the questions a dotted path cannot answer: "how many
 * items in the cart belong to these categories", "what do those lines total".
 * They are pure, bounded by the cart they are given, and registry-driven like
 * everything else.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import { Registry } from "../registry/registry.ts";
import type { RuleFunction } from "./types.ts";
import type { CartLine } from "../context/context.ts";
import { add, zero } from "../universal/economic/amount.ts";
import { globMatch } from "./compare.ts";

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : [];

/** Lines matching any of the given category keys. Empty list means all lines. */
function linesIn(lines: readonly CartLine[], categories: string[]): CartLine[] {
  if (categories.length === 0) return [...lines];
  return lines.filter((line) => line.categories.some((c) => categories.includes(c)));
}

const FUNCTIONS: RuleFunction[] = [
  {
    key: "list",
    label: "Build a list",
    description: "Variadic: collects its arguments into an array for 'in' and 'includesAny'.",
    arity: -1,
    call: (args) => ok([...args]),
  },
  {
    key: "cart.quantityIn",
    label: "Quantity in categories",
    arity: 1,
    call: (args, ctx) => {
      const cart = ctx.context.cart;
      if (!cart) return ok(0);
      const categories = toStringArray(args[0]);
      return ok(linesIn(cart.lines, categories).reduce((total, line) => total + line.quantity, 0));
    },
  },
  {
    key: "cart.subtotalOf",
    label: "Subtotal of categories",
    description: "Sum of line totals for lines in the given categories, as an Amount.",
    arity: 1,
    call: (args, ctx) => {
      const cart = ctx.context.cart;
      const { unit, scale } = ctx.context.economic;
      if (!cart) return ok(zero(unit, scale));
      const categories = toStringArray(args[0]);
      let total = zero(unit, scale);
      for (const line of linesIn(cart.lines, categories)) {
        const next = add(total, { ...line.unitPrice, minor: line.unitPrice.minor * BigInt(line.quantity) });
        if (!next.ok) return next;
        total = next.value;
      }
      return ok(total);
    },
  },
  {
    key: "cart.hasSku",
    label: "Cart contains SKU",
    description: "Glob-matched against every line's SKU.",
    arity: 1,
    call: (args, ctx) => {
      const cart = ctx.context.cart;
      if (!cart) return ok(false);
      const patterns = toStringArray(args[0]);
      return ok(cart.lines.some((line) => patterns.some((p) => globMatch(p, line.sku))));
    },
  },
  {
    key: "cart.merchants",
    label: "Merchants in cart",
    arity: 0,
    call: (_args, ctx) => {
      const cart = ctx.context.cart;
      if (!cart) return ok([]);
      return ok([...new Set(cart.lines.map((line) => line.merchant).filter((m): m is string => !!m))].sort());
    },
  },
  {
    key: "subject.counter",
    label: "Subject counter",
    description: "Named counter such as 'redemptions.total' or 'orders.lifetime'. Missing reads as 0.",
    arity: 1,
    call: (args, ctx) => {
      const name = args[0];
      if (typeof name !== "string") {
        return fail(ErrorCode.RULE_ERROR, "'subject.counter' needs a counter name");
      }
      return ok(ctx.context.subject.counters[name] ?? 0);
    },
  },
  {
    key: "facet",
    label: "Read a context facet",
    description: "Reads facets.<key>; returns the default when the facet is absent.",
    arity: 2,
    call: (args, ctx) => {
      const key = args[0];
      if (typeof key !== "string") return fail(ErrorCode.RULE_ERROR, "'facet' needs a facet key");
      const value = ctx.context.facets[key];
      return ok(value === undefined ? args[1] : value);
    },
  },
];

export function ruleFunctionRegistry(): Registry<RuleFunction> {
  return new Registry<RuleFunction>("rule-function").registerAll(FUNCTIONS);
}
