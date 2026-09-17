/**
 * Executions.
 *
 * A decision is advisory: it says what would happen. An execution is what did
 * happen, and it is the object finance, support and audit actually care about.
 *
 * Executions are two-phase on purpose. `reserved` commits budget and consumes
 * limits without paying anything, which is what a checkout needs between
 * showing a price and taking the money. `captured` is the point of no return.
 * Anything that fails between the two releases cleanly.
 */
import type { JsonObject } from "../kernel/types.ts";
import type { Amount } from "../universal/economic/amount.ts";
import type { FundingAllocation } from "./funding.ts";
import type { LineAllocation } from "./benefit.ts";

export const EXECUTION_STATES = ["reserved", "captured", "released", "reversed", "settled"] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export interface ExecutedBenefit {
  readonly valueExchangeId: string;
  readonly valueExchangeVersion: number;
  readonly benefitId: string;
  readonly type: string;
  readonly effect: string;
  readonly value: Amount;
  readonly allocations: readonly LineAllocation[];
  readonly funding: readonly FundingAllocation[];
  /** For deferred effects: when the liability matures. */
  readonly maturesAt?: string;
  readonly grant?: JsonObject;
}

export interface Execution {
  readonly id: string;
  readonly tenant: string;
  readonly reality: string;
  readonly decisionId: string;
  readonly subjectId?: string;
  readonly state: ExecutionState;
  /** Caller-supplied key that makes `apply` safely repeatable. */
  readonly idempotencyKey?: string;
  readonly benefits: readonly ExecutedBenefit[];
  /** Total value that reduced what the subject pays now. */
  readonly payableReduction: Amount;
  /** Totals per unit for everything else granted (points, credits, items). */
  readonly grantedTotals: readonly Amount[];
  readonly createdAt: string;
  readonly capturedAt?: string;
  readonly releasedAt?: string;
  readonly reversedAt?: string;
  readonly settledAt?: string;
  readonly metadata: JsonObject;
}
