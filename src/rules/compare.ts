/**
 * Value comparison for the rule evaluator.
 *
 * One place decides what "greater than" means across amounts, numbers, bigints,
 * strings and booleans, so a rule that compares a cart subtotal to a threshold
 * behaves identically wherever it is evaluated. Mixed, meaningless comparisons
 * (a string against money) are errors rather than `false`, because silently
 * returning false hides an authoring mistake until it costs somebody money.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import { isAmount } from "../context/context.ts";
import { compare as compareAmount } from "../universal/economic/amount.ts";

export type Ordering = -1 | 0 | 1;

export function compareValues(left: unknown, right: unknown): Result<Ordering> {
  if (isAmount(left) && isAmount(right)) return compareAmount(left, right);

  if (typeof left === "bigint" || typeof right === "bigint") {
    const l = toBigInt(left);
    const r = toBigInt(right);
    if (l === null || r === null) return mismatch(left, right);
    return ok(l < r ? -1 : l > r ? 1 : 0);
  }

  if (typeof left === "number" && typeof right === "number") {
    if (Number.isNaN(left) || Number.isNaN(right)) {
      return fail(ErrorCode.RULE_ERROR, "cannot order NaN");
    }
    return ok(left < right ? -1 : left > right ? 1 : 0);
  }

  if (typeof left === "string" && typeof right === "string") {
    const c = left < right ? -1 : left > right ? 1 : 0;
    return ok(c as Ordering);
  }

  if (typeof left === "boolean" && typeof right === "boolean") {
    return ok(left === right ? 0 : left ? 1 : -1);
  }

  return mismatch(left, right);
}

/** Structural equality. Amounts compare by value, not by object identity. */
export function equalValues(left: unknown, right: unknown): boolean {
  if (isAmount(left) && isAmount(right)) {
    return left.unit === right.unit && left.scale === right.scale && left.minor === right.minor;
  }
  if (left === right) return true;
  if (typeof left === "bigint" || typeof right === "bigint") {
    const l = toBigInt(left);
    const r = toBigInt(right);
    return l !== null && r !== null && l === r;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => equalValues(item, right[i]));
  }
  if (typeof left === "object" && typeof right === "object" && left !== null && right !== null) {
    const lk = Object.keys(left as object).sort();
    const rk = Object.keys(right as object).sort();
    if (lk.length !== rk.length || lk.some((k, i) => k !== rk[i])) return false;
    return lk.every((k) =>
      equalValues((left as Record<string, unknown>)[k], (right as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  return null;
}

function mismatch(left: unknown, right: unknown): Result<Ordering> {
  return fail(ErrorCode.RULE_ERROR, `cannot order ${describe(left)} against ${describe(right)}`, {
    left: describe(left),
    right: describe(right),
  });
}

export function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (isAmount(value)) return `amount(${value.unit})`;
  if (Array.isArray(value)) return `array[${value.length}]`;
  return typeof value;
}

/**
 * Glob matching with `*` (any run) and `?` (one character).
 *
 * Two-pointer algorithm with a single backtrack point, so it is linear in the
 * input and cannot be made to blow up by a hostile pattern - which is exactly
 * the property a regular expression would not give us.
 */
export function globMatch(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let mark = 0;

  while (v < value.length) {
    const pc = pattern[p];
    if (p < pattern.length && (pc === "?" || pc === value[v])) {
      p += 1;
      v += 1;
    } else if (p < pattern.length && pc === "*") {
      star = p;
      mark = v;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      v = mark;
    } else {
      return false;
    }
  }

  while (pattern[p] === "*") p += 1;
  return p === pattern.length;
}
