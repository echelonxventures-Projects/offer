/**
 * Execution Engine.
 *
 * Turns a decision into a commitment, in two phases.
 *
 *   reserve - consume limits, hold budget, write nothing to the ledger
 *   capture - post the ledger entries and convert the hold into spend
 *
 * Limits are consumed at reserve, not at capture. That is the whole point: the
 * window between quoting a price and taking the money is exactly where a
 * last-of-stock coupon gets redeemed twice, and a reservation closes it.
 *
 * Phase 1 moved every mutation inside `store.transaction`. Before that, a
 * failure partway through reserve could leave budget held against an execution
 * that was never written, and a crash partway through capture could leave
 * ledger entries with no execution - the worst outcome this platform can
 * produce. Both are now all-or-nothing.
 *
 * Limits and budgets are taken through the store's conditional operations
 * (`tryConsume`, `tryReserve`), never by reading a value and writing it back.
 * The engine no longer has the option of getting that wrong.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { JsonObject } from "../kernel/types.ts";
import type { ResolvedContext } from "../context/context.ts";
import type { Execution, ExecutedBenefit } from "../model/execution.ts";
import type { FundingSource, PartyRef } from "../model/funding.ts";
import type { Amount } from "../universal/economic/amount.ts";
import { add, zero } from "../universal/economic/amount.ts";
import type { LedgerEntry } from "../ledger/ledger.ts";
import { allocateFunding, postBenefit, reverseEntries } from "../ledger/settlement.ts";
import type { PlatformStore } from "../adapters/store.ts";
import type { EngineDeps } from "./deps.ts";
import { METRICS } from "../observability/metrics.ts";
import type { Decision } from "./decision.ts";

export interface ReserveInput {
  readonly decision: Decision;
  readonly context: ResolvedContext;
  /**
   * Who performed this, as distinct from who it was for.
   *
   * The audit record's `actor` is the caller - a checkout service, an operator -
   * and the subject goes in the payload. Recording the subject as the actor
   * conflates "who did this" with "who benefited", which is exactly the
   * question an investigation needs separated.
   */
  readonly actor?: string;
  /** Makes the reservation safely repeatable. Strongly recommended. */
  readonly idempotencyKey?: string;
  readonly metadata?: JsonObject;
}

/**
 * What capture, release and reverse actually need from a context.
 *
 * `ResolvedContext` satisfies this structurally, so existing callers are
 * unchanged - but an operational job like the reservation reaper can act on an
 * execution without inventing a cart and a subject it does not have.
 */
export interface OperationContext {
  readonly tenant: string;
  readonly instant: ResolvedContext["instant"];
  readonly correlationId?: string;
}

export interface CaptureResult {
  readonly execution: Execution;
  readonly entries: readonly LedgerEntry[];
}

export class ExecutionEngine {
  readonly #deps: EngineDeps;

  constructor(deps: EngineDeps) {
    this.#deps = deps;
  }

  /* ==================== reserve ==================== */

  async reserve(input: ReserveInput): Promise<Result<Execution>> {
    const { decision, context } = input;

    const reality = this.#deps.realities.require(context.reality);
    if (!reality.ok) return reality;

    if (decision.applied.length === 0) {
      return fail(ErrorCode.INVALID_REQUEST, "cannot reserve a decision that applied nothing", {
        decisionId: decision.id,
      });
    }

    // Fast path outside the transaction. Re-checked inside it, because two
    // concurrent retries of the same key can both miss here.
    if (input.idempotencyKey) {
      const existing = await this.#deps.store.executions.byIdempotencyKey(context.tenant, input.idempotencyKey);
      if (!existing.ok) return existing;
      if (existing.value) return ok(existing.value);
    }

    const at = context.instant.tick.toString();
    const atSeconds = Number(context.instant.tick) / 1000;
    const telemetry = this.#deps.telemetry;
    const stop = telemetry.timer(METRICS.reserveDuration, { tenant: context.tenant });

    const reserved = await this.#deps.store.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.executions.byIdempotencyKey(context.tenant, input.idempotencyKey);
        if (!existing.ok) return existing;
        if (existing.value) return ok(existing.value);
      }

      // 1. Limits first: cheaper to fail, and it is the check that protects
      //    against overselling. One atomic consume per applied exchange.
      for (const applied of decision.applied) {
        const exchange = await tx.exchanges.get(context.tenant, applied.valueExchangeId);
        if (!exchange.ok) return exchange;

        const granted = applied.resolution.computations.map((c) => c.value);
        const consumed = await tx.counters.tryConsume({
          tenant: context.tenant,
          valueExchangeId: applied.valueExchangeId,
          ...(context.subject.id === undefined ? {} : { subjectId: context.subject.id }),
          atSeconds,
          limits: exchange.value.limits,
          granted,
        });
        if (!consumed.ok) return consumed;
      }

      // 2. Funding: allocate against live headroom, then hold atomically.
      const benefits = await this.#allocateAndHold(tx, decision, context);
      if (!benefits.ok) return benefits;

      // 3. The execution record itself.
      const grantedTotals = totalByUnit(
        benefits.value.filter((b) => !this.#reducesPayable(b)).map((b) => b.value),
      );
      if (!grantedTotals.ok) return grantedTotals;

      const execution: Execution = {
        id: this.#deps.ids.next("exe"),
        tenant: context.tenant,
        reality: context.reality,
        decisionId: decision.id,
        ...(context.subject.id === undefined ? {} : { subjectId: context.subject.id }),
        state: "reserved",
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        benefits: benefits.value,
        payableReduction: decision.payableReduction,
        grantedTotals: grantedTotals.value,
        createdAt: at,
        metadata: input.metadata ?? {},
      };

      const stored = await tx.executions.put(execution);
      if (!stored.ok) return stored;

      const audited = await tx.audit.append({
        tenant: context.tenant,
        reality: context.reality,
        kind: "execution.reserved",
        subject: { kind: "execution", id: execution.id },
        actor: input.actor ?? "anonymous",
        at,
        correlationId: context.correlationId,
        payload: {
          decisionId: decision.id,
          decisionHash: decision.hash,
          bundle: decision.bundle,
          benefits: benefits.value.length,
          payableReduction: decision.payableReduction.minor.toString(),
          ...(context.subject.id === undefined ? {} : { subjectId: context.subject.id }),
        },
      });
      if (!audited.ok) return audited;

      return ok(execution);
    });

    stop();
    if (reserved.ok) {
      telemetry.count(METRICS.executionReserved, 1, { tenant: context.tenant });
    } else if (reserved.error.code === "LIMIT_EXCEEDED") {
      const limit = typeof reserved.error.details?.limit === "string" ? reserved.error.details.limit : "unknown";
      telemetry.count(METRICS.limitExceeded, 1, { tenant: context.tenant, limit });
    } else if (reserved.error.code === "INSUFFICIENT_FUNDS") {
      // Two paths produce this: the allocator, which names every source it
      // tried, and tryReserve, which names the one that refused.
      const details = reserved.error.details ?? {};
      const listed = Array.isArray(details.sources) ? details.sources[0] : undefined;
      const source =
        typeof details.sourceId === "string"
          ? details.sourceId
          : typeof listed === "string"
            ? listed
            : "unknown";
      telemetry.count(METRICS.fundingInsufficient, 1, { tenant: context.tenant, source });
      // Customers are being refused a price they may already have been shown.
      telemetry.event({
        name: METRICS.fundingInsufficient,
        severity: "error",
        message: `funding source '${source}' cannot cover a benefit; the campaign is refusing customers`,
        labels: { tenant: context.tenant },
        data: { ...reserved.error.details },
      });
    }
    return reserved;
  }

  /**
   * Allocate each benefit's cost across funders and hold it.
   *
   * The local `sources` map is refreshed from each successful hold, so a second
   * benefit's allocation sees the headroom the first one just consumed. Without
   * that, two benefits funded from the same source could each be allocated the
   * full remaining budget.
   */
  async #allocateAndHold(
    tx: PlatformStore,
    decision: Decision,
    context: ResolvedContext,
  ): Promise<Result<ExecutedBenefit[]>> {
    const listed = await tx.funding.list(context.tenant);
    if (!listed.ok) return listed;
    const sources = new Map<string, FundingSource>(listed.value.map((s) => [s.id, s]));

    const benefits: ExecutedBenefit[] = [];

    for (const applied of decision.applied) {
      const exchange = await tx.exchanges.get(context.tenant, applied.valueExchangeId);
      if (!exchange.ok) return exchange;

      const model = this.#deps.fundingModels.require(exchange.value.funding.model);
      if (!model.ok) return model;

      for (const computation of applied.resolution.computations) {
        if (computation.value.minor === 0n) continue;

        const allocations = allocateFunding({
          cost: computation.value,
          spec: exchange.value.funding,
          sources,
          model: model.value,
        });
        if (!allocations.ok) return allocations;

        for (const allocation of allocations.value) {
          if (allocation.amount.minor === 0n) continue;
          const held = await tx.funding.tryReserve(context.tenant, allocation.sourceId, allocation.amount);
          if (!held.ok) return held;
          sources.set(allocation.sourceId, held.value);
        }

        const maturity = exchange.value.benefits.find((b) => b.id === computation.benefitId)?.maturitySeconds;
        benefits.push({
          valueExchangeId: applied.valueExchangeId,
          valueExchangeVersion: applied.valueExchangeVersion,
          benefitId: computation.benefitId,
          type: computation.type,
          effect: computation.effect,
          value: computation.value,
          allocations: computation.allocations,
          funding: allocations.value,
          ...(maturity === undefined
            ? {}
            : { maturesAt: (context.instant.tick + BigInt(maturity) * 1000n).toString() }),
          ...(computation.grant === undefined ? {} : { grant: computation.grant }),
        });
      }
    }

    return ok(benefits);
  }

  /* ==================== capture ==================== */

  async capture(
    tenant: string,
    executionId: string,
    context: OperationContext,
    payee?: PartyRef,
    actor?: string,
  ): Promise<Result<CaptureResult>> {
    const at = context.instant.tick.toString();
    const telemetry = this.#deps.telemetry;
    const stop = telemetry.timer(METRICS.captureDuration, { tenant });

    const captured = await this.#deps.store.transaction(async (tx) => {
      const found = await tx.executions.get(tenant, executionId);
      if (!found.ok) return found;
      const execution = found.value;

      if (execution.state === "captured") {
        const entries = await tx.ledger.byReference(tenant, execution.id);
        if (!entries.ok) return entries;
        return ok({ execution, entries: entries.value });
      }
      if (execution.state !== "reserved") {
        return fail(ErrorCode.ILLEGAL_STATE, `execution '${executionId}' is '${execution.state}', not 'reserved'`);
      }

      const reality = this.#deps.realities.require(execution.reality);
      if (!reality.ok) return reality;

      const transactionId = this.#deps.ids.next("txn");
      const entries: LedgerEntry[] = [];

      for (const benefit of execution.benefits) {
        const effect = this.#deps.effectKinds.require(benefit.effect);
        if (!effect.ok) return effect;

        const posted = postBenefit({
          tenant,
          reality: execution.reality,
          at,
          transactionId,
          reference: { kind: "execution", id: execution.id },
          effect: effect.value,
          value: benefit.value,
          funding: benefit.funding,
          ...(execution.subjectId === undefined ? {} : { subjectId: execution.subjectId }),
          ...(payee === undefined ? {} : { payee }),
          ids: this.#deps.ids,
          postingRules: this.#deps.postingRules,
          accounts: this.#deps.accounts,
        });
        if (!posted.ok) return posted;
        entries.push(...posted.value);

        for (const allocation of benefit.funding) {
          if (allocation.amount.minor === 0n) continue;
          const captured = await tx.funding.captureReserved(tenant, allocation.sourceId, allocation.amount);
          if (!captured.ok) return captured;
        }
      }

      // A non-binding reality runs every computation and posts nothing. That is
      // what makes a simulation trustworthy: it is the same code path.
      if (reality.value.effectsAreBinding && entries.length > 0) {
        const appended = await tx.ledger.append(entries);
        if (!appended.ok) return appended;
      }

      const captured: Execution = { ...execution, state: "captured", capturedAt: at };
      const stored = await tx.executions.put(captured);
      if (!stored.ok) return stored;

      const audited = await tx.audit.append({
        tenant,
        reality: execution.reality,
        kind: "execution.captured",
        subject: { kind: "execution", id: execution.id },
        actor: actor ?? "system",
        at,
        correlationId: context.correlationId,
        payload: {
          entries: entries.length,
          binding: reality.value.effectsAreBinding,
          transactionId,
          ...(execution.subjectId === undefined ? {} : { subjectId: execution.subjectId }),
        },
      });
      if (!audited.ok) return audited;

      return ok({ execution: captured, entries });
    });

    stop();
    if (captured.ok) telemetry.count(METRICS.executionCaptured, 1, { tenant });
    return captured;
  }

  /* ==================== release ==================== */

  /** Give back the holds and the consumed limits. */
  async release(
    tenant: string,
    executionId: string,
    context: OperationContext,
    reason = "released before capture",
    actor?: string,
  ): Promise<Result<Execution>> {
    const at = context.instant.tick.toString();

    return this.#deps.store.transaction(async (tx) => {
      const found = await tx.executions.get(tenant, executionId);
      if (!found.ok) return found;
      const execution = found.value;

      if (execution.state !== "reserved") {
        return fail(
          ErrorCode.ILLEGAL_STATE,
          `only a reserved execution can be released; '${executionId}' is '${execution.state}'`,
        );
      }

      for (const benefit of execution.benefits) {
        for (const allocation of benefit.funding) {
          if (allocation.amount.minor === 0n) continue;
          const released = await tx.funding.releaseReservation(tenant, allocation.sourceId, allocation.amount);
          if (!released.ok) return released;
        }
      }

      const restored = await this.#restoreLimits(tx, execution, context);
      if (!restored.ok) return restored;

      const released: Execution = { ...execution, state: "released", releasedAt: at };
      const stored = await tx.executions.put(released);
      if (!stored.ok) return stored;

      this.#deps.telemetry.count(METRICS.executionReleased, 1, {
        tenant,
        reason: reason.startsWith("reaped") ? "reaped" : "explicit",
      });
      if (reason.startsWith("reaped")) {
        this.#deps.telemetry.count(METRICS.executionReaped, 1, { tenant });
      }

      const audited = await tx.audit.append({
        tenant,
        reality: execution.reality,
        kind: "execution.released",
        subject: { kind: "execution", id: execution.id },
        actor: actor ?? "system",
        at,
        correlationId: context.correlationId,
        payload: { reason },
      });
      if (!audited.ok) return audited;

      return ok(released);
    });
  }

  /* ==================== reverse ==================== */

  /** Reverse a captured execution: contra entries, spend restored, limits freed. */
  async reverse(
    tenant: string,
    executionId: string,
    context: OperationContext,
    reason: string,
    actor?: string,
  ): Promise<Result<CaptureResult>> {
    const at = context.instant.tick.toString();

    return this.#deps.store.transaction(async (tx) => {
      const found = await tx.executions.get(tenant, executionId);
      if (!found.ok) return found;
      const execution = found.value;

      if (execution.state !== "captured" && execution.state !== "settled") {
        return fail(
          ErrorCode.ILLEGAL_STATE,
          `only a captured execution can be reversed; '${executionId}' is '${execution.state}'`,
        );
      }

      const existing = await tx.ledger.byReference(tenant, execution.id);
      if (!existing.ok) return existing;
      const original = existing.value.filter((e) => !e.memo?.startsWith("reversal of"));

      const transactionId = this.#deps.ids.next("txn");
      const contra = reverseEntries(original, transactionId, at, { kind: "reversal", id: execution.id }, this.#deps.ids);

      if (contra.length > 0) {
        const appended = await tx.ledger.append(contra);
        if (!appended.ok) return appended;
      }

      for (const benefit of execution.benefits) {
        for (const allocation of benefit.funding) {
          if (allocation.amount.minor === 0n) continue;
          const restored = await tx.funding.restoreSpend(tenant, allocation.sourceId, allocation.amount);
          if (!restored.ok) return restored;
        }
      }

      const restoredLimits = await this.#restoreLimits(tx, execution, context);
      if (!restoredLimits.ok) return restoredLimits;

      const reversed: Execution = { ...execution, state: "reversed", reversedAt: at };
      const stored = await tx.executions.put(reversed);
      if (!stored.ok) return stored;

      this.#deps.telemetry.count(METRICS.executionReversed, 1, { tenant });

      const audited = await tx.audit.append({
        tenant,
        reality: execution.reality,
        kind: "execution.reversed",
        subject: { kind: "execution", id: execution.id },
        actor: actor ?? "system",
        at,
        correlationId: context.correlationId,
        payload: { reason, entries: contra.length },
      });
      if (!audited.ok) return audited;

      return ok({ execution: reversed, entries: contra });
    });
  }

  /* ==================== internals ==================== */

  #reducesPayable(benefit: ExecutedBenefit): boolean {
    return this.#deps.effectKinds.get(benefit.effect)?.reducesPayable ?? false;
  }

  /** Give back one redemption per exchange this execution touched. */
  async #restoreLimits(
    tx: PlatformStore,
    execution: Execution,
    context: OperationContext,
  ): Promise<Result<void>> {
    const atSeconds = Number(context.instant.tick) / 1000;
    const byExchange = new Map<string, Amount[]>();
    for (const benefit of execution.benefits) {
      const running = byExchange.get(benefit.valueExchangeId) ?? [];
      running.push(benefit.value);
      byExchange.set(benefit.valueExchangeId, running);
    }

    for (const [valueExchangeId, granted] of byExchange) {
      const restored = await tx.counters.restore({
        tenant: execution.tenant,
        valueExchangeId,
        ...(execution.subjectId === undefined ? {} : { subjectId: execution.subjectId }),
        atSeconds,
        granted,
      });
      if (!restored.ok) return restored;
    }
    return ok(undefined);
  }
}

function totalByUnit(amounts: readonly Amount[]): Result<Amount[]> {
  const byUnit = new Map<string, Amount>();
  for (const amount of amounts) {
    const running = byUnit.get(amount.unit) ?? zero(amount.unit, amount.scale);
    const next = add(running, amount);
    if (!next.ok) return next;
    byUnit.set(amount.unit, next.value);
  }
  return ok([...byUnit.values()].sort((a, b) => a.unit.localeCompare(b.unit)));
}
