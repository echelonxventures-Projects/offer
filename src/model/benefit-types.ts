/**
 * Built-in benefit types.
 *
 * Eight handlers cover the whole of the Benefit Fabric in the specification,
 * because most of the twenty-six items on that list are the same arithmetic
 * wearing a different effect. "Cashback" is `percentage` with a deferred
 * credit. "Gift card" is `flat` with a wallet credit. "Free shipping" is
 * `flat` with a fee waiver. Recognising that is the difference between eight
 * handlers and twenty-six near-duplicates that drift apart within a year.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { Json, JsonObject } from "../kernel/types.ts";
import type { CartLine } from "../context/context.ts";
import type { Amount } from "../universal/economic/amount.ts";
import {
  DEFAULT_ROUNDING,
  add,
  allocate,
  fromDecimal,
  multiplyRate,
  percent,
  subtract,
  toDecimal,
  zero,
} from "../universal/economic/amount.ts";
import type { BenefitInput, BenefitType, LineAllocation } from "./benefit.ts";

/* ----------------------------- helpers ----------------------------- */

const lineTotal = (line: CartLine): Amount => ({
  ...line.unitPrice,
  minor: line.unitPrice.minor * BigInt(line.quantity),
});

function readDecimal(params: JsonObject, key: string): Result<string> {
  const raw = params[key];
  if (typeof raw === "string") return ok(raw);
  if (typeof raw === "number") return ok(String(raw));
  return fail(ErrorCode.INVALID_REQUEST, `benefit parameter '${key}' must be a decimal string or number`);
}

function readNumber(params: JsonObject, key: string): Result<number> {
  const raw = params[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return ok(raw);
  return fail(ErrorCode.INVALID_REQUEST, `benefit parameter '${key}' must be a number`);
}

/**
 * Spread a computed value across the lines it came from, proportional to each
 * line's total. Uses the remainder-preserving allocator, so the allocations sum
 * exactly to the value and a later refund can reverse them line by line.
 */
function spread(value: Amount, lines: readonly CartLine[]): Result<LineAllocation[]> {
  if (lines.length === 0 || value.minor === 0n) return ok([]);
  const weights = lines.map((line) => {
    const total = lineTotal(line).minor;
    return total < 0n ? 0n : total;
  });
  if (weights.every((w) => w === 0n)) {
    return ok(lines.map((line) => ({ lineId: line.id, amount: { ...value, minor: 0n } })));
  }
  const parts = allocate(value, weights);
  if (!parts.ok) return parts;
  return ok(lines.map((line, index) => ({ lineId: line.id, amount: parts.value[index] as Amount })));
}

const computation = (
  input: BenefitInput,
  value: Amount,
  allocations: readonly LineAllocation[],
  detail: string,
  grant?: JsonObject,
) => ({
  benefitId: input.spec.id,
  type: input.spec.type,
  effect: input.spec.effect,
  value,
  allocations,
  detail,
  ...(grant === undefined ? {} : { grant }),
});

/* ---------------------------- handlers ----------------------------- */

const percentageBenefit: BenefitType = {
  key: "percentage",
  unitPolicy: "base",
  label: "Percentage of base",
  description: "rate% of the targeted subtotal. Serves discounts, cashback, commissions alike.",
  params: ["rate"],
  compute(input) {
    const rate = readDecimal(input.spec.params, "rate");
    if (!rate.ok) return rate;
    const value = multiplyRate(input.base, percent(rate.value), input.spec.rounding ?? DEFAULT_ROUNDING);
    const allocations = spread(value, input.lines);
    if (!allocations.ok) return allocations;
    return ok(computation(input, value, allocations.value, `${rate.value}% of ${toDecimal(input.base)} ${input.base.unit}`));
  },
};

const flatBenefit: BenefitType = {
  key: "flat",
  unitPolicy: "declared",
  label: "Flat amount",
  description: "A fixed value, never more than the base it applies to.",
  params: ["amount"],
  compute(input) {
    const decimal = readDecimal(input.spec.params, "amount");
    if (!decimal.ok) return decimal;
    const requested = fromDecimal(input.unit, decimal.value, input.scale);
    // A flat discount cannot exceed what is being discounted, or the ledger
    // would have to invent value out of nothing.
    const bounded =
      input.base.unit === requested.unit && requested.minor > input.base.minor && input.base.minor >= 0n
        ? input.base
        : requested;
    const allocations = spread(bounded, input.lines);
    if (!allocations.ok) return allocations;
    const note = bounded.minor === requested.minor ? "" : " (limited to base)";
    return ok(computation(input, bounded, allocations.value, `flat ${toDecimal(bounded)} ${bounded.unit}${note}`));
  },
};

const tieredBenefit: BenefitType = {
  key: "tiered",
  unitPolicy: "base",
  label: "Tiered by spend",
  description: "Highest tier whose threshold the base meets. Tiers are [{ min, rate | amount }].",
  params: ["tiers"],
  compute(input) {
    const tiers = input.spec.params.tiers;
    if (!Array.isArray(tiers) || tiers.length === 0) {
      return fail(ErrorCode.INVALID_REQUEST, "'tiered' needs a non-empty 'tiers' array");
    }
    let best: { min: Amount; value: Amount; label: string } | null = null;

    for (const raw of tiers as Json[]) {
      const tier = raw as JsonObject;
      const min = readDecimal(tier, "min");
      if (!min.ok) return min;
      const threshold = fromDecimal(input.base.unit, min.value, input.base.scale);
      if (input.base.minor < threshold.minor) continue;
      if (best && best.min.minor > threshold.minor) continue;

      let value: Amount;
      let label: string;
      if (tier.rate !== undefined) {
        const rate = readDecimal(tier, "rate");
        if (!rate.ok) return rate;
        value = multiplyRate(input.base, percent(rate.value), input.spec.rounding ?? DEFAULT_ROUNDING);
        label = `tier min ${min.value} at ${rate.value}%`;
      } else {
        const amountText = readDecimal(tier, "amount");
        if (!amountText.ok) return amountText;
        // A tier's flat amount is money off the base, in the base's own unit.
        value = fromDecimal(input.base.unit, amountText.value, input.base.scale);
        label = `tier min ${min.value} flat ${amountText.value}`;
      }
      best = { min: threshold, value, label };
    }

    if (!best) {
      const zeroValue = zero(input.unit, input.scale);
      return ok(computation(input, zeroValue, [], "no tier threshold met"));
    }
    const allocations = spread(best.value, input.lines);
    if (!allocations.ok) return allocations;
    return ok(computation(input, best.value, allocations.value, best.label));
  },
};

const volumeBenefit: BenefitType = {
  key: "volume",
  unitPolicy: "base",
  label: "Tiered by quantity",
  description: "Same shape as 'tiered' but thresholds are item counts. Tiers are [{ minQuantity, rate | amount }].",
  params: ["tiers"],
  compute(input) {
    const tiers = input.spec.params.tiers;
    if (!Array.isArray(tiers) || tiers.length === 0) {
      return fail(ErrorCode.INVALID_REQUEST, "'volume' needs a non-empty 'tiers' array");
    }
    const quantity = input.lines.reduce((total, line) => total + line.quantity, 0);
    let best: { min: number; value: Amount; label: string } | null = null;

    for (const raw of tiers as Json[]) {
      const tier = raw as JsonObject;
      const min = readNumber(tier, "minQuantity");
      if (!min.ok) return min;
      if (quantity < min.value) continue;
      if (best && best.min > min.value) continue;

      let value: Amount;
      let label: string;
      if (tier.rate !== undefined) {
        const rate = readDecimal(tier, "rate");
        if (!rate.ok) return rate;
        value = multiplyRate(input.base, percent(rate.value), input.spec.rounding ?? DEFAULT_ROUNDING);
        label = `${quantity} items >= ${min.value} at ${rate.value}%`;
      } else {
        const amountText = readDecimal(tier, "amount");
        if (!amountText.ok) return amountText;
        value = fromDecimal(input.base.unit, amountText.value, input.base.scale);
        label = `${quantity} items >= ${min.value} flat ${amountText.value}`;
      }
      best = { min: min.value, value, label };
    }

    if (!best) return ok(computation(input, zero(input.unit, input.scale), [], `quantity ${quantity} met no tier`));
    const allocations = spread(best.value, input.lines);
    if (!allocations.ok) return allocations;
    return ok(computation(input, best.value, allocations.value, best.label));
  },
};

const fixedPriceBenefit: BenefitType = {
  key: "fixed_price",
  unitPolicy: "base",
  label: "Fix the price",
  description: "Sets each targeted unit to a fixed price; the benefit is the difference.",
  params: ["price"],
  compute(input) {
    const priceText = readDecimal(input.spec.params, "price");
    if (!priceText.ok) return priceText;

    let total = zero(input.unit, input.scale);
    const allocations: LineAllocation[] = [];

    for (const line of input.lines) {
      const target = fromDecimal(line.unitPrice.unit, priceText.value, line.unitPrice.scale);
      const perUnit = subtract(line.unitPrice, target);
      if (!perUnit.ok) return perUnit;
      const saved = perUnit.value.minor > 0n ? perUnit.value.minor * BigInt(line.quantity) : 0n;
      const lineAmount: Amount = { unit: input.unit, scale: input.scale, minor: saved };
      allocations.push({ lineId: line.id, amount: lineAmount });
      const next = add(total, lineAmount);
      if (!next.ok) return next;
      total = next.value;
    }
    return ok(computation(input, total, allocations, `each unit priced at ${priceText.value}`));
  },
};

const freeQuantityBenefit: BenefitType = {
  key: "free_quantity",
  unitPolicy: "base",
  label: "Buy X get Y free",
  description: "For every `buy` units bought across targeted lines, `free` units are free. The cheapest units are the free ones.",
  params: ["buy", "free"],
  compute(input) {
    const buy = readNumber(input.spec.params, "buy");
    if (!buy.ok) return buy;
    const free = readNumber(input.spec.params, "free");
    if (!free.ok) return free;
    if (buy.value <= 0 || free.value <= 0) {
      return fail(ErrorCode.INVALID_REQUEST, "'free_quantity' needs positive 'buy' and 'free'");
    }

    // Expand to units so the cheapest ones can be given away, which is the
    // convention every retailer and every regulator expects.
    const units: { line: CartLine; price: bigint }[] = [];
    for (const line of input.lines) {
      for (let i = 0; i < line.quantity; i += 1) units.push({ line, price: line.unitPrice.minor });
    }
    units.sort((a, b) => (a.price === b.price ? 0 : a.price < b.price ? -1 : 1));

    const groups = Math.floor(units.length / (buy.value + free.value));
    const freeCount = Math.min(groups * free.value, units.length);

    let total = zero(input.unit, input.scale);
    const perLine = new Map<string, bigint>();
    for (let i = 0; i < freeCount; i += 1) {
      const unit = units[i] as { line: CartLine; price: bigint };
      perLine.set(unit.line.id, (perLine.get(unit.line.id) ?? 0n) + unit.price);
      const next = add(total, { unit: input.unit, scale: input.scale, minor: unit.price });
      if (!next.ok) return next;
      total = next.value;
    }

    const allocations = [...perLine].map(([lineId, minor]) => ({
      lineId,
      amount: { unit: input.unit, scale: input.scale, minor },
    }));
    return ok(
      computation(input, total, allocations, `${freeCount} unit(s) free under buy ${buy.value} get ${free.value}`),
    );
  },
};

const itemGrantBenefit: BenefitType = {
  key: "item_grant",
  unitPolicy: "declared",
  label: "Grant an item",
  description: "Adds a product or service. The value is its declared cost, which is what funding settles.",
  params: ["sku", "quantity", "value"],
  compute(input) {
    const sku = input.spec.params.sku;
    if (typeof sku !== "string") {
      return fail(ErrorCode.INVALID_REQUEST, "'item_grant' needs a 'sku'");
    }
    const quantity = typeof input.spec.params.quantity === "number" ? input.spec.params.quantity : 1;
    const valueText = input.spec.params.value;
    const unitValue =
      typeof valueText === "string" || typeof valueText === "number"
        ? fromDecimal(input.unit, String(valueText), input.scale)
        : zero(input.unit, input.scale);
    const value: Amount = { ...unitValue, minor: unitValue.minor * BigInt(quantity) };
    return ok(computation(input, value, [], `grant ${quantity} x ${sku}`, { sku, quantity }));
  },
};

const pointsAccrualBenefit: BenefitType = {
  key: "points_accrual",
  unitPolicy: "declared",
  label: "Points per unit of spend",
  description: "Earn `points` for every `per` whole units of the base. Output is denominated in the benefit's own unit.",
  params: ["points", "per"],
  compute(input) {
    const points = readNumber(input.spec.params, "points");
    if (!points.ok) return points;
    const per = readNumber(input.spec.params, "per");
    if (!per.ok) return per;
    if (per.value <= 0) return fail(ErrorCode.INVALID_REQUEST, "'points_accrual' needs a positive 'per'");

    // Whole units of the base currency, floored: nobody earns a fraction of a point.
    const wholeUnits = input.base.minor / 10n ** BigInt(input.base.scale);
    const earned = (wholeUnits / BigInt(Math.trunc(per.value))) * BigInt(Math.trunc(points.value));
    const value: Amount = { unit: input.unit, scale: input.scale, minor: earned < 0n ? 0n : earned };
    return ok(
      computation(input, value, [], `${points.value} per ${per.value} of ${toDecimal(input.base)} ${input.base.unit}`),
    );
  },
};

export const DEFAULT_BENEFIT_TYPES: BenefitType[] = [
  percentageBenefit,
  flatBenefit,
  tieredBenefit,
  volumeBenefit,
  fixedPriceBenefit,
  freeQuantityBenefit,
  itemGrantBenefit,
  pointsAccrualBenefit,
];
