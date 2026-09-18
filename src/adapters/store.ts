/**
 * Storage ports.
 *
 * Two properties of these interfaces are load-bearing, and both were changed in
 * Phase 1 after the in-memory reference adapter made them look optional.
 *
 * 1. EVERYTHING IS ASYNC. A real store is remote. The previous synchronous
 *    shape could never have talked to Postgres, which made "swap the adapter"
 *    an unkeepable promise.
 *
 * 2. THERE IS NO READ-CHECK-WRITE GAP. Limits and budgets are consumed by
 *    *conditional* operations that carry the constraint with them, so the
 *    store enforces it in one atomic step. The old `mutate(counters => ...)`
 *    shape pushed the check into application code, which is safe only in a
 *    single-threaded adapter. An interface that can only be implemented safely
 *    by accident is the wrong interface.
 *
 * Anything that must not interleave runs inside `PlatformStore.transaction`.
 */
import type { Result } from "../kernel/result.ts";
import type { ValueExchange, Grant } from "../model/value-exchange.ts";
import type { LimitSpec } from "../model/limits.ts";
import type { FundingSource } from "../model/funding.ts";
import type { Amount } from "../universal/economic/amount.ts";
import type { LedgerEntry } from "../ledger/ledger.ts";
import type { AuditDraft, AuditRecord } from "../audit/audit-log.ts";
import type { Execution, ExecutionState } from "../model/execution.ts";
import type { Touchpoint } from "../attribution/touchpoint.ts";

export interface ValueExchangeQuery {
  readonly profile?: string;
  readonly state?: string;
  readonly visibility?: string;
  readonly reality?: string;
}

export interface ValueExchangeStore {
  put(exchange: ValueExchange): Promise<Result<ValueExchange>>;
  get(tenant: string, id: string): Promise<Result<ValueExchange>>;
  find(tenant: string, query?: ValueExchangeQuery): Promise<Result<ValueExchange[]>>;
  /** Resolve a presented code to its exchange. Case- and space-insensitive. */
  byCode(tenant: string, code: string): Promise<Result<ValueExchange | undefined>>;
}

export interface GrantStore {
  put(grant: Grant): Promise<Result<Grant>>;
  get(tenant: string, id: string): Promise<Result<Grant>>;
  forSubject(tenant: string, subjectId: string): Promise<Result<Grant[]>>;
  byCode(tenant: string, code: string): Promise<Result<Grant | undefined>>;
}

/* ------------------------------------------------------------------ *
 * Counters
 * ------------------------------------------------------------------ */

/**
 * What a caller may know about consumption.
 *
 * Deliberately scoped to one subject rather than returning every subject's
 * tally: the whole-map shape could not survive a tenant with ten million
 * customers, and nothing needs it.
 */
export interface CounterSnapshot {
  readonly issued: number;
  readonly redemptions: number;
  /** Redemptions by the subject named in the read, or 0. */
  readonly subjectRedemptions: number;
  /** Recent redemption timestamps (frame seconds) for that subject, within the requested window. */
  readonly subjectRecent: readonly number[];
  /** Cumulative granted value per unit key. */
  readonly grantedByUnit: ReadonlyMap<string, Amount>;
}

export interface CounterReadRequest {
  readonly tenant: string;
  readonly valueExchangeId: string;
  readonly subjectId?: string;
  /** Only timestamps newer than `atSeconds - recentWindowSeconds` are returned. */
  readonly atSeconds?: number;
  readonly recentWindowSeconds?: number;
}

export interface ConsumeLimitsRequest {
  readonly tenant: string;
  readonly valueExchangeId: string;
  readonly subjectId?: string;
  /** Current instant in frame seconds; recorded for per-period limits. */
  readonly atSeconds: number;
  /** The constraints the store must enforce atomically. */
  readonly limits: LimitSpec;
  /** Value granted by this redemption, counted toward `limits.totalBudget`. */
  readonly granted: readonly Amount[];
}

export interface RestoreLimitsRequest {
  readonly tenant: string;
  readonly valueExchangeId: string;
  readonly subjectId?: string;
  readonly atSeconds: number;
  readonly granted: readonly Amount[];
}

export interface CounterStore {
  /**
   * Advisory read, for eligibility verdicts and reporting.
   *
   * The value can be stale the instant it is returned. It exists so a verdict
   * can say "3/5 used", never as the basis for allowing a redemption. The
   * authoritative check is `tryConsume`.
   */
  read(request: CounterReadRequest): Promise<Result<CounterSnapshot>>;

  /**
   * Atomically verify every limit and consume one redemption.
   *
   * Returns `LIMIT_EXCEEDED` naming the limit that blocked it, having changed
   * nothing. This is the only call that may authorise a redemption.
   */
  tryConsume(request: ConsumeLimitsRequest): Promise<Result<CounterSnapshot>>;

  /** Give back one redemption. Used by release and reversal. Never goes below zero. */
  restore(request: RestoreLimitsRequest): Promise<Result<void>>;

  /** Atomically consume one issuance against `totalIssuance`. */
  tryIssue(tenant: string, valueExchangeId: string, cap?: number): Promise<Result<number>>;
}

/* ------------------------------------------------------------------ *
 * Funding
 * ------------------------------------------------------------------ */

export interface FundingStore {
  put(source: FundingSource): Promise<Result<FundingSource>>;
  get(tenant: string, id: string): Promise<Result<FundingSource>>;
  list(tenant: string): Promise<Result<FundingSource[]>>;

  /**
   * Atomically hold `amount`, but only if headroom covers it.
   *
   * Headroom is `budget - reserved - spent`. Returns `INSUFFICIENT_FUNDS`
   * having changed nothing when it does not. An uncapped source always
   * succeeds.
   */
  tryReserve(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>>;

  /** Release a hold without spending it. */
  releaseReservation(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>>;

  /** Convert a hold into spend. */
  captureReserved(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>>;

  /** Undo spend, for a reversal. */
  restoreSpend(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>>;
}

/* ------------------------------------------------------------------ */

export interface ExecutionStore {
  put(execution: Execution): Promise<Result<Execution>>;
  get(tenant: string, id: string): Promise<Result<Execution>>;
  /** Idempotency: has this key already produced an execution? */
  byIdempotencyKey(tenant: string, key: string): Promise<Result<Execution | undefined>>;
  forSubject(tenant: string, subjectId: string): Promise<Result<Execution[]>>;
  /**
   * Executions in a given state created before a cut-off, oldest first.
   * The reservation reaper's only query.
   */
  staleByState(
    tenant: string,
    state: ExecutionState,
    olderThan: string,
    limit: number,
  ): Promise<Result<Execution[]>>;
}

export interface LedgerStore {
  append(entries: readonly LedgerEntry[]): Promise<Result<readonly LedgerEntry[]>>;
  entriesFor(tenant: string, accountId: string): Promise<Result<LedgerEntry[]>>;
  byReference(tenant: string, referenceId: string): Promise<Result<LedgerEntry[]>>;
  all(tenant: string): Promise<Result<LedgerEntry[]>>;
}

/**
 * A point in the chain that has been verified and recorded, so later
 * verification can resume rather than re-walking from genesis.
 */
export interface AuditCheckpoint {
  readonly tenant: string;
  readonly seq: number;
  readonly hash: string;
  /** Instant tick, as a string. */
  readonly at: string;
}

export interface AuditStore {
  /** Seals the draft into the chain: assigns seq, links previousHash, hashes. */
  append(draft: AuditDraft): Promise<Result<AuditRecord>>;
  head(tenant: string): Promise<Result<string>>;
  /** Highest sequence number in the chain, or -1 when it is empty. */
  headSeq(tenant: string): Promise<Result<number>>;
  recent(tenant: string, limit: number): Promise<Result<AuditRecord[]>>;
  /** One record by sequence number, for checkpointing and anchoring. */
  at(tenant: string, seq: number): Promise<Result<AuditRecord | undefined>>;
  /**
   * Re-verify the chain. `fromSeq` resumes from a trusted checkpoint, because
   * verifying from genesis stops scaling well before a year of production.
   */
  verify(tenant: string, fromSeq?: number): Promise<Result<{ records: number; head: string }>>;

  saveCheckpoint(checkpoint: AuditCheckpoint): Promise<Result<AuditCheckpoint>>;
  latestCheckpoint(tenant: string): Promise<Result<AuditCheckpoint | undefined>>;
}

export interface TouchpointQuery {
  readonly tenant: string;
  readonly subjectId?: string;
  readonly deviceId?: string;
  readonly valueExchangeId?: string;
  /** Exclusive lower bound on `at`, as a tick string. */
  readonly since?: string;
  readonly limit?: number;
}

export interface TouchpointStore {
  append(touchpoint: Touchpoint): Promise<Result<Touchpoint>>;
  /** Oldest first, which is the order every attribution model expects. */
  journey(query: TouchpointQuery): Promise<Result<Touchpoint[]>>;
}

/* ------------------------------------------------------------------ */

export interface PlatformStore {
  readonly exchanges: ValueExchangeStore;
  readonly grants: GrantStore;
  readonly counters: CounterStore;
  readonly funding: FundingStore;
  readonly executions: ExecutionStore;
  readonly ledger: LedgerStore;
  readonly audit: AuditStore;
  readonly touchpoints: TouchpointStore;

  /**
   * Run `work` atomically. Every store reached through the handle passed to
   * `work` participates; an `Err` return or a thrown error rolls the whole
   * thing back.
   *
   * Reserve and capture each run inside one of these. A partial capture -
   * ledger entries written with no execution, or budget spent with no entries -
   * is the worst outcome this platform can produce, and the transaction is
   * what prevents it.
   */
  transaction<T>(work: (tx: PlatformStore) => Promise<Result<T>>): Promise<Result<T>>;

  /** Release underlying resources. Optional; the memory adapter has none. */
  close?(): Promise<void>;
}
