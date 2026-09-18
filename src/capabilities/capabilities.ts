/**
 * The Universal Capability Layer.
 *
 * This is the only surface a consumer touches. Twenty-two verbs, all of them
 * phrased in terms of a value exchange. Search this file for "coupon",
 * "cashback" or "gift card" and you will not find them, because a caller never
 * needs to know which of those it is holding.
 *
 * Every method takes a `ContextRequest` rather than a pre-resolved context, so
 * a caller never has to know how context is assembled either. The resolution
 * cost is real, and `withContext` exists for callers that want to resolve once
 * and then ask several questions.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { JsonObject } from "../kernel/types.ts";
import type { ContextRequest, ResolvedContext } from "../context/context.ts";
import type { Grant, ValueExchange, ValueExchangeDraft } from "../model/value-exchange.ts";
import type { LifecycleState } from "../model/lifecycle.ts";
import { routeBetween } from "../model/lifecycle.ts";
import type { FundingSource } from "../model/funding.ts";
import type { Execution } from "../model/execution.ts";
import type { Amount } from "../universal/economic/amount.ts";
import { add, fromDecimal, zero } from "../universal/economic/amount.ts";
import type { Decision } from "../engines/decision.ts";
import type { DiscoveredExchange } from "../engines/discovery.ts";
import type { PolicyReport } from "../engines/governance.ts";
import type { RiskAssessment } from "../engines/risk.ts";
import type { AttributionShare } from "../attribution/attribution.ts";
import type { Touchpoint, TouchpointKind } from "../attribution/touchpoint.ts";
import type { AuditRecord } from "../audit/audit-log.ts";
import type { AccountPosition } from "../ledger/payout.ts";
import { reconcile, requestPayout, verifyLedger } from "../ledger/payout.ts";
import { availableOf } from "../ledger/settlement.ts";
import type { LedgerEntry } from "../ledger/ledger.ts";
import type { PartyRef } from "../model/funding.ts";
import { cloneValueExchange, createValueExchange } from "../platform/factory.ts";
import type { CapabilityDescriptor } from "./descriptors.ts";
import { capabilityRegistry } from "./descriptors.ts";
import type { GoipPlatform } from "../platform/platform.ts";

export interface ActorContext {
  readonly tenant: string;
  /** Who is invoking. Recorded on every audit record. */
  readonly actor: string;
}

export interface CreateRequest extends ActorContext {
  readonly draft: ValueExchangeDraft;
  readonly id?: string;
}

export interface ApplyRequest {
  readonly context: ContextRequest;
  readonly codes?: readonly string[];
  readonly candidateIds?: readonly string[];
  readonly objective?: string;
  /** Assess risk before deciding, and refuse if the disposition is 'block'. */
  readonly assessRisk?: boolean;
}

export interface RedeemRequest extends ApplyRequest {
  readonly actor: string;
  readonly idempotencyKey?: string;
  readonly payee?: PartyRef;
  readonly metadata?: JsonObject;
}

export interface QuoteResult {
  readonly decision: Decision;
  readonly context: ResolvedContext;
  readonly risk?: RiskAssessment;
}

export interface RedeemResult extends QuoteResult {
  readonly execution: Execution;
  readonly entries: readonly LedgerEntry[];
}

export interface ForecastResult {
  readonly sourceId: string;
  readonly unit: string;
  readonly budget?: Amount;
  readonly committed: Amount;
  readonly available?: Amount;
  /** Fraction of the budget already committed, 0-100, or null if uncapped. */
  readonly utilisationPercent: number | null;
  /** Redemptions left at the current average benefit, or null if unknowable. */
  readonly projectedRemainingRedemptions: number | null;
}

export class Capabilities {
  readonly #platform: GoipPlatform;
  readonly descriptors = capabilityRegistry();

  constructor(platform: GoipPlatform) {
    this.#platform = platform;
  }

  /** Enumerate the surface. Used by the API layer and by the docs generator. */
  list(): CapabilityDescriptor[] {
    return this.descriptors.list();
  }

  /* ==================== author ==================== */

  async create(request: CreateRequest): Promise<Result<ValueExchange>> {
    const at = this.#now();
    if (!at.ok) return at;

    const profile = this.#platform.deps.profiles.require(request.draft.profile);
    if (!profile.ok) return profile;

    const exchange = createValueExchange({
      tenant: request.tenant,
      draft: request.draft,
      actor: request.actor,
      at: at.value,
      ids: this.#platform.ids,
      ...(request.id === undefined ? {} : { id: request.id }),
    });

    const stored = await this.#platform.store.exchanges.put(exchange);
    if (!stored.ok) return stored;

    const audited = await this.#platform.store.audit.append({
      tenant: request.tenant,
      reality: "production",
      kind: "value_exchange.created",
      subject: { kind: "value_exchange", id: exchange.id },
      actor: request.actor,
      at: at.value,
      payload: { profile: exchange.profile, name: exchange.name, benefits: exchange.benefits.length },
    });
    if (!audited.ok) return audited;

    return ok(exchange);
  }

  async clone(request: ActorContext & { valueExchangeId: string; name?: string }): Promise<Result<ValueExchange>> {
    const at = this.#now();
    if (!at.ok) return at;

    const source = await this.#platform.store.exchanges.get(request.tenant, request.valueExchangeId);
    if (!source.ok) return source;

    const copy = cloneValueExchange(source.value, {
      ids: this.#platform.ids,
      actor: request.actor,
      at: at.value,
      ...(request.name === undefined ? {} : { name: request.name }),
    });
    const stored = await this.#platform.store.exchanges.put(copy);
    if (!stored.ok) return stored;
    return ok(copy);
  }

  /** Review, then walk the lifecycle all the way to active. */
  async publish(request: ActorContext & { valueExchangeId: string; approvedBy?: string }): Promise<Result<ValueExchange>> {
    const at = this.#now();
    if (!at.ok) return at;

    let exchange = await this.#platform.store.exchanges.get(request.tenant, request.valueExchangeId);
    if (!exchange.ok) return exchange;

    // Record the approval first if one was supplied, so the approval gate on
    // in_review -> approved can see it.
    if (request.approvedBy) {
      const approvals = [...(exchange.value.governance.approvals ?? []), { by: request.approvedBy, at: at.value }];
      const withApproval: ValueExchange = {
        ...exchange.value,
        governance: { ...exchange.value.governance, approvals },
      };
      const stored = await this.#platform.store.exchanges.put(withApproval);
      if (!stored.ok) return stored;
      exchange = ok(withApproval);
    }

    // Derived from the transition registry, not hardcoded: a deployment that
    // registers a custom lifecycle state gets a route through it for free.
    const route = routeBetween(this.#platform.deps.lifecycle, exchange.value.state, "active");
    if (!route.ok) return route;

    let current = exchange.value;
    for (const next of route.value) {
      const moved = await this.#platform.governance.transition(current, next, request.actor, at.value);
      if (!moved.ok) return moved;
      current = moved.value;
    }
    return ok(current);
  }

  async govern(
    request: ActorContext & { valueExchangeId: string; to?: LifecycleState },
  ): Promise<Result<{ report: PolicyReport; exchange: ValueExchange }>> {
    const at = this.#now();
    if (!at.ok) return at;

    const exchange = await this.#platform.store.exchanges.get(request.tenant, request.valueExchangeId);
    if (!exchange.ok) return exchange;

    const report = await this.#platform.governance.review(exchange.value);
    if (!report.ok) return report;

    if (request.to === undefined) return ok({ report: report.value, exchange: exchange.value });

    const moved = await this.#platform.governance.transition(exchange.value, request.to, request.actor, at.value);
    if (!moved.ok) return moved;
    return ok({ report: report.value, exchange: moved.value });
  }

  async validate(request: { tenant: string; valueExchangeId: string }): Promise<Result<PolicyReport>> {
    const exchange = await this.#platform.store.exchanges.get(request.tenant, request.valueExchangeId);
    if (!exchange.ok) return exchange;
    return await this.#platform.governance.review(exchange.value);
  }

  /* ==================== distribute ==================== */

  async discover(request: {
    context: ContextRequest;
    profile?: string;
    includeIneligible?: boolean;
    limit?: number;
    rank?: "value" | "priority" | "name";
  }): Promise<Result<{ results: DiscoveredExchange[]; context: ResolvedContext }>> {
    const context = await this.#platform.context.resolve(request.context);
    if (!context.ok) return context;

    const results = await this.#platform.discovery.discover({
      context: context.value,
      ...(request.profile === undefined ? {} : { profile: request.profile }),
      ...(request.includeIneligible === undefined ? {} : { includeIneligible: request.includeIneligible }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.rank === undefined ? {} : { rank: request.rank }),
    });
    if (!results.ok) return results;
    return ok({ results: results.value, context: context.value });
  }

  async search(request: {
    context: ContextRequest;
    text: string;
    limit?: number;
  }): Promise<Result<{ results: DiscoveredExchange[]; context: ResolvedContext }>> {
    const context = await this.#platform.context.resolve(request.context);
    if (!context.ok) return context;

    const results = await this.#platform.discovery.discover({
      context: context.value,
      text: request.text,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    });
    if (!results.ok) return results;
    return ok({ results: results.value, context: context.value });
  }

  /** The same context under several objectives, so a caller can see the cost. */
  async compare(
    request: ApplyRequest & { objectives: readonly string[] },
  ): Promise<Result<{ objective: string; decision: Decision }[]>> {
    const context = await this.#platform.context.resolve(request.context);
    if (!context.ok) return context;

    const comparisons: { objective: string; decision: Decision }[] = [];
    for (const objective of request.objectives) {
      const decision = await this.#platform.decisions.decide({
        context: context.value,
        objective,
        ...(request.codes === undefined ? {} : { presentedCodes: request.codes }),
        ...(request.candidateIds === undefined ? {} : { candidateIds: request.candidateIds }),
      });
      if (!decision.ok) return decision;
      comparisons.push({ objective, decision: decision.value });
    }
    return ok(comparisons);
  }

  async issue(
    request: ActorContext & {
      valueExchangeId: string;
      subjectId: string;
      code?: string;
      maxUses?: number;
      expiresAt?: string;
      metadata?: JsonObject;
    },
  ): Promise<Result<Grant>> {
    const at = this.#now();
    if (!at.ok) return at;

    const exchange = await this.#platform.store.exchanges.get(request.tenant, request.valueExchangeId);
    if (!exchange.ok) return exchange;

    const grant: Grant = {
      id: this.#platform.ids.next("grn"),
      tenant: request.tenant,
      valueExchangeId: exchange.value.id,
      valueExchangeVersion: exchange.value.version,
      subjectId: request.subjectId,
      ...(request.code === undefined ? {} : { code: request.code }),
      state: exchange.value.acquisition.requiresActivation ? "issued" : "activated",
      issuedAt: at.value,
      ...(exchange.value.acquisition.requiresActivation ? {} : { activatedAt: at.value }),
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
      uses: 0,
      maxUses: request.maxUses ?? 1,
      metadata: request.metadata ?? {},
    };

    // The issuance count and the grant must move together, or a crash between
    // them either issues a grant nobody counted or counts one nobody holds.
    return this.#platform.store.transaction(async (tx) => {
      const counted = await tx.counters.tryIssue(
        request.tenant,
        request.valueExchangeId,
        exchange.value.limits.totalIssuance,
      );
      if (!counted.ok) return counted;

      const stored = await tx.grants.put(grant);
      if (!stored.ok) return stored;

      const audited = await tx.audit.append({
        tenant: request.tenant,
        reality: "production",
        kind: "grant.issued",
        subject: { kind: "grant", id: grant.id },
        actor: request.actor,
        at: at.value,
        payload: {
          valueExchangeId: grant.valueExchangeId,
          subjectId: request.subjectId,
          maxUses: grant.maxUses,
          issued: counted.value,
        },
      });
      if (!audited.ok) return audited;

      return ok(grant);
    });
  }

  async activate(request: ActorContext & { grantId: string }): Promise<Result<Grant>> {
    const at = this.#now();
    if (!at.ok) return at;

    const grant = await this.#platform.store.grants.get(request.tenant, request.grantId);
    if (!grant.ok) return grant;
    if (grant.value.state === "activated") return ok(grant.value);
    if (grant.value.state !== "issued") {
      return fail(ErrorCode.ILLEGAL_STATE, `grant '${request.grantId}' is '${grant.value.state}' and cannot be activated`);
    }

    const activated: Grant = { ...grant.value, state: "activated", activatedAt: at.value };
    const stored = await this.#platform.store.grants.put(activated);
    if (!stored.ok) return stored;

    const audited = await this.#platform.store.audit.append({
      tenant: request.tenant,
      reality: "production",
      kind: "grant.activated",
      subject: { kind: "grant", id: activated.id },
      actor: request.actor,
      at: at.value,
      payload: { valueExchangeId: activated.valueExchangeId },
    });
    if (!audited.ok) return audited;
    return ok(activated);
  }

  /* ==================== decide ==================== */

  /** Quote. Changes nothing. */
  async apply(request: ApplyRequest): Promise<Result<QuoteResult>> {
    const context = await this.#platform.context.resolve(request.context);
    if (!context.ok) return context;

    let risk: RiskAssessment | undefined;
    if (request.assessRisk) {
      const assessed = this.#platform.risk.assess(context.value);
      if (!assessed.ok) return assessed;
      risk = assessed.value;
      if (risk.disposition === "block") {
        return fail(ErrorCode.RISK_BLOCKED, `risk score ${risk.score} blocks this interaction`, {
          score: risk.score,
          signals: risk.signals,
        });
      }
    }

    const decision = await this.#platform.decisions.decide({
      context: context.value,
      ...(request.codes === undefined ? {} : { presentedCodes: request.codes }),
      ...(request.candidateIds === undefined ? {} : { candidateIds: request.candidateIds }),
      ...(request.objective === undefined ? {} : { objective: request.objective }),
    });
    if (!decision.ok) return decision;

    return ok({
      decision: decision.value,
      context: context.value,
      ...(risk === undefined ? {} : { risk }),
    });
  }

  async optimize(request: ApplyRequest & { objective: string }): Promise<Result<QuoteResult>> {
    return await this.apply(request);
  }

  /**
   * Run the same decision with effects detached. The reality must be a
   * non-binding one, which is checked rather than assumed: a simulation that
   * silently ran against production would be the worst bug this platform could
   * have.
   */
  async simulate(request: ApplyRequest & { reality?: string }): Promise<Result<QuoteResult>> {
    const realityKey = request.reality ?? "simulation";
    const reality = this.#platform.deps.realities.require(realityKey);
    if (!reality.ok) return reality;
    if (reality.value.effectsAreBinding) {
      return fail(ErrorCode.INVALID_REQUEST, `reality '${realityKey}' is binding and cannot be used for simulation`, {
        reality: realityKey,
      });
    }
    return await this.apply({ ...request, context: { ...request.context, reality: realityKey } });
  }

  /** Project budget burn from what has actually been committed so far. */
  async forecast(request: { tenant: string; sourceIds?: readonly string[] }): Promise<Result<ForecastResult[]>> {
    const sources = await this.#platform.store.funding.list(request.tenant);
    if (!sources.ok) return sources;

    const selected = request.sourceIds
      ? sources.value.filter((s) => request.sourceIds!.includes(s.id))
      : sources.value;

    const results: ForecastResult[] = [];
    for (const source of selected) {
      const committed = add(source.reserved, source.spent);
      if (!committed.ok) return committed;
      const available = availableOf(source);

      const utilisation =
        source.budget && source.budget.minor > 0n
          ? Number((committed.value.minor * 10_000n) / source.budget.minor) / 100
          : null;

      // Projection uses the mean committed-per-redemption so far. With no
      // history there is nothing to extrapolate from, and null says so rather
      // than implying a confident zero.
      const entries = await this.#platform.store.ledger.entriesFor(request.tenant, `exp:${source.id}:${source.unit}`);
      if (!entries.ok) return entries;
      const redemptions = new Set(entries.value.map((e) => e.reference.id)).size;
      const projected =
        available && redemptions > 0 && committed.value.minor > 0n
          ? Number(available.minor / (committed.value.minor / BigInt(redemptions)))
          : null;

      results.push({
        sourceId: source.id,
        unit: source.unit,
        ...(source.budget === undefined ? {} : { budget: source.budget }),
        committed: committed.value,
        ...(available === null ? {} : { available }),
        utilisationPercent: utilisation,
        projectedRemainingRedemptions: projected,
      });
    }
    return ok(results);
  }

  /* ==================== execute ==================== */

  async reserve(request: RedeemRequest): Promise<Result<QuoteResult & { execution: Execution }>> {
    const quote = await this.apply(request);
    if (!quote.ok) return quote;

    const execution = await this.#platform.executions.reserve({
      decision: quote.value.decision,
      context: quote.value.context,
      ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    });
    if (!execution.ok) return execution;

    return ok({ ...quote.value, execution: execution.value });
  }

  async redeem(request: RedeemRequest): Promise<Result<RedeemResult>> {
    const reserved = await this.reserve(request);
    if (!reserved.ok) return reserved;

    const captured = await this.#platform.executions.capture(
      request.context.tenant,
      reserved.value.execution.id,
      reserved.value.context,
      request.payee,
    );
    if (!captured.ok) return captured;

    return ok({
      decision: reserved.value.decision,
      context: reserved.value.context,
      ...(reserved.value.risk === undefined ? {} : { risk: reserved.value.risk }),
      execution: captured.value.execution,
      entries: captured.value.entries,
    });
  }

  async release(request: { context: ContextRequest; executionId: string }): Promise<Result<Execution>> {
    const context = await this.#platform.context.resolve(request.context);
    if (!context.ok) return context;
    return await this.#platform.executions.release(request.context.tenant, request.executionId, context.value);
  }

  async reverse(request: { context: ContextRequest; executionId: string; reason: string }): Promise<Result<Execution>> {
    const context = await this.#platform.context.resolve(request.context);
    if (!context.ok) return context;
    const reversed = await this.#platform.executions.reverse(
      request.context.tenant,
      request.executionId,
      context.value,
      request.reason,
    );
    if (!reversed.ok) return reversed;
    return ok(reversed.value.execution);
  }

  /* ==================== observe ==================== */

  async track(request: {
    tenant: string;
    kind: TouchpointKind;
    party: PartyRef;
    subjectId?: string;
    deviceId?: string;
    valueExchangeId?: string;
    channel?: string;
    metadata?: JsonObject;
  }): Promise<Result<Touchpoint>> {
    const at = this.#now();
    if (!at.ok) return at;

    return await this.#platform.attribution.record({
      id: this.#platform.ids.next("tp"),
      tenant: request.tenant,
      kind: request.kind,
      party: request.party,
      ...(request.subjectId === undefined ? {} : { subjectId: request.subjectId }),
      ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }),
      ...(request.valueExchangeId === undefined ? {} : { valueExchangeId: request.valueExchangeId }),
      ...(request.channel === undefined ? {} : { channel: request.channel }),
      at: at.value,
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    });
  }

  async attribute(request: {
    tenant: string;
    subjectId?: string;
    deviceId?: string;
    valueExchangeId?: string;
    model?: string;
    value?: { unit: string; decimal: string };
    lookbackSeconds?: number;
  }): Promise<Result<{ shares: AttributionShare[]; touchpoints: number }>> {
    const at = this.#now();
    if (!at.ok) return at;

    const journey = await this.#platform.attribution.journey({
      tenant: request.tenant,
      ...(request.subjectId === undefined ? {} : { subjectId: request.subjectId }),
      ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }),
      ...(request.valueExchangeId === undefined ? {} : { valueExchangeId: request.valueExchangeId }),
      nowTick: BigInt(at.value),
      ...(request.lookbackSeconds === undefined ? {} : { lookbackSeconds: request.lookbackSeconds }),
    });

    if (!journey.ok) return journey;

    let value: Amount | undefined;
    if (request.value) {
      const unit = this.#platform.economic.units.require(request.value.unit);
      if (!unit.ok) return unit;
      value = fromDecimal(request.value.unit, request.value.decimal, unit.value.scale);
    }

    const shares = this.#platform.attribution.attribute(request.model ?? "last_touch", {
      touchpoints: journey.value,
      ...(value === undefined ? {} : { value }),
    });
    if (!shares.ok) return shares;
    return ok({ shares: shares.value, touchpoints: journey.value.length });
  }

  async audit(request: { tenant: string; limit?: number; fromSeq?: number }): Promise<
    Result<{ verified: boolean; head: string; records: number; recent: readonly AuditRecord[]; brokenAt?: number }>
  > {
    const verified = await this.#platform.store.audit.verify(request.tenant, request.fromSeq);
    const head = await this.#platform.store.audit.head(request.tenant);
    if (!head.ok) return head;

    const recent = await this.#platform.store.audit.recent(request.tenant, request.limit ?? 20);
    if (!recent.ok) return recent;

    return ok({
      verified: verified.ok,
      head: head.value,
      records: verified.ok ? verified.value.records : recent.value.length,
      recent: recent.value,
      ...(verified.ok || typeof verified.error.details?.seq !== "number"
        ? {}
        : { brokenAt: verified.error.details.seq as number }),
    });
  }

  /* ==================== settle ==================== */

  async fund(
    request: ActorContext & {
      sourceId: string;
      label: string;
      party: PartyRef;
      unit: string;
      budgetDecimal?: string;
    },
  ): Promise<Result<FundingSource>> {
    const unit = this.#platform.economic.units.require(request.unit);
    if (!unit.ok) return unit;

    const existing = await this.#platform.store.funding.get(request.tenant, request.sourceId);
    const topUp = existing.ok && request.budgetDecimal !== undefined;

    const budget =
      request.budgetDecimal === undefined
        ? undefined
        : fromDecimal(request.unit, request.budgetDecimal, unit.value.scale);

    const source: FundingSource = topUp
      ? {
          ...existing.value,
          budget: budget
            ? { ...budget, minor: (existing.value.budget?.minor ?? 0n) + budget.minor }
            : existing.value.budget,
        }
      : {
          id: request.sourceId,
          tenant: request.tenant,
          label: request.label,
          party: request.party,
          unit: request.unit,
          ...(budget === undefined ? {} : { budget }),
          reserved: zero(request.unit, unit.value.scale),
          spent: zero(request.unit, unit.value.scale),
        };

    return await this.#platform.store.funding.put(source);
  }

  async settle(request: { tenant: string }): Promise<Result<{
    positions: AccountPosition[];
    balanced: boolean;
    entries: number;
  }>> {
    const entries = await this.#platform.store.ledger.all(request.tenant);
    if (!entries.ok) return entries;
    const verified = verifyLedger(entries.value);
    return ok({
      positions: reconcile(entries.value),
      balanced: verified.ok,
      entries: entries.value.length,
    });
  }

  async pay(request: {
    tenant: string;
    reality?: string;
    fromAccountId: string;
    destination: { kind: string; reference: string };
    unit: string;
    decimal: string;
    memo?: string;
  }): Promise<Result<{ payoutId: string; entries: readonly LedgerEntry[] }>> {
    const at = this.#now();
    if (!at.ok) return at;

    const unit = this.#platform.economic.units.require(request.unit);
    if (!unit.ok) return unit;

    const entries = await this.#platform.store.ledger.all(request.tenant);
    if (!entries.ok) return entries;

    const payout = requestPayout(
      {
        tenant: request.tenant,
        reality: request.reality ?? "production",
        fromAccountId: request.fromAccountId,
        destination: request.destination,
        amount: fromDecimal(request.unit, request.decimal, unit.value.scale),
        at: at.value,
        ids: this.#platform.ids,
        economic: this.#platform.economic,
        ...(request.memo === undefined ? {} : { memo: request.memo }),
      },
      reconcile(entries.value),
    );
    if (!payout.ok) return payout;

    const appended = await this.#platform.store.ledger.append(payout.value.entries);
    if (!appended.ok) return appended;

    const audited = await this.#platform.store.audit.append({
      tenant: request.tenant,
      reality: request.reality ?? "production",
      kind: "payout.requested",
      subject: { kind: "payout", id: payout.value.id },
      actor: "system",
      at: at.value,
      payload: {
        fromAccountId: request.fromAccountId,
        amount: `${request.decimal} ${request.unit}`,
        destination: request.destination.kind,
      },
    });
    if (!audited.ok) return audited;

    return ok({ payoutId: payout.value.id, entries: payout.value.entries });
  }

  /* ==================== internals ==================== */

  #now(): Result<string> {
    const instant = this.#platform.temporal.now();
    return instant.ok ? ok(instant.value.tick.toString()) : instant;
  }

}
