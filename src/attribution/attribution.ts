/**
 * Attribution.
 *
 * Who gets the credit when a value exchange is redeemed. Touchpoints are
 * recorded as they happen; a model divides the credit when the conversion
 * lands. The models are registry entries because attribution is a commercial
 * argument, not a technical fact, and every partner in the chain will want a
 * different one.
 *
 * Credit is divided with the remainder-preserving allocator, so the shares sum
 * exactly to 100% - an attribution report whose columns do not add up is the
 * fastest way to lose a partner's trust.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { RegistryEntry, Registry } from "../registry/registry.ts";
import { Registry as RegistryClass } from "../registry/registry.ts";
import type { Amount } from "../universal/economic/amount.ts";
import { allocate } from "../universal/economic/amount.ts";
import type { PartyRef } from "../model/funding.ts";
import type { Touchpoint } from "./touchpoint.ts";
import type { TouchpointStore } from "../adapters/store.ts";

export * from "./touchpoint.ts";


export interface AttributionShare {
  readonly party: PartyRef;
  readonly touchpointId: string;
  /** Weight in parts per ten thousand, so 2500 means 25%. */
  readonly basisPoints: number;
  /** Credited value, when a value was supplied. Shares sum exactly to it. */
  readonly amount?: Amount;
}

export interface AttributionInput {
  /** Touchpoints in ascending time order, already filtered by lookback. */
  readonly touchpoints: readonly Touchpoint[];
  readonly value?: Amount;
}

export interface AttributionModel extends RegistryEntry {
  /** Returns one weight per touchpoint, in the same order. Need not be normalised. */
  weigh(input: AttributionInput): Result<number[]>;
}

export const DEFAULT_ATTRIBUTION_MODELS: AttributionModel[] = [
  {
    key: "last_touch",
    label: "Last touch",
    description: "All credit to the final touchpoint. The default nearly everywhere, and the crudest.",
    weigh: ({ touchpoints }) => ok(touchpoints.map((_, i) => (i === touchpoints.length - 1 ? 1 : 0))),
  },
  {
    key: "first_touch",
    label: "First touch",
    description: "All credit to the touchpoint that started the journey.",
    weigh: ({ touchpoints }) => ok(touchpoints.map((_, i) => (i === 0 ? 1 : 0))),
  },
  {
    key: "linear",
    label: "Linear",
    description: "Credit divided equally across every touchpoint.",
    weigh: ({ touchpoints }) => ok(touchpoints.map(() => 1)),
  },
  {
    key: "position_based",
    label: "Position based (40/20/40)",
    description: "40% first, 40% last, 20% divided among the middle.",
    weigh: ({ touchpoints }) => {
      const n = touchpoints.length;
      if (n === 0) return ok([]);
      if (n === 1) return ok([1]);
      if (n === 2) return ok([1, 1]);
      const middle = 20 / (n - 2);
      return ok(touchpoints.map((_, i) => (i === 0 || i === n - 1 ? 40 : middle)));
    },
  },
  {
    key: "time_decay",
    label: "Time decay",
    description: "Later touches weigh more, halving every step back through the journey.",
    weigh: ({ touchpoints }) => {
      const n = touchpoints.length;
      return ok(touchpoints.map((_, i) => 2 ** (i - (n - 1))));
    },
  },
];

export function attributionModelRegistry(): Registry<AttributionModel> {
  return new RegistryClass<AttributionModel>("attribution-model").registerAll(DEFAULT_ATTRIBUTION_MODELS);
}

export class AttributionEngine {
  readonly models: Registry<AttributionModel>;
  readonly #store: TouchpointStore;

  constructor(models: Registry<AttributionModel>, store: TouchpointStore) {
    this.models = models;
    this.#store = store;
  }

  async record(touchpoint: Touchpoint): Promise<Result<Touchpoint>> {
    return this.#store.append(touchpoint);
  }

  /** Touchpoints for a subject or device, oldest first, within the lookback. */
  async journey(params: {
    tenant: string;
    subjectId?: string;
    deviceId?: string;
    valueExchangeId?: string;
    nowTick: bigint;
    lookbackSeconds?: number;
  }): Promise<Result<Touchpoint[]>> {
    const since =
      params.lookbackSeconds === undefined
        ? undefined
        : (params.nowTick - BigInt(params.lookbackSeconds) * 1000n).toString();

    return this.#store.journey({
      tenant: params.tenant,
      ...(params.subjectId === undefined ? {} : { subjectId: params.subjectId }),
      ...(params.deviceId === undefined ? {} : { deviceId: params.deviceId }),
      ...(params.valueExchangeId === undefined ? {} : { valueExchangeId: params.valueExchangeId }),
      ...(since === undefined ? {} : { since }),
    });
  }

  /**
   * Divide credit, and value if given, across a journey.
   *
   * Pure: it takes the touchpoints rather than fetching them, so the division
   * is reproducible from a recorded journey and can be covered by conformance
   * vectors without a store.
   */
  attribute(modelKey: string, input: AttributionInput): Result<AttributionShare[]> {
    const model = this.models.require(modelKey);
    if (!model.ok) return model;
    if (input.touchpoints.length === 0) return ok([]);

    const weights = model.value.weigh(input);
    if (!weights.ok) return weights;
    if (weights.value.length !== input.touchpoints.length) {
      return fail(ErrorCode.INVALID_REQUEST, `attribution model '${modelKey}' returned the wrong number of weights`);
    }

    // Scale to integers before dividing, so the split is exact.
    const scaled = weights.value.map((w) => BigInt(Math.max(0, Math.round(w * 1_000_000))));
    const total = scaled.reduce((sum, w) => sum + w, 0n);
    if (total === 0n) {
      return fail(ErrorCode.INVALID_REQUEST, `attribution model '${modelKey}' gave every touchpoint zero weight`);
    }

    const basisPoints = splitBasisPoints(scaled, total);
    let amounts: Amount[] | null = null;
    if (input.value) {
      const split = allocate(input.value, scaled);
      if (!split.ok) return split;
      amounts = split.value;
    }

    return ok(
      input.touchpoints.map((touchpoint, index) => ({
        party: touchpoint.party,
        touchpointId: touchpoint.id,
        basisPoints: basisPoints[index] as number,
        ...(amounts === null ? {} : { amount: amounts[index] as Amount }),
      })),
    );
  }
}

/** Divide 10 000 basis points by weight, with the remainder to the largest. */
function splitBasisPoints(weights: readonly bigint[], total: bigint): number[] {
  const raw = weights.map((w) => Number((w * 10_000n) / total));
  const assigned = raw.reduce((sum, v) => sum + v, 0);
  let remainder = 10_000 - assigned;
  const order = weights
    .map((w, index) => ({ w, index }))
    .sort((a, b) => (a.w === b.w ? a.index - b.index : b.w > a.w ? 1 : -1));
  let cursor = 0;
  while (remainder > 0 && order.length > 0) {
    const slot = order[cursor % order.length] as { index: number };
    raw[slot.index] = (raw[slot.index] as number) + 1;
    remainder -= 1;
    cursor += 1;
  }
  return raw;
}
