/**
 * Economic Authority.
 *
 * The single object the rest of the platform asks about value. It owns the unit
 * registries and the exchange table, and it is the only place allowed to decide
 * that two amounts are comparable. Engines never import unit tables directly.
 */
import type { Result } from "../../kernel/result.ts";
import { fail, ok } from "../../kernel/result.ts";
import { ErrorCode } from "../../kernel/errors.ts";
import type { Registry } from "../../registry/registry.ts";
import type { EconomicUnit, EconomicUnitClass } from "./unit.ts";
import { economicUnitClassRegistry, economicUnitRegistry } from "./unit.ts";
import type { Amount, RoundingMode } from "./amount.ts";
import { DEFAULT_ROUNDING, fromDecimal, format, toDecimal } from "./amount.ts";
import type { ExchangeRate } from "./exchange.ts";
import { applyRate, exchangeKey, exchangeRateRegistry, invertRate } from "./exchange.ts";

export class EconomicAuthority {
  readonly units: Registry<EconomicUnit>;
  readonly unitClasses: Registry<EconomicUnitClass>;
  readonly rates: Registry<ExchangeRate>;

  constructor(options?: {
    units?: Registry<EconomicUnit>;
    unitClasses?: Registry<EconomicUnitClass>;
    rates?: Registry<ExchangeRate>;
  }) {
    this.units = options?.units ?? economicUnitRegistry();
    this.unitClasses = options?.unitClasses ?? economicUnitClassRegistry();
    this.rates = options?.rates ?? exchangeRateRegistry();
  }

  /** Zero in a unit. Needed constantly as a fold seed. */
  zero(unitKey: string): Result<Amount> {
    const unit = this.units.require(unitKey);
    return unit.ok ? ok({ unit: unitKey, minor: 0n, scale: unit.value.scale }) : unit;
  }

  /** Build an amount from a human decimal string at the unit's own scale. */
  parse(unitKey: string, decimal: string): Result<Amount> {
    const unit = this.units.require(unitKey);
    if (!unit.ok) return unit;
    return ok(fromDecimal(unitKey, decimal, unit.value.scale));
  }

  /** Build an amount from an exact minor-unit count. */
  minor(unitKey: string, minorUnits: bigint | number): Result<Amount> {
    const unit = this.units.require(unitKey);
    if (!unit.ok) return unit;
    return ok({ unit: unitKey, minor: BigInt(minorUnits), scale: unit.value.scale });
  }

  /** Reject an amount whose scale disagrees with its registered unit. */
  validate(a: Amount): Result<Amount> {
    const unit = this.units.require(a.unit);
    if (!unit.ok) return unit;
    if (unit.value.scale !== a.scale) {
      return fail(ErrorCode.UNIT_MISMATCH, `amount in ${a.unit} has scale ${a.scale}, unit declares ${unit.value.scale}`, {
        unit: a.unit,
        amountScale: a.scale,
        unitScale: unit.value.scale,
      });
    }
    return ok(a);
  }

  classOf(unitKey: string): Result<EconomicUnitClass> {
    const unit = this.units.require(unitKey);
    if (!unit.ok) return unit;
    return this.unitClasses.require(unit.value.unitClass);
  }

  /** May this unit be moved between holders (a payout, a gift, a transfer)? */
  isTransferable(unitKey: string): boolean {
    const cls = this.classOf(unitKey);
    return cls.ok ? cls.value.transferable : false;
  }

  /** Find a direct or inverted rate. Deliberately no multi-hop routing: a
   *  chain of conversions compounds rounding and nobody can explain the result. */
  findRate(from: string, to: string): Result<ExchangeRate> {
    if (from === to) {
      return ok({ key: exchangeKey(from, to), label: "identity", from, to, rate: { numerator: 1n, denominator: 1n } });
    }
    const direct = this.rates.get(exchangeKey(from, to));
    if (direct) return ok(direct);
    const reverse = this.rates.get(exchangeKey(to, from));
    if (reverse) return ok(invertRate(reverse));
    return fail(ErrorCode.UNIT_MISMATCH, `no exchange rate from ${from} to ${to}`, { from, to });
  }

  /** Convert, recording which rate was used so the caller can audit it. */
  convert(
    a: Amount,
    toUnitKey: string,
    mode: RoundingMode = DEFAULT_ROUNDING,
  ): Result<{ amount: Amount; rate: ExchangeRate }> {
    const target = this.units.require(toUnitKey);
    if (!target.ok) return target;

    const source = this.units.require(a.unit);
    if (!source.ok) return source;

    const sourceClass = this.classOf(a.unit);
    if (!sourceClass.ok) return sourceClass;
    if (a.unit !== toUnitKey && !sourceClass.value.exchangeable) {
      return fail(ErrorCode.UNIT_MISMATCH, `unit ${a.unit} is not exchangeable`, {
        unit: a.unit,
        unitClass: source.value.unitClass,
      });
    }

    const found = this.findRate(a.unit, toUnitKey);
    if (!found.ok) return found;

    return ok({
      amount: applyRate(a, { unit: toUnitKey, scale: target.value.scale }, found.value.rate, mode),
      rate: found.value,
    });
  }

  /** Display an amount using its registered symbol. */
  display(a: Amount): string {
    const unit = this.units.get(a.unit);
    return unit?.symbol ? format(a, unit.symbol) : `${toDecimal(a)} ${a.unit}`;
  }
}
