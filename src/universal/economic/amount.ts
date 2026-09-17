/**
 * Amounts.
 *
 * Money is never a float. An `Amount` is an exact integer count of minor units
 * plus the unit key and its scale, so 10% of $12.34 is a decision about
 * rounding rather than a decision about floating point. Every arithmetic
 * operation that could lose value takes an explicit rounding mode, and the
 * caller is forced to say which one.
 */
import type { Result } from "../../kernel/result.ts";
import { fail, ok } from "../../kernel/result.ts";
import { ErrorCode, invariant } from "../../kernel/errors.ts";

export interface Amount {
  /** Economic unit key, e.g. "USD", "POINTS", "MARS_CREDIT". */
  readonly unit: string;
  /** Exact integer count of 10^-scale units. */
  readonly minor: bigint;
  /** Decimal places; carried on the amount so it is self-describing. */
  readonly scale: number;
}

/** An exact rational. Rates, percentages and splits are all rationals. */
export interface Rate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export const ROUNDING_MODES = [
  "half_up",
  "half_down",
  "half_even",
  "up",
  "down",
  "ceiling",
  "floor",
] as const;

export type RoundingMode = (typeof ROUNDING_MODES)[number];

export const DEFAULT_ROUNDING: RoundingMode = "half_even";

export function amount(unit: string, minor: bigint | number | string, scale: number): Amount {
  invariant(Number.isInteger(scale) && scale >= 0, `scale must be a non-negative integer, got ${scale}`);
  return { unit, minor: BigInt(minor), scale };
}

export function zero(unit: string, scale: number): Amount {
  return { unit, minor: 0n, scale };
}

/** Parse a decimal string ("12.34") into an exact Amount at the given scale. */
export function fromDecimal(unit: string, decimal: string, scale: number): Amount {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  invariant(match !== null, `'${decimal}' is not a decimal number`);
  const [, sign, whole = "0", frac = ""] = match as RegExpExecArray;
  const padded = (frac + "0".repeat(scale)).slice(0, scale);
  const dropped = frac.slice(scale);
  invariant(
    dropped === "" || /^0*$/.test(dropped),
    `'${decimal}' has more precision than unit scale ${scale} allows`,
  );
  const minor = BigInt(whole + padded);
  return { unit, minor: sign === "-" ? -minor : minor, scale };
}

/** Render as a plain decimal string. Presentation, never used for comparison. */
export function toDecimal(a: Amount): string {
  const negative = a.minor < 0n;
  const digits = (negative ? -a.minor : a.minor).toString().padStart(a.scale + 1, "0");
  const whole = digits.slice(0, digits.length - a.scale);
  const frac = a.scale === 0 ? "" : `.${digits.slice(digits.length - a.scale)}`;
  return `${negative ? "-" : ""}${whole}${frac}`;
}

export function format(a: Amount, symbol?: string): string {
  return symbol ? `${symbol}${toDecimal(a)}` : `${toDecimal(a)} ${a.unit}`;
}

export const isZero = (a: Amount): boolean => a.minor === 0n;
export const isNegative = (a: Amount): boolean => a.minor < 0n;
export const isPositive = (a: Amount): boolean => a.minor > 0n;
export const negate = (a: Amount): Amount => ({ ...a, minor: -a.minor });
export const abs = (a: Amount): Amount => ({ ...a, minor: a.minor < 0n ? -a.minor : a.minor });

function sameUnit(a: Amount, b: Amount): Result<true> {
  if (a.unit !== b.unit) {
    return fail(ErrorCode.UNIT_MISMATCH, `cannot combine ${a.unit} with ${b.unit}`, {
      left: a.unit,
      right: b.unit,
    });
  }
  if (a.scale !== b.scale) {
    return fail(ErrorCode.UNIT_MISMATCH, `unit ${a.unit} seen at two scales`, {
      unit: a.unit,
      scales: [a.scale, b.scale],
    });
  }
  return ok(true);
}

export function add(a: Amount, b: Amount): Result<Amount> {
  const check = sameUnit(a, b);
  return check.ok ? ok({ unit: a.unit, scale: a.scale, minor: a.minor + b.minor }) : check;
}

export function subtract(a: Amount, b: Amount): Result<Amount> {
  const check = sameUnit(a, b);
  return check.ok ? ok({ unit: a.unit, scale: a.scale, minor: a.minor - b.minor }) : check;
}

/** Sum a list. An empty list needs the unit stated, hence the explicit seed. */
export function sum(seed: Amount, amounts: readonly Amount[]): Result<Amount> {
  let acc = seed;
  for (const a of amounts) {
    const next = add(acc, a);
    if (!next.ok) return next;
    acc = next.value;
  }
  return ok(acc);
}

export function compare(a: Amount, b: Amount): Result<-1 | 0 | 1> {
  const check = sameUnit(a, b);
  if (!check.ok) return check;
  return ok(a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0);
}

export function min(a: Amount, b: Amount): Result<Amount> {
  const c = compare(a, b);
  return c.ok ? ok(c.value <= 0 ? a : b) : c;
}

export function max(a: Amount, b: Amount): Result<Amount> {
  const c = compare(a, b);
  return c.ok ? ok(c.value >= 0 ? a : b) : c;
}

/** Clamp into [lo, hi]. Used everywhere a benefit is capped. */
export function clamp(value: Amount, lo: Amount, hi: Amount): Result<Amount> {
  const lower = max(value, lo);
  if (!lower.ok) return lower;
  return min(lower.value, hi);
}

/**
 * Exact integer division with an explicit rounding mode.
 * Exported because splits, rates and conversions all funnel through it, and a
 * single implementation is a single place to audit.
 */
export function divideRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  invariant(denominator !== 0n, "division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const r = n % d;
  if (r === 0n) return negative ? -q : q;

  const twice = r * 2n;
  let magnitude: bigint;
  switch (mode) {
    case "down":
      magnitude = q;
      break;
    case "up":
      magnitude = q + 1n;
      break;
    case "floor":
      magnitude = negative ? q + 1n : q;
      break;
    case "ceiling":
      magnitude = negative ? q : q + 1n;
      break;
    case "half_up":
      magnitude = twice >= d ? q + 1n : q;
      break;
    case "half_down":
      magnitude = twice > d ? q + 1n : q;
      break;
    case "half_even":
      magnitude = twice > d || (twice === d && q % 2n === 1n) ? q + 1n : q;
      break;
  }
  return negative ? -magnitude : magnitude;
}

/** Multiply by an exact rational: the primitive behind every percentage. */
export function multiplyRate(a: Amount, rate: Rate, mode: RoundingMode = DEFAULT_ROUNDING): Amount {
  return { ...a, minor: divideRound(a.minor * rate.numerator, rate.denominator, mode) };
}

/** Percentage as an exact rational. `percent(12.5)` is 125/1000, not 0.125. */
export function percent(value: number | string): Rate {
  const text = String(value);
  const dot = text.indexOf(".");
  const decimals = dot === -1 ? 0 : text.length - dot - 1;
  const numerator = BigInt(text.replace(".", ""));
  return { numerator, denominator: 100n * 10n ** BigInt(decimals) };
}

export function rate(numerator: bigint | number, denominator: bigint | number): Rate {
  invariant(BigInt(denominator) !== 0n, "rate denominator must not be zero");
  return { numerator: BigInt(numerator), denominator: BigInt(denominator) };
}

/**
 * Split an amount into weighted parts with no value lost or created.
 * The remainder from rounding is distributed one minor unit at a time to the
 * largest weights first, so the parts always sum exactly back to the whole.
 * This is what keeps multi-party funding reconcilable to the last cent.
 */
export function allocate(a: Amount, weights: readonly bigint[]): Result<Amount[]> {
  if (weights.length === 0) {
    return fail(ErrorCode.INVALID_REQUEST, "allocate() needs at least one weight");
  }
  if (weights.some((w) => w < 0n)) {
    return fail(ErrorCode.INVALID_REQUEST, "allocate() weights must be non-negative");
  }
  const total = weights.reduce((acc, w) => acc + w, 0n);
  if (total === 0n) {
    return fail(ErrorCode.INVALID_REQUEST, "allocate() weights must not sum to zero");
  }

  const parts = weights.map((w) => divideRound(a.minor * w, total, "down"));
  let remainder = a.minor - parts.reduce((acc, p) => acc + p, 0n);

  // Hand out the remainder deterministically: largest weight first, then index.
  const order = weights
    .map((w, index) => ({ w, index }))
    .sort((x, y) => (y.w === x.w ? x.index - y.index : y.w > x.w ? 1 : -1));

  const step = remainder >= 0n ? 1n : -1n;
  let cursor = 0;
  while (remainder !== 0n && order.length > 0) {
    const slot = order[cursor % order.length] as { w: bigint; index: number };
    parts[slot.index] = (parts[slot.index] as bigint) + step;
    remainder -= step;
    cursor += 1;
  }

  return ok(parts.map((minor) => ({ unit: a.unit, scale: a.scale, minor })));
}
