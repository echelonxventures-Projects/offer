/**
 * Exchange between economic units.
 *
 * A rate is an exact rational plus the instant it was observed. Conversions are
 * never implicit: a benefit denominated in POINTS does not silently become USD
 * because a settlement wants cash. Somebody has to ask, and the answer is
 * recorded with the rate that was used, which is what makes the settlement
 * defensible months later.
 */
import type { RegistryEntry } from "../../registry/registry.ts";
import { Registry } from "../../registry/registry.ts";
import type { Amount, Rate, RoundingMode } from "./amount.ts";
import { DEFAULT_ROUNDING, divideRound } from "./amount.ts";

export interface ExchangeRate extends RegistryEntry {
  /** Source unit key. */
  readonly from: string;
  /** Target unit key. */
  readonly to: string;
  /** Exact rational: 1 `from` minor unit equals rate `to` minor units. */
  readonly rate: Rate;
  /** Opaque instant token from the temporal authority; provenance for audit. */
  readonly observedAt?: string;
  /** Who published this rate. */
  readonly source?: string;
}

export const exchangeKey = (from: string, to: string): string => `${from}->${to}`;

export function exchangeRateRegistry(): Registry<ExchangeRate> {
  return new Registry<ExchangeRate>("exchange-rate", { strict: false });
}

export function defineRate(params: {
  from: string;
  to: string;
  numerator: bigint | number;
  denominator: bigint | number;
  observedAt?: string;
  source?: string;
}): ExchangeRate {
  const { from, to, numerator, denominator } = params;
  return {
    key: exchangeKey(from, to),
    label: `${from} to ${to}`,
    from,
    to,
    rate: { numerator: BigInt(numerator), denominator: BigInt(denominator) },
    ...(params.observedAt === undefined ? {} : { observedAt: params.observedAt }),
    ...(params.source === undefined ? {} : { source: params.source }),
  };
}

/** Apply a rate to an amount, producing the target unit at the target scale. */
export function applyRate(
  a: Amount,
  target: { unit: string; scale: number },
  r: Rate,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Amount {
  // Scale correction keeps the conversion exact when the two units disagree on
  // how many decimal places they store.
  const scaleShift = target.scale - a.scale;
  const numerator =
    scaleShift >= 0 ? a.minor * r.numerator * 10n ** BigInt(scaleShift) : a.minor * r.numerator;
  const denominator = scaleShift >= 0 ? r.denominator : r.denominator * 10n ** BigInt(-scaleShift);
  return { unit: target.unit, scale: target.scale, minor: divideRound(numerator, denominator, mode) };
}

/** Invert a rate so a registry only has to publish one direction. */
export function invertRate(r: ExchangeRate): ExchangeRate {
  return {
    ...r,
    key: exchangeKey(r.to, r.from),
    label: `${r.to} to ${r.from}`,
    from: r.to,
    to: r.from,
    rate: { numerator: r.rate.denominator, denominator: r.rate.numerator },
  };
}
