/**
 * In-memory reference adapter.
 *
 * Complete enough to run the whole platform, small enough to read in one go,
 * and - since Phase 1 - genuinely correct under concurrent async callers rather
 * than accidentally correct because nothing interleaved.
 *
 * Two things it now does properly, both of which a real adapter must also do:
 *
 *   - Atomic sections. Every conditional operation and every transaction runs
 *     under a mutex. Without it, two `reserve` calls interleaving at an `await`
 *     would both pass the same limit check.
 *   - Rollback. `transaction` snapshots state, runs the work against the
 *     snapshot, and swaps it in only on success.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { ValueExchange, Grant } from "../model/value-exchange.ts";
import type { FundingSource } from "../model/funding.ts";
import type { Execution, ExecutionState } from "../model/execution.ts";
import type { Amount } from "../universal/economic/amount.ts";
import { zero } from "../universal/economic/amount.ts";
import type { LedgerEntry } from "../ledger/ledger.ts";
import type { AuditDraft, AuditRecord } from "../audit/audit-log.ts";
import { GENESIS_HASH, findChainBreak, sealRecord } from "../audit/audit-log.ts";
import type { Touchpoint } from "../attribution/touchpoint.ts";
import { Mutex } from "./mutex.ts";
import { findBreach, findIssuanceBreach, pruneRecent, recentWindowFor } from "./limit-rules.ts";
import type {
  AuditCheckpoint,
  AuditStore,
  ConsumeLimitsRequest,
  CounterReadRequest,
  CounterSnapshot,
  CounterStore,
  ExecutionStore,
  FundingStore,
  GrantStore,
  LedgerStore,
  PlatformStore,
  RestoreLimitsRequest,
  TouchpointQuery,
  TouchpointStore,
  ValueExchangeQuery,
  ValueExchangeStore,
} from "./store.ts";

const key = (tenant: string, id: string): string => `${tenant}/${id}`;
const normalise = (code: string): string => code.trim().toUpperCase();

interface CounterRow {
  issued: number;
  redemptions: number;
  bySubject: Map<string, number>;
  recentBySubject: Map<string, number[]>;
  grantedByUnit: Map<string, Amount>;
}

const emptyRow = (): CounterRow => ({
  issued: 0,
  redemptions: 0,
  bySubject: new Map(),
  recentBySubject: new Map(),
  grantedByUnit: new Map(),
});

/** All mutable state, in one object so a transaction can snapshot it. */
interface State {
  exchanges: Map<string, ValueExchange>;
  grants: Map<string, Grant>;
  counters: Map<string, CounterRow>;
  funding: Map<string, FundingSource>;
  executions: Map<string, Execution>;
  executionsByKey: Map<string, string>;
  ledger: LedgerEntry[];
  audit: Map<string, AuditRecord[]>;
  checkpoints: Map<string, AuditCheckpoint>;
  touchpoints: Touchpoint[];
}

function emptyState(): State {
  return {
    exchanges: new Map(),
    grants: new Map(),
    counters: new Map(),
    funding: new Map(),
    executions: new Map(),
    executionsByKey: new Map(),
    ledger: [],
    audit: new Map(),
    checkpoints: new Map(),
    touchpoints: [],
  };
}

/**
 * Snapshot for rollback. Records are immutable, so the containers are cloned
 * and the values shared - except counter rows, which hold nested mutables.
 */
function snapshot(state: State): State {
  return {
    exchanges: new Map(state.exchanges),
    grants: new Map(state.grants),
    counters: new Map(
      [...state.counters].map(([k, row]) => [
        k,
        {
          issued: row.issued,
          redemptions: row.redemptions,
          bySubject: new Map(row.bySubject),
          recentBySubject: new Map([...row.recentBySubject].map(([s, t]) => [s, [...t]])),
          grantedByUnit: new Map(row.grantedByUnit),
        },
      ]),
    ),
    funding: new Map(state.funding),
    executions: new Map(state.executions),
    executionsByKey: new Map(state.executionsByKey),
    ledger: [...state.ledger],
    audit: new Map([...state.audit].map(([k, records]) => [k, [...records]])),
    checkpoints: new Map(state.checkpoints),
    touchpoints: [...state.touchpoints],
  };
}

/* ------------------------------------------------------------------ */

class ExchangeStore implements ValueExchangeStore {
  readonly s: () => State;

  constructor(state: () => State) {
    this.s = state;
  }

  async put(exchange: ValueExchange): Promise<Result<ValueExchange>> {
    this.s().exchanges.set(key(exchange.tenant, exchange.id), exchange);
    return ok(exchange);
  }

  async get(tenant: string, id: string): Promise<Result<ValueExchange>> {
    const found = this.s().exchanges.get(key(tenant, id));
    return found ? ok(found) : fail(ErrorCode.NOT_FOUND, `no value exchange '${id}'`, { tenant, id });
  }

  async find(tenant: string, query: ValueExchangeQuery = {}): Promise<Result<ValueExchange[]>> {
    const matches = [...this.s().exchanges.values()].filter(
      (item) =>
        item.tenant === tenant &&
        (query.profile === undefined || item.profile === query.profile) &&
        (query.state === undefined || item.state === query.state) &&
        (query.visibility === undefined || item.visibility === query.visibility) &&
        (query.reality === undefined ||
          item.scope.realities === undefined ||
          item.scope.realities.includes(query.reality)),
    );
    // Deterministic order; a real adapter needs an index on (tenant, state).
    return ok(matches.sort((a, b) => a.id.localeCompare(b.id)));
  }

  async byCode(tenant: string, code: string): Promise<Result<ValueExchange | undefined>> {
    const wanted = normalise(code);
    return ok(
      [...this.s().exchanges.values()].find(
        (item) => item.tenant === tenant && item.acquisition.code !== undefined && normalise(item.acquisition.code) === wanted,
      ),
    );
  }
}

class MemGrantStore implements GrantStore {
  readonly s: () => State;

  constructor(state: () => State) {
    this.s = state;
  }

  async put(grant: Grant): Promise<Result<Grant>> {
    this.s().grants.set(key(grant.tenant, grant.id), grant);
    return ok(grant);
  }

  async get(tenant: string, id: string): Promise<Result<Grant>> {
    const found = this.s().grants.get(key(tenant, id));
    return found ? ok(found) : fail(ErrorCode.NOT_FOUND, `no grant '${id}'`, { tenant, id });
  }

  async forSubject(tenant: string, subjectId: string): Promise<Result<Grant[]>> {
    return ok(
      [...this.s().grants.values()]
        .filter((g) => g.tenant === tenant && g.subjectId === subjectId)
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  async byCode(tenant: string, code: string): Promise<Result<Grant | undefined>> {
    const wanted = normalise(code);
    return ok(
      [...this.s().grants.values()].find(
        (g) => g.tenant === tenant && g.code !== undefined && normalise(g.code) === wanted,
      ),
    );
  }
}

class MemCounterStore implements CounterStore {
  readonly s: () => State;
  readonly lock: Mutex;

  constructor(state: () => State, lock: Mutex) {
    this.s = state;
    this.lock = lock;
  }

  #row(tenant: string, id: string): CounterRow {
    const k = key(tenant, id);
    const existing = this.s().counters.get(k);
    if (existing) return existing;
    const created = emptyRow();
    this.s().counters.set(k, created);
    return created;
  }

  #snapshot(row: CounterRow, subjectId?: string, atSeconds?: number, window?: number): CounterSnapshot {
    const recent = subjectId === undefined ? [] : (row.recentBySubject.get(subjectId) ?? []);
    const cutoff = atSeconds !== undefined && window !== undefined ? atSeconds - window : -Infinity;
    return {
      issued: row.issued,
      redemptions: row.redemptions,
      subjectRedemptions: subjectId === undefined ? 0 : (row.bySubject.get(subjectId) ?? 0),
      subjectRecent: recent.filter((t) => t > cutoff),
      grantedByUnit: new Map(row.grantedByUnit),
    };
  }

  async read(request: CounterReadRequest): Promise<Result<CounterSnapshot>> {
    const row = this.s().counters.get(key(request.tenant, request.valueExchangeId)) ?? emptyRow();
    return ok(this.#snapshot(row, request.subjectId, request.atSeconds, request.recentWindowSeconds));
  }

  async tryConsume(request: ConsumeLimitsRequest): Promise<Result<CounterSnapshot>> {
    return this.lock.run(() => {
      const row = this.#row(request.tenant, request.valueExchangeId);
      const window = recentWindowFor(request.limits);
      const before = this.#snapshot(row, request.subjectId, request.atSeconds, window);

      const breach = findBreach(before, request.limits, request.subjectId, request.atSeconds, request.granted);
      if (breach) {
        return fail(ErrorCode.LIMIT_EXCEEDED, `${breach.limit}: ${breach.detail}`, {
          limit: breach.limit,
          detail: breach.detail,
          valueExchangeId: request.valueExchangeId,
        });
      }

      row.redemptions += 1;
      if (request.subjectId !== undefined) {
        row.bySubject.set(request.subjectId, (row.bySubject.get(request.subjectId) ?? 0) + 1);
        const recent = pruneRecent(
          row.recentBySubject.get(request.subjectId) ?? [],
          request.atSeconds,
          window,
        );
        recent.push(request.atSeconds);
        row.recentBySubject.set(request.subjectId, recent);
      }
      for (const amount of request.granted) {
        const running = row.grantedByUnit.get(amount.unit) ?? zero(amount.unit, amount.scale);
        row.grantedByUnit.set(amount.unit, { ...running, minor: running.minor + amount.minor });
      }

      return ok(this.#snapshot(row, request.subjectId, request.atSeconds, window));
    });
  }

  async restore(request: RestoreLimitsRequest): Promise<Result<void>> {
    return this.lock.run(() => {
      const row = this.#row(request.tenant, request.valueExchangeId);
      row.redemptions = Math.max(0, row.redemptions - 1);
      if (request.subjectId !== undefined) {
        row.bySubject.set(request.subjectId, Math.max(0, (row.bySubject.get(request.subjectId) ?? 0) - 1));
        const recent = row.recentBySubject.get(request.subjectId) ?? [];
        recent.pop();
        row.recentBySubject.set(request.subjectId, recent);
      }
      for (const amount of request.granted) {
        const running = row.grantedByUnit.get(amount.unit);
        if (!running) continue;
        const next = running.minor - amount.minor;
        row.grantedByUnit.set(amount.unit, { ...running, minor: next < 0n ? 0n : next });
      }
      return ok(undefined);
    });
  }

  async tryIssue(tenant: string, valueExchangeId: string, cap?: number): Promise<Result<number>> {
    return this.lock.run(() => {
      const row = this.#row(tenant, valueExchangeId);
      const breach = findIssuanceBreach(row.issued, cap);
      if (breach) {
        return fail(ErrorCode.LIMIT_EXCEEDED, `${breach.limit}: ${breach.detail}`, {
          limit: breach.limit,
          valueExchangeId,
        });
      }
      row.issued += 1;
      return ok(row.issued);
    });
  }
}

class MemFundingStore implements FundingStore {
  readonly s: () => State;
  readonly lock: Mutex;

  constructor(state: () => State, lock: Mutex) {
    this.s = state;
    this.lock = lock;
  }

  async put(source: FundingSource): Promise<Result<FundingSource>> {
    this.s().funding.set(key(source.tenant, source.id), source);
    return ok(source);
  }

  async get(tenant: string, id: string): Promise<Result<FundingSource>> {
    const found = this.s().funding.get(key(tenant, id));
    return found ? ok(found) : fail(ErrorCode.NOT_FOUND, `no funding source '${id}'`, { tenant, id });
  }

  async list(tenant: string): Promise<Result<FundingSource[]>> {
    return ok(
      [...this.s().funding.values()]
        .filter((source) => source.tenant === tenant)
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  #adjust(
    tenant: string,
    sourceId: string,
    change: (source: FundingSource) => Result<FundingSource>,
  ): Promise<Result<FundingSource>> {
    return this.lock.run(() => {
      const found = this.s().funding.get(key(tenant, sourceId));
      if (!found) return fail(ErrorCode.NOT_FOUND, `no funding source '${sourceId}'`, { tenant, sourceId });
      const next = change(found);
      if (!next.ok) return next;
      this.s().funding.set(key(tenant, sourceId), next.value);
      return next;
    });
  }

  async tryReserve(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>> {
    return this.#adjust(tenant, sourceId, (source) => {
      if (source.unit !== amount.unit) {
        return fail(ErrorCode.UNIT_MISMATCH, `source '${sourceId}' is in ${source.unit}, not ${amount.unit}`);
      }
      if (source.budget) {
        const headroom = source.budget.minor - source.reserved.minor - source.spent.minor;
        if (headroom < amount.minor) {
          return fail(ErrorCode.INSUFFICIENT_FUNDS, `funding source '${sourceId}' has ${headroom}, needs ${amount.minor}`, {
            sourceId,
            availableMinor: headroom.toString(),
            requestedMinor: amount.minor.toString(),
            unit: amount.unit,
          });
        }
      }
      return ok({ ...source, reserved: { ...source.reserved, minor: source.reserved.minor + amount.minor } });
    });
  }

  async releaseReservation(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>> {
    return this.#adjust(tenant, sourceId, (source) => {
      const next = source.reserved.minor - amount.minor;
      if (next < 0n) {
        return fail(ErrorCode.ILLEGAL_STATE, `releasing more than reserved on source '${sourceId}'`);
      }
      return ok({ ...source, reserved: { ...source.reserved, minor: next } });
    });
  }

  async captureReserved(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>> {
    return this.#adjust(tenant, sourceId, (source) => {
      const next = source.reserved.minor - amount.minor;
      if (next < 0n) {
        return fail(ErrorCode.ILLEGAL_STATE, `capturing more than reserved on source '${sourceId}'`);
      }
      return ok({
        ...source,
        reserved: { ...source.reserved, minor: next },
        spent: { ...source.spent, minor: source.spent.minor + amount.minor },
      });
    });
  }

  async restoreSpend(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>> {
    return this.#adjust(tenant, sourceId, (source) => {
      const next = source.spent.minor - amount.minor;
      return ok({ ...source, spent: { ...source.spent, minor: next < 0n ? 0n : next } });
    });
  }
}

class MemExecutionStore implements ExecutionStore {
  readonly s: () => State;

  constructor(state: () => State) {
    this.s = state;
  }

  async put(execution: Execution): Promise<Result<Execution>> {
    this.s().executions.set(key(execution.tenant, execution.id), execution);
    if (execution.idempotencyKey) {
      this.s().executionsByKey.set(key(execution.tenant, execution.idempotencyKey), execution.id);
    }
    return ok(execution);
  }

  async get(tenant: string, id: string): Promise<Result<Execution>> {
    const found = this.s().executions.get(key(tenant, id));
    return found ? ok(found) : fail(ErrorCode.NOT_FOUND, `no execution '${id}'`, { tenant, id });
  }

  async byIdempotencyKey(tenant: string, idempotencyKey: string): Promise<Result<Execution | undefined>> {
    const id = this.s().executionsByKey.get(key(tenant, idempotencyKey));
    return ok(id ? this.s().executions.get(key(tenant, id)) : undefined);
  }

  async forSubject(tenant: string, subjectId: string): Promise<Result<Execution[]>> {
    return ok([...this.s().executions.values()].filter((e) => e.tenant === tenant && e.subjectId === subjectId));
  }

  async staleByState(
    tenant: string,
    state: ExecutionState,
    olderThan: string,
    limit: number,
  ): Promise<Result<Execution[]>> {
    const cutoff = BigInt(olderThan);
    return ok(
      [...this.s().executions.values()]
        .filter((e) => e.tenant === tenant && e.state === state && BigInt(e.createdAt) < cutoff)
        .sort((a, b) => (BigInt(a.createdAt) < BigInt(b.createdAt) ? -1 : 1))
        .slice(0, limit),
    );
  }
}

class MemLedgerStore implements LedgerStore {
  readonly s: () => State;

  constructor(state: () => State) {
    this.s = state;
  }

  async append(entries: readonly LedgerEntry[]): Promise<Result<readonly LedgerEntry[]>> {
    this.s().ledger.push(...entries);
    return ok(entries);
  }

  async entriesFor(tenant: string, accountId: string): Promise<Result<LedgerEntry[]>> {
    return ok(this.s().ledger.filter((e) => e.tenant === tenant && e.accountId === accountId));
  }

  async byReference(tenant: string, referenceId: string): Promise<Result<LedgerEntry[]>> {
    return ok(this.s().ledger.filter((e) => e.tenant === tenant && e.reference.id === referenceId));
  }

  async all(tenant: string): Promise<Result<LedgerEntry[]>> {
    return ok(this.s().ledger.filter((e) => e.tenant === tenant));
  }
}

class MemAuditStore implements AuditStore {
  readonly s: () => State;
  readonly lock: Mutex;

  constructor(state: () => State, lock: Mutex) {
    this.s = state;
    this.lock = lock;
  }

  #chain(tenant: string): AuditRecord[] {
    const existing = this.s().audit.get(tenant);
    if (existing) return existing;
    const created: AuditRecord[] = [];
    this.s().audit.set(tenant, created);
    return created;
  }

  async append(draft: AuditDraft): Promise<Result<AuditRecord>> {
    return this.lock.run(() => {
      const chain = this.#chain(draft.tenant);
      const previousHash = chain.length > 0 ? (chain[chain.length - 1] as AuditRecord).hash : GENESIS_HASH;
      const record = sealRecord(draft, chain.length, previousHash);
      chain.push(record);
      return ok(record);
    });
  }

  async head(tenant: string): Promise<Result<string>> {
    const chain = this.s().audit.get(tenant) ?? [];
    return ok(chain.length > 0 ? (chain[chain.length - 1] as AuditRecord).hash : GENESIS_HASH);
  }

  async headSeq(tenant: string): Promise<Result<number>> {
    const chain = this.s().audit.get(tenant) ?? [];
    return ok(chain.length - 1);
  }

  async recent(tenant: string, limit: number): Promise<Result<AuditRecord[]>> {
    const chain = this.s().audit.get(tenant) ?? [];
    return ok(chain.slice(Math.max(0, chain.length - limit)));
  }

  async at(tenant: string, seq: number): Promise<Result<AuditRecord | undefined>> {
    return ok((this.s().audit.get(tenant) ?? [])[seq]);
  }

  async saveCheckpoint(checkpoint: AuditCheckpoint): Promise<Result<AuditCheckpoint>> {
    this.s().checkpoints.set(checkpoint.tenant, checkpoint);
    return ok(checkpoint);
  }

  async latestCheckpoint(tenant: string): Promise<Result<AuditCheckpoint | undefined>> {
    return ok(this.s().checkpoints.get(tenant));
  }

  async verify(tenant: string, fromSeq = 0): Promise<Result<{ records: number; head: string }>> {
    const chain = this.s().audit.get(tenant) ?? [];
    const slice = chain.slice(fromSeq);
    const startingHash = fromSeq === 0 ? GENESIS_HASH : (chain[fromSeq - 1]?.hash ?? GENESIS_HASH);
    const broken = findChainBreak(slice, startingHash);
    if (broken) {
      return fail(ErrorCode.CONFLICT, `audit chain broken at seq ${broken.seq}: record was ${broken.reason === "link" ? "reordered or removed" : "modified"}`, {
        seq: broken.seq,
        reason: broken.reason,
        expected: broken.expected,
        found: broken.found,
      });
    }
    const head = chain.length > 0 ? (chain[chain.length - 1] as AuditRecord).hash : GENESIS_HASH;
    return ok({ records: chain.length, head });
  }
}

class MemTouchpointStore implements TouchpointStore {
  readonly s: () => State;

  constructor(state: () => State) {
    this.s = state;
  }

  async append(touchpoint: Touchpoint): Promise<Result<Touchpoint>> {
    this.s().touchpoints.push(touchpoint);
    return ok(touchpoint);
  }

  async journey(query: TouchpointQuery): Promise<Result<Touchpoint[]>> {
    const since = query.since === undefined ? null : BigInt(query.since);
    const found = this.s()
      .touchpoints.filter((t) => {
        if (t.tenant !== query.tenant) return false;
        if (query.subjectId !== undefined) {
          if (t.subjectId !== query.subjectId && t.deviceId !== query.deviceId) return false;
        } else if (query.deviceId !== undefined && t.deviceId !== query.deviceId) {
          return false;
        }
        if (query.valueExchangeId !== undefined && t.valueExchangeId !== undefined && t.valueExchangeId !== query.valueExchangeId) {
          return false;
        }
        if (since !== null && BigInt(t.at) < since) return false;
        return true;
      })
      .sort((a, b) => (BigInt(a.at) < BigInt(b.at) ? -1 : BigInt(a.at) > BigInt(b.at) ? 1 : a.id.localeCompare(b.id)));
    return ok(query.limit === undefined ? found : found.slice(0, query.limit));
  }
}

/* ------------------------------------------------------------------ */

export class MemoryPlatformStore implements PlatformStore {
  #state: State;
  readonly #lock: Mutex;

  readonly exchanges: ValueExchangeStore;
  readonly grants: GrantStore;
  readonly counters: CounterStore;
  readonly funding: FundingStore;
  readonly executions: ExecutionStore;
  readonly ledger: LedgerStore;
  readonly audit: AuditStore;
  readonly touchpoints: TouchpointStore;

  constructor(state: State = emptyState(), lock: Mutex = new Mutex()) {
    this.#state = state;
    this.#lock = lock;
    const s = () => this.#state;
    this.exchanges = new ExchangeStore(s);
    this.grants = new MemGrantStore(s);
    this.counters = new MemCounterStore(s, lock);
    this.funding = new MemFundingStore(s, lock);
    this.executions = new MemExecutionStore(s);
    this.ledger = new MemLedgerStore(s);
    this.audit = new MemAuditStore(s, lock);
    this.touchpoints = new MemTouchpointStore(s);
  }

  /**
   * Snapshot, run, swap on success.
   *
   * The whole transaction holds the mutex, so a nested atomic operation inside
   * `work` must not take it again. The inner stores are therefore given a
   * fresh, uncontended lock for the duration - the outer lock is already
   * providing the exclusion.
   */
  async transaction<T>(work: (tx: PlatformStore) => Promise<Result<T>>): Promise<Result<T>> {
    return this.#lock.run(async () => {
      const staged = snapshot(this.#state);
      const tx = new MemoryPlatformStore(staged, new Mutex());
      try {
        const outcome = await work(tx);
        if (outcome.ok) this.#state = staged;
        return outcome;
      } catch (error) {
        // Staged state is simply discarded.
        throw error;
      }
    });
  }
}
