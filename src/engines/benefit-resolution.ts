/**
 * Benefit Resolution Engine.
 *
 * Turns benefit *specifications* into benefit *computations*: picks the lines a
 * benefit targets, works out the base it computes against, calls the registered
 * handler, applies the cap, and classifies the result by effect.
 *
 * The one subtlety worth stating plainly: `baseOverride`. When benefits stack
 * sequentially, each one computes against what is left after the previous one,
 * and the caller passes that remaining base in. When they stack in parallel
 * (cashback that should not shrink because a discount ran first) the original
 * base is passed to all of them. Which of the two applies is a property of the
 * exchange, not of the engine - see `StackingSpec.application`.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { CartLine, ResolvedContext } from "../context/context.ts";
import type { BenefitComputation, BenefitSpec, BenefitTarget } from "../model/benefit.ts";
import type { ValueExchange } from "../model/value-exchange.ts";
import type { Amount } from "../universal/economic/amount.ts";
import { add, fromDecimal, min, zero } from "../universal/economic/amount.ts";
import { globMatch } from "../rules/compare.ts";
import type { EngineDeps } from "./deps.ts";

export interface BenefitResolution {
  readonly valueExchangeId: string;
  readonly valueExchangeVersion: number;
  readonly computations: readonly BenefitComputation[];
  /** Total that reduces what the subject pays in this interaction. */
  readonly payableReduction: Amount;
  /** Everything else granted, totalled per unit: points, credits, commissions. */
  readonly granted: readonly Amount[];
  /** Total value in the context unit, used for ranking. Excludes other units. */
  readonly rankingValue: Amount;
}

export interface BenefitResolutionInput {
  readonly exchange: ValueExchange;
  readonly context: ResolvedContext;
  /** Remaining base for sequential stacking. Defaults to the cart subtotal. */
  readonly baseOverride?: Amount;
}

export class BenefitResolutionEngine {
  readonly #deps: EngineDeps;

  constructor(deps: EngineDeps) {
    this.#deps = deps;
  }

  resolve(input: BenefitResolutionInput): Result<BenefitResolution> {
    const { exchange, context } = input;
    const contextUnit = context.economic.unit;
    const contextScale = context.economic.scale;

    const computations: BenefitComputation[] = [];
    let payableReduction = zero(contextUnit, contextScale);
    const grantedByUnit = new Map<string, Amount>();
    let rankingValue = zero(contextUnit, contextScale);

    for (const spec of exchange.benefits) {
      const handler = this.#deps.benefitTypes.require(spec.type);
      if (!handler.ok) return handler;

      const effect = this.#deps.effectKinds.require(spec.effect);
      if (!effect.ok) return effect;

      if (handler.value.allowedEffects && !handler.value.allowedEffects.includes(spec.effect)) {
        return fail(
          ErrorCode.INVALID_REQUEST,
          `benefit type '${spec.type}' may not produce effect '${spec.effect}'`,
          { type: spec.type, effect: spec.effect, allowed: handler.value.allowedEffects },
        );
      }

      // A "base" benefit computes in the interaction's unit by definition, so a
      // declared unit that disagrees is an authoring mistake. Rejecting it here
      // is the difference between "5% back in points" being refused at publish
      // time and it silently paying out 5% of the basket in dollars.
      if (handler.value.unitPolicy === "base" && spec.unit !== undefined && spec.unit !== contextUnit) {
        return fail(
          ErrorCode.INVALID_REQUEST,
          `benefit '${spec.id}' of type '${spec.type}' computes in the interaction unit '${contextUnit}', but declares '${spec.unit}'`,
          { benefit: spec.id, type: spec.type, declaredUnit: spec.unit, contextUnit, unitPolicy: "base" },
        );
      }

      const unitKey = handler.value.unitPolicy === "base" ? contextUnit : (spec.unit ?? contextUnit);
      const unit = this.#deps.economic.units.require(unitKey);
      if (!unit.ok) return unit;

      const targeted = selectLines(context.cart?.lines ?? [], spec.target);
      const base = this.#baseFor(input, spec, targeted);
      if (!base.ok) return base;

      const computed = handler.value.compute({
        spec,
        context,
        economic: this.#deps.economic,
        lines: targeted,
        base: base.value,
        unit: unitKey,
        scale: unit.value.scale,
      });
      if (!computed.ok) return computed;

      if (computed.value.value.unit !== unitKey) {
        return fail(
          ErrorCode.UNIT_MISMATCH,
          `benefit type '${spec.type}' declares unitPolicy '${handler.value.unitPolicy}' but produced '${computed.value.value.unit}' instead of '${unitKey}'`,
          { type: spec.type, expected: unitKey, produced: computed.value.value.unit },
        );
      }

      const capped = this.#applyCap(computed.value, spec, unitKey, unit.value.scale);
      if (!capped.ok) return capped;
      const computation = capped.value;
      computations.push(computation);

      if (effect.value.reducesPayable) {
        if (computation.value.unit !== contextUnit) {
          return fail(
            ErrorCode.UNIT_MISMATCH,
            `benefit '${spec.id}' reduces payable in ${computation.value.unit} but the interaction is in ${contextUnit}`,
            { benefit: spec.id, benefitUnit: computation.value.unit, contextUnit },
          );
        }
        const next = add(payableReduction, computation.value);
        if (!next.ok) return next;
        payableReduction = next.value;
      } else {
        const running = grantedByUnit.get(computation.value.unit);
        const next = running ? add(running, computation.value) : ok(computation.value);
        if (!next.ok) return next;
        grantedByUnit.set(computation.value.unit, next.value);
      }

      // Ranking counts only value expressed in the interaction's own unit.
      // Converting points to money for ranking would import an exchange rate
      // into a decision that has to be explainable without one.
      if (computation.value.unit === contextUnit) {
        const next = add(rankingValue, computation.value);
        if (!next.ok) return next;
        rankingValue = next.value;
      }
    }

    return ok({
      valueExchangeId: exchange.id,
      valueExchangeVersion: exchange.version,
      computations,
      payableReduction,
      granted: [...grantedByUnit.values()].sort((a, b) => a.unit.localeCompare(b.unit)),
      rankingValue,
    });
  }

  /** The amount a benefit computes against. */
  #baseFor(
    input: BenefitResolutionInput,
    spec: BenefitSpec,
    targeted: readonly CartLine[],
  ): Result<Amount> {
    const { context } = input;
    const unit = context.economic.unit;
    const scale = context.economic.scale;

    // An untargeted benefit computes against the whole remaining base, which is
    // what `baseOverride` carries during sequential stacking.
    if (!spec.target) {
      return ok(input.baseOverride ?? context.cart?.subtotal ?? zero(unit, scale));
    }

    let total = zero(unit, scale);
    for (const line of targeted) {
      const quantity = Math.min(line.quantity, spec.target.maxQuantityPerLine ?? line.quantity);
      const next = add(total, { ...line.unitPrice, minor: line.unitPrice.minor * BigInt(quantity) });
      if (!next.ok) return next;
      total = next.value;
    }

    // A targeted base can never exceed the remaining base, or sequential
    // stacking would let the second benefit discount money already discounted.
    if (input.baseOverride && input.baseOverride.unit === total.unit) {
      return min(total, input.baseOverride);
    }
    return ok(total);
  }

  #applyCap(
    computation: BenefitComputation,
    spec: BenefitSpec,
    unitKey: string,
    scale: number,
  ): Result<BenefitComputation> {
    if (!spec.cap) return ok(computation);
    const capUnit = spec.cap.unit ?? unitKey;
    if (capUnit !== computation.value.unit) {
      return fail(ErrorCode.UNIT_MISMATCH, `cap on benefit '${spec.id}' is in ${capUnit}, value is in ${computation.value.unit}`);
    }
    const cap = fromDecimal(capUnit, spec.cap.decimal, scale);
    if (computation.value.minor <= cap.minor) return ok(computation);

    // Re-spread the capped value so the line allocations still sum to it.
    const ratio = computation.allocations.length > 0 ? cap.minor : 0n;
    const allocations =
      computation.allocations.length === 0
        ? []
        : rescale(computation.allocations, computation.value.minor, ratio);

    return ok({
      ...computation,
      value: cap,
      allocations,
      capped: true,
      detail: `${computation.detail} (capped at ${spec.cap.decimal} ${capUnit})`,
    });
  }
}

/** Proportionally rescale allocations to a new total, preserving the sum. */
function rescale(
  allocations: readonly { lineId: string; amount: Amount }[],
  from: bigint,
  to: bigint,
): { lineId: string; amount: Amount }[] {
  if (from === 0n) return allocations.map((a) => ({ ...a, amount: { ...a.amount, minor: 0n } }));
  let assigned = 0n;
  const result = allocations.map((a, index) => {
    const isLast = index === allocations.length - 1;
    const minor = isLast ? to - assigned : (a.amount.minor * to) / from;
    assigned += minor;
    return { lineId: a.lineId, amount: { ...a.amount, minor } };
  });
  return result;
}

/** Apply a benefit's target filter to the cart. */
export function selectLines(lines: readonly CartLine[], target?: BenefitTarget): CartLine[] {
  if (!target) return [...lines];

  let matched = lines.filter((line) => {
    if (target.categories?.length && !line.categories.some((c) => target.categories!.includes(c))) return false;
    if (target.skus?.length && !target.skus.some((pattern) => globMatch(pattern, line.sku))) return false;
    if (target.merchants?.length && (!line.merchant || !target.merchants.includes(line.merchant))) return false;
    return true;
  });

  if (target.select === "cheapest") {
    matched = [...matched].sort((a, b) => Number(a.unitPrice.minor - b.unitPrice.minor));
  } else if (target.select === "most_expensive") {
    matched = [...matched].sort((a, b) => Number(b.unitPrice.minor - a.unitPrice.minor));
  }

  if (target.maxLines !== undefined) matched = matched.slice(0, target.maxLines);
  return matched;
}
