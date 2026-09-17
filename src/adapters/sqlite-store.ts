/**
 * SQLite adapter.
 *
 * A genuinely durable store, using Node's built-in `node:sqlite` - so the
 * platform still has zero runtime dependencies. It exists to prove the ports
 * are implementable against a real database with real transactions, and to give
 * the concurrency tests something whose atomicity is not an accident of being
 * single-threaded.
 *
 * Two properties it demonstrates that the memory adapter cannot:
 *
 *   - `BEGIN IMMEDIATE` takes a write lock for the whole transaction, so the
 *     check-and-consume in `tryConsume` cannot interleave with another one.
 *     This is SQLite's equivalent of `SELECT ... FOR UPDATE`.
 *   - The conditional `UPDATE ... WHERE headroom >= ?` in `tryReserve` pushes
 *     the budget check into the write itself, which is the pattern a Postgres
 *     adapter should use for counters too.
 *
 * Read `sqlite-schema.ts` alongside this: the indexes there are not decoration,
 * they are the difference between a decision path that scales and one that does
 * not.
 */
import { DatabaseSync } from "node:sqlite";
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import { decode, encode } from "../kernel/codec.ts";
import type { ValueExchange, Grant } from "../model/value-exchange.ts";
import type { FundingSource } from "../model/funding.ts";
import type { Execution, ExecutionState } from "../model/execution.ts";
import type { Amount } from "../universal/economic/amount.ts";
import type { LedgerEntry } from "../ledger/ledger.ts";
import type { AuditDraft, AuditRecord } from "../audit/audit-log.ts";
import { GENESIS_HASH, findChainBreak, sealRecord } from "../audit/audit-log.ts";
import type { Touchpoint } from "../attribution/touchpoint.ts";
import { Mutex } from "./mutex.ts";
import { findBreach, findIssuanceBreach, recentWindowFor, MAX_RECENT_RETAINED } from "./limit-rules.ts";
import { SCHEMA } from "./sqlite-schema.ts";
import type {
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

type Row = Record<string, unknown>;

const normalise = (code: string): string => code.trim().toUpperCase();
const text = (value: unknown): string => String(value);
const int = (value: unknown): number => Number(value);
const big = (value: unknown): bigint => (typeof value === "bigint" ? value : BigInt(Number(value)));

/** Shared connection plus transaction depth, so nested calls join the outer one. */
interface Conn {
  readonly db: DatabaseSync;
  depth: number;
}

function run(conn: Conn, sql: string, ...params: unknown[]): number {
  return Number(conn.db.prepare(sql).run(...(params as never[])).changes);
}

function all(conn: Conn, sql: string, ...params: unknown[]): Row[] {
  const statement = conn.db.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all(...(params as never[])) as Row[];
}

function one(conn: Conn, sql: string, ...params: unknown[]): Row | undefined {
  return all(conn, sql, ...params)[0];
}

/* ------------------------------------------------------------------ */

class SqliteExchangeStore implements ValueExchangeStore {
  readonly conn: Conn;
  constructor(conn: Conn) {
    this.conn = conn;
  }

  async put(exchange: ValueExchange): Promise<Result<ValueExchange>> {
    run(
      this.conn,
      `INSERT INTO value_exchange (tenant, id, state, profile, visibility, code_upper, realities, document)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant, id) DO UPDATE SET
         state = excluded.state, profile = excluded.profile, visibility = excluded.visibility,
         code_upper = excluded.code_upper, realities = excluded.realities, document = excluded.document`,
      exchange.tenant,
      exchange.id,
      exchange.state,
      exchange.profile,
      exchange.visibility,
      exchange.acquisition.code === undefined ? null : normalise(exchange.acquisition.code),
      exchange.scope.realities === undefined ? null : encode(exchange.scope.realities),
      encode(exchange),
    );
    return ok(exchange);
  }

  async get(tenant: string, id: string): Promise<Result<ValueExchange>> {
    const row = one(this.conn, `SELECT document FROM value_exchange WHERE tenant = ? AND id = ?`, tenant, id);
    return row
      ? ok(decode<ValueExchange>(text(row.document)))
      : fail(ErrorCode.NOT_FOUND, `no value exchange '${id}'`, { tenant, id });
  }

  async find(tenant: string, query: ValueExchangeQuery = {}): Promise<Result<ValueExchange[]>> {
    const clauses = ["tenant = ?"];
    const params: unknown[] = [tenant];
    for (const [column, value] of [
      ["state", query.state],
      ["profile", query.profile],
      ["visibility", query.visibility],
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    const rows = all(
      this.conn,
      `SELECT document, realities FROM value_exchange WHERE ${clauses.join(" AND ")} ORDER BY id`,
      ...params,
    );
    const found = rows
      .filter((row) => {
        if (query.reality === undefined || row.realities === null) return true;
        return decode<string[]>(text(row.realities)).includes(query.reality);
      })
      .map((row) => decode<ValueExchange>(text(row.document)));
    return ok(found);
  }

  async byCode(tenant: string, code: string): Promise<Result<ValueExchange | undefined>> {
    const row = one(
      this.conn,
      `SELECT document FROM value_exchange WHERE tenant = ? AND code_upper = ? LIMIT 1`,
      tenant,
      normalise(code),
    );
    return ok(row ? decode<ValueExchange>(text(row.document)) : undefined);
  }
}

class SqliteGrantStore implements GrantStore {
  readonly conn: Conn;
  constructor(conn: Conn) {
    this.conn = conn;
  }

  async put(grant: Grant): Promise<Result<Grant>> {
    run(
      this.conn,
      `INSERT INTO grant_row (tenant, id, value_exchange_id, subject_id, code_upper, document)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(tenant, id) DO UPDATE SET
         value_exchange_id = excluded.value_exchange_id, subject_id = excluded.subject_id,
         code_upper = excluded.code_upper, document = excluded.document`,
      grant.tenant,
      grant.id,
      grant.valueExchangeId,
      grant.subjectId ?? null,
      grant.code === undefined ? null : normalise(grant.code),
      encode(grant),
    );
    return ok(grant);
  }

  async get(tenant: string, id: string): Promise<Result<Grant>> {
    const row = one(this.conn, `SELECT document FROM grant_row WHERE tenant = ? AND id = ?`, tenant, id);
    return row ? ok(decode<Grant>(text(row.document))) : fail(ErrorCode.NOT_FOUND, `no grant '${id}'`, { tenant, id });
  }

  async forSubject(tenant: string, subjectId: string): Promise<Result<Grant[]>> {
    const rows = all(
      this.conn,
      `SELECT document FROM grant_row WHERE tenant = ? AND subject_id = ? ORDER BY id`,
      tenant,
      subjectId,
    );
    return ok(rows.map((row) => decode<Grant>(text(row.document))));
  }

  async byCode(tenant: string, code: string): Promise<Result<Grant | undefined>> {
    const row = one(
      this.conn,
      `SELECT document FROM grant_row WHERE tenant = ? AND code_upper = ? LIMIT 1`,
      tenant,
      normalise(code),
    );
    return ok(row ? decode<Grant>(text(row.document)) : undefined);
  }
}

class SqliteCounterStore implements CounterStore {
  readonly conn: Conn;
  readonly tx: <T>(work: () => Result<T>) => Promise<Result<T>>;

  constructor(conn: Conn, tx: <T>(work: () => Result<T>) => Promise<Result<T>>) {
    this.conn = conn;
    this.tx = tx;
  }

  #snapshot(request: CounterReadRequest): CounterSnapshot {
    const { tenant, valueExchangeId, subjectId, atSeconds, recentWindowSeconds } = request;
    const head = one(
      this.conn,
      `SELECT issued, redemptions FROM counter WHERE tenant = ? AND value_exchange_id = ?`,
      tenant,
      valueExchangeId,
    );
    const subject =
      subjectId === undefined
        ? undefined
        : one(
            this.conn,
            `SELECT redemptions FROM counter_subject WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ?`,
            tenant,
            valueExchangeId,
            subjectId,
          );

    const cutoff =
      atSeconds !== undefined && recentWindowSeconds !== undefined ? atSeconds - recentWindowSeconds : -1e18;
    const recent =
      subjectId === undefined
        ? []
        : all(
            this.conn,
            `SELECT at_seconds FROM counter_recent
              WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ? AND at_seconds > ?
              ORDER BY at_seconds`,
            tenant,
            valueExchangeId,
            subjectId,
            cutoff,
          ).map((row) => Number(row.at_seconds));

    const granted = new Map<string, Amount>();
    for (const row of all(
      this.conn,
      `SELECT unit, minor, scale FROM counter_granted WHERE tenant = ? AND value_exchange_id = ?`,
      tenant,
      valueExchangeId,
    )) {
      granted.set(text(row.unit), { unit: text(row.unit), minor: big(row.minor), scale: int(row.scale) });
    }

    return {
      issued: head ? int(head.issued) : 0,
      redemptions: head ? int(head.redemptions) : 0,
      subjectRedemptions: subject ? int(subject.redemptions) : 0,
      subjectRecent: recent,
      grantedByUnit: granted,
    };
  }

  async read(request: CounterReadRequest): Promise<Result<CounterSnapshot>> {
    return ok(this.#snapshot(request));
  }

  async tryConsume(request: ConsumeLimitsRequest): Promise<Result<CounterSnapshot>> {
    // BEGIN IMMEDIATE inside `tx` takes a write lock, so the read below and the
    // writes that follow cannot interleave with another consume. This is the
    // SQLite equivalent of SELECT ... FOR UPDATE.
    return this.tx(() => {
      const window = recentWindowFor(request.limits);
      const before = this.#snapshot({
        tenant: request.tenant,
        valueExchangeId: request.valueExchangeId,
        ...(request.subjectId === undefined ? {} : { subjectId: request.subjectId }),
        atSeconds: request.atSeconds,
        ...(window === undefined ? {} : { recentWindowSeconds: window }),
      });

      const breach = findBreach(before, request.limits, request.subjectId, request.atSeconds, request.granted);
      if (breach) {
        return fail(ErrorCode.LIMIT_EXCEEDED, `${breach.limit}: ${breach.detail}`, {
          limit: breach.limit,
          detail: breach.detail,
          valueExchangeId: request.valueExchangeId,
        });
      }

      run(
        this.conn,
        `INSERT INTO counter (tenant, value_exchange_id, issued, redemptions) VALUES (?,?,0,1)
         ON CONFLICT(tenant, value_exchange_id) DO UPDATE SET redemptions = redemptions + 1`,
        request.tenant,
        request.valueExchangeId,
      );

      if (request.subjectId !== undefined) {
        run(
          this.conn,
          `INSERT INTO counter_subject (tenant, value_exchange_id, subject_id, redemptions) VALUES (?,?,?,1)
           ON CONFLICT(tenant, value_exchange_id, subject_id) DO UPDATE SET redemptions = redemptions + 1`,
          request.tenant,
          request.valueExchangeId,
          request.subjectId,
        );
        run(
          this.conn,
          `INSERT INTO counter_recent (tenant, value_exchange_id, subject_id, at_seconds) VALUES (?,?,?,?)`,
          request.tenant,
          request.valueExchangeId,
          request.subjectId,
          request.atSeconds,
        );
        this.#prune(request.tenant, request.valueExchangeId, request.subjectId, request.atSeconds, window);
      }

      for (const amount of request.granted) {
        run(
          this.conn,
          `INSERT INTO counter_granted (tenant, value_exchange_id, unit, minor, scale) VALUES (?,?,?,?,?)
           ON CONFLICT(tenant, value_exchange_id, unit) DO UPDATE SET minor = minor + excluded.minor`,
          request.tenant,
          request.valueExchangeId,
          amount.unit,
          amount.minor,
          amount.scale,
        );
      }

      return ok(
        this.#snapshot({
          tenant: request.tenant,
          valueExchangeId: request.valueExchangeId,
          ...(request.subjectId === undefined ? {} : { subjectId: request.subjectId }),
          atSeconds: request.atSeconds,
          ...(window === undefined ? {} : { recentWindowSeconds: window }),
        }),
      );
    });
  }

  /** Bound the recent table: by the window in use, and by a hard row cap. */
  #prune(tenant: string, vx: string, subjectId: string, atSeconds: number, window: number | undefined): void {
    if (window !== undefined) {
      run(
        this.conn,
        `DELETE FROM counter_recent
          WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ? AND at_seconds <= ?`,
        tenant,
        vx,
        subjectId,
        atSeconds - window,
      );
    }
    run(
      this.conn,
      `DELETE FROM counter_recent
        WHERE rowid IN (
          SELECT rowid FROM counter_recent
           WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ?
           ORDER BY at_seconds DESC LIMIT -1 OFFSET ?
        )`,
      tenant,
      vx,
      subjectId,
      MAX_RECENT_RETAINED,
    );
  }

  async restore(request: RestoreLimitsRequest): Promise<Result<void>> {
    return this.tx(() => {
      run(
        this.conn,
        `UPDATE counter SET redemptions = MAX(0, redemptions - 1) WHERE tenant = ? AND value_exchange_id = ?`,
        request.tenant,
        request.valueExchangeId,
      );
      if (request.subjectId !== undefined) {
        run(
          this.conn,
          `UPDATE counter_subject SET redemptions = MAX(0, redemptions - 1)
            WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ?`,
          request.tenant,
          request.valueExchangeId,
          request.subjectId,
        );
        run(
          this.conn,
          `DELETE FROM counter_recent WHERE rowid = (
             SELECT rowid FROM counter_recent
              WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ?
              ORDER BY at_seconds DESC LIMIT 1)`,
          request.tenant,
          request.valueExchangeId,
          request.subjectId,
        );
      }
      for (const amount of request.granted) {
        run(
          this.conn,
          `UPDATE counter_granted SET minor = MAX(0, minor - ?)
            WHERE tenant = ? AND value_exchange_id = ? AND unit = ?`,
          amount.minor,
          request.tenant,
          request.valueExchangeId,
          amount.unit,
        );
      }
      return ok(undefined);
    });
  }

  async tryIssue(tenant: string, valueExchangeId: string, cap?: number): Promise<Result<number>> {
    return this.tx(() => {
      const row = one(
        this.conn,
        `SELECT issued FROM counter WHERE tenant = ? AND value_exchange_id = ?`,
        tenant,
        valueExchangeId,
      );
      const issued = row ? int(row.issued) : 0;
      const breach = findIssuanceBreach(issued, cap);
      if (breach) {
        return fail(ErrorCode.LIMIT_EXCEEDED, `${breach.limit}: ${breach.detail}`, {
          limit: breach.limit,
          valueExchangeId,
        });
      }
      run(
        this.conn,
        `INSERT INTO counter (tenant, value_exchange_id, issued, redemptions) VALUES (?,?,1,0)
         ON CONFLICT(tenant, value_exchange_id) DO UPDATE SET issued = issued + 1`,
        tenant,
        valueExchangeId,
      );
      return ok(issued + 1);
    });
  }
}

class SqliteFundingStore implements FundingStore {
  readonly conn: Conn;
  constructor(conn: Conn) {
    this.conn = conn;
  }

  #read(tenant: string, id: string): FundingSource | undefined {
    const row = one(this.conn, `SELECT * FROM funding_source WHERE tenant = ? AND id = ?`, tenant, id);
    if (!row) return undefined;
    const rest = decode<{ label: string; party: FundingSource["party"]; alertBelowPercent?: number }>(
      text(row.document),
    );
    const scale = int(row.scale);
    const unit = text(row.unit);
    return {
      id: text(row.id),
      tenant: text(row.tenant),
      label: rest.label,
      party: rest.party,
      unit,
      ...(row.budget_minor === null ? {} : { budget: { unit, scale, minor: big(row.budget_minor) } }),
      reserved: { unit, scale, minor: big(row.reserved_minor) },
      spent: { unit, scale, minor: big(row.spent_minor) },
      ...(rest.alertBelowPercent === undefined ? {} : { alertBelowPercent: rest.alertBelowPercent }),
    };
  }

  async put(source: FundingSource): Promise<Result<FundingSource>> {
    run(
      this.conn,
      `INSERT INTO funding_source (tenant, id, unit, scale, budget_minor, reserved_minor, spent_minor, document)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant, id) DO UPDATE SET
         unit = excluded.unit, scale = excluded.scale, budget_minor = excluded.budget_minor,
         reserved_minor = excluded.reserved_minor, spent_minor = excluded.spent_minor,
         document = excluded.document`,
      source.tenant,
      source.id,
      source.unit,
      source.reserved.scale,
      source.budget === undefined ? null : source.budget.minor,
      source.reserved.minor,
      source.spent.minor,
      encode({
        label: source.label,
        party: source.party,
        ...(source.alertBelowPercent === undefined ? {} : { alertBelowPercent: source.alertBelowPercent }),
      }),
    );
    return ok(source);
  }

  async get(tenant: string, id: string): Promise<Result<FundingSource>> {
    const found = this.#read(tenant, id);
    return found ? ok(found) : fail(ErrorCode.NOT_FOUND, `no funding source '${id}'`, { tenant, id });
  }

  async list(tenant: string): Promise<Result<FundingSource[]>> {
    const rows = all(this.conn, `SELECT id FROM funding_source WHERE tenant = ? ORDER BY id`, tenant);
    const sources: FundingSource[] = [];
    for (const row of rows) {
      const found = this.#read(tenant, text(row.id));
      if (found) sources.push(found);
    }
    return ok(sources);
  }

  /**
   * The conditional update that makes reservation atomic.
   *
   * The headroom test lives in the WHERE clause, so there is no window between
   * checking and writing. `changes === 0` means the check failed, and nothing
   * was written. This is the pattern every port of this adapter should copy.
   */
  async tryReserve(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>> {
    const existing = this.#read(tenant, sourceId);
    if (!existing) return fail(ErrorCode.NOT_FOUND, `no funding source '${sourceId}'`, { tenant, sourceId });
    if (existing.unit !== amount.unit) {
      return fail(ErrorCode.UNIT_MISMATCH, `source '${sourceId}' is in ${existing.unit}, not ${amount.unit}`);
    }

    const changes = run(
      this.conn,
      `UPDATE funding_source
          SET reserved_minor = reserved_minor + ?
        WHERE tenant = ? AND id = ?
          AND (budget_minor IS NULL OR budget_minor - reserved_minor - spent_minor >= ?)`,
      amount.minor,
      tenant,
      sourceId,
      amount.minor,
    );

    if (changes === 0) {
      const headroom = existing.budget
        ? existing.budget.minor - existing.reserved.minor - existing.spent.minor
        : 0n;
      return fail(ErrorCode.INSUFFICIENT_FUNDS, `funding source '${sourceId}' has ${headroom}, needs ${amount.minor}`, {
        sourceId,
        availableMinor: headroom.toString(),
        requestedMinor: amount.minor.toString(),
        unit: amount.unit,
      });
    }
    return ok(this.#read(tenant, sourceId) as FundingSource);
  }

  async releaseReservation(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>> {
    const changes = run(
      this.conn,
      `UPDATE funding_source SET reserved_minor = reserved_minor - ?
        WHERE tenant = ? AND id = ? AND reserved_minor >= ?`,
      amount.minor,
      tenant,
      sourceId,
      amount.minor,
    );
    if (changes === 0) {
      return fail(ErrorCode.ILLEGAL_STATE, `releasing more than reserved on source '${sourceId}'`, { sourceId });
    }
    return ok(this.#read(tenant, sourceId) as FundingSource);
  }

  async captureReserved(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>> {
    const changes = run(
      this.conn,
      `UPDATE funding_source SET reserved_minor = reserved_minor - ?, spent_minor = spent_minor + ?
        WHERE tenant = ? AND id = ? AND reserved_minor >= ?`,
      amount.minor,
      amount.minor,
      tenant,
      sourceId,
      amount.minor,
    );
    if (changes === 0) {
      return fail(ErrorCode.ILLEGAL_STATE, `capturing more than reserved on source '${sourceId}'`, { sourceId });
    }
    return ok(this.#read(tenant, sourceId) as FundingSource);
  }

  async restoreSpend(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>> {
    run(
      this.conn,
      `UPDATE funding_source SET spent_minor = MAX(0, spent_minor - ?) WHERE tenant = ? AND id = ?`,
      amount.minor,
      tenant,
      sourceId,
    );
    const found = this.#read(tenant, sourceId);
    return found ? ok(found) : fail(ErrorCode.NOT_FOUND, `no funding source '${sourceId}'`, { tenant, sourceId });
  }
}

class SqliteExecutionStore implements ExecutionStore {
  readonly conn: Conn;
  constructor(conn: Conn) {
    this.conn = conn;
  }

  async put(execution: Execution): Promise<Result<Execution>> {
    run(
      this.conn,
      `INSERT INTO execution (tenant, id, state, idempotency_key, subject_id, created_at, document)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(tenant, id) DO UPDATE SET state = excluded.state, document = excluded.document`,
      execution.tenant,
      execution.id,
      execution.state,
      execution.idempotencyKey ?? null,
      execution.subjectId ?? null,
      execution.createdAt,
      encode(execution),
    );
    return ok(execution);
  }

  async get(tenant: string, id: string): Promise<Result<Execution>> {
    const row = one(this.conn, `SELECT document FROM execution WHERE tenant = ? AND id = ?`, tenant, id);
    return row
      ? ok(decode<Execution>(text(row.document)))
      : fail(ErrorCode.NOT_FOUND, `no execution '${id}'`, { tenant, id });
  }

  async byIdempotencyKey(tenant: string, idempotencyKey: string): Promise<Result<Execution | undefined>> {
    const row = one(
      this.conn,
      `SELECT document FROM execution WHERE tenant = ? AND idempotency_key = ?`,
      tenant,
      idempotencyKey,
    );
    return ok(row ? decode<Execution>(text(row.document)) : undefined);
  }

  async forSubject(tenant: string, subjectId: string): Promise<Result<Execution[]>> {
    const rows = all(
      this.conn,
      `SELECT document FROM execution WHERE tenant = ? AND subject_id = ? ORDER BY id`,
      tenant,
      subjectId,
    );
    return ok(rows.map((row) => decode<Execution>(text(row.document))));
  }

  async staleByState(
    tenant: string,
    state: ExecutionState,
    olderThan: string,
    limit: number,
  ): Promise<Result<Execution[]>> {
    const rows = all(
      this.conn,
      `SELECT document FROM execution
        WHERE tenant = ? AND state = ? AND CAST(created_at AS INTEGER) < CAST(? AS INTEGER)
        ORDER BY CAST(created_at AS INTEGER) LIMIT ?`,
      tenant,
      state,
      olderThan,
      limit,
    );
    return ok(rows.map((row) => decode<Execution>(text(row.document))));
  }
}

class SqliteLedgerStore implements LedgerStore {
  readonly conn: Conn;
  constructor(conn: Conn) {
    this.conn = conn;
  }

  async append(entries: readonly LedgerEntry[]): Promise<Result<readonly LedgerEntry[]>> {
    for (const entry of entries) {
      const next = one(this.conn, `SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM ledger_entry WHERE tenant = ?`, entry.tenant);
      run(
        this.conn,
        `INSERT INTO ledger_entry (tenant, id, transaction_id, account_id, reference_id, seq, document)
         VALUES (?,?,?,?,?,?,?)`,
        entry.tenant,
        entry.id,
        entry.transactionId,
        entry.accountId,
        entry.reference.id,
        next ? int(next.n) : 0,
        encode(entry),
      );
    }
    return ok(entries);
  }

  async entriesFor(tenant: string, accountId: string): Promise<Result<LedgerEntry[]>> {
    const rows = all(
      this.conn,
      `SELECT document FROM ledger_entry WHERE tenant = ? AND account_id = ? ORDER BY seq`,
      tenant,
      accountId,
    );
    return ok(rows.map((row) => decode<LedgerEntry>(text(row.document))));
  }

  async byReference(tenant: string, referenceId: string): Promise<Result<LedgerEntry[]>> {
    const rows = all(
      this.conn,
      `SELECT document FROM ledger_entry WHERE tenant = ? AND reference_id = ? ORDER BY seq`,
      tenant,
      referenceId,
    );
    return ok(rows.map((row) => decode<LedgerEntry>(text(row.document))));
  }

  async all(tenant: string): Promise<Result<LedgerEntry[]>> {
    const rows = all(this.conn, `SELECT document FROM ledger_entry WHERE tenant = ? ORDER BY seq`, tenant);
    return ok(rows.map((row) => decode<LedgerEntry>(text(row.document))));
  }
}

class SqliteAuditStore implements AuditStore {
  readonly conn: Conn;
  constructor(conn: Conn) {
    this.conn = conn;
  }

  async append(draft: AuditDraft): Promise<Result<AuditRecord>> {
    const head = one(
      this.conn,
      `SELECT seq, hash FROM audit_record WHERE tenant = ? ORDER BY seq DESC LIMIT 1`,
      draft.tenant,
    );
    const seq = head ? int(head.seq) + 1 : 0;
    const previousHash = head ? text(head.hash) : GENESIS_HASH;
    const record = sealRecord(draft, seq, previousHash);
    run(
      this.conn,
      `INSERT INTO audit_record (tenant, seq, hash, document) VALUES (?,?,?,?)`,
      record.tenant,
      record.seq,
      record.hash,
      encode(record),
    );
    return ok(record);
  }

  async head(tenant: string): Promise<Result<string>> {
    const row = one(this.conn, `SELECT hash FROM audit_record WHERE tenant = ? ORDER BY seq DESC LIMIT 1`, tenant);
    return ok(row ? text(row.hash) : GENESIS_HASH);
  }

  async recent(tenant: string, limit: number): Promise<Result<AuditRecord[]>> {
    const rows = all(
      this.conn,
      `SELECT document FROM audit_record WHERE tenant = ? ORDER BY seq DESC LIMIT ?`,
      tenant,
      limit,
    );
    return ok(rows.map((row) => decode<AuditRecord>(text(row.document))).reverse());
  }

  async verify(tenant: string, fromSeq = 0): Promise<Result<{ records: number; head: string }>> {
    const rows = all(
      this.conn,
      `SELECT document FROM audit_record WHERE tenant = ? AND seq >= ? ORDER BY seq`,
      tenant,
      fromSeq,
    );
    const records = rows.map((row) => decode<AuditRecord>(text(row.document)));

    let startingHash = GENESIS_HASH;
    if (fromSeq > 0) {
      const previous = one(
        this.conn,
        `SELECT hash FROM audit_record WHERE tenant = ? AND seq = ?`,
        tenant,
        fromSeq - 1,
      );
      startingHash = previous ? text(previous.hash) : GENESIS_HASH;
    }

    const broken = findChainBreak(records, startingHash);
    if (broken) {
      return fail(
        ErrorCode.CONFLICT,
        `audit chain broken at seq ${broken.seq}: record was ${broken.reason === "link" ? "reordered or removed" : "modified"}`,
        { seq: broken.seq, reason: broken.reason, expected: broken.expected, found: broken.found },
      );
    }

    const total = one(this.conn, `SELECT COUNT(*) AS n FROM audit_record WHERE tenant = ?`, tenant);
    const head = records.length > 0 ? (records[records.length - 1] as AuditRecord).hash : startingHash;
    return ok({ records: total ? int(total.n) : 0, head });
  }
}

class SqliteTouchpointStore implements TouchpointStore {
  readonly conn: Conn;
  constructor(conn: Conn) {
    this.conn = conn;
  }

  async append(touchpoint: Touchpoint): Promise<Result<Touchpoint>> {
    run(
      this.conn,
      `INSERT INTO touchpoint (tenant, id, subject_id, device_id, value_exchange_id, at, document)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(tenant, id) DO UPDATE SET document = excluded.document`,
      touchpoint.tenant,
      touchpoint.id,
      touchpoint.subjectId ?? null,
      touchpoint.deviceId ?? null,
      touchpoint.valueExchangeId ?? null,
      touchpoint.at,
      encode(touchpoint),
    );
    return ok(touchpoint);
  }

  async journey(query: TouchpointQuery): Promise<Result<Touchpoint[]>> {
    const rows = all(this.conn, `SELECT document FROM touchpoint WHERE tenant = ?`, query.tenant);
    const since = query.since === undefined ? null : BigInt(query.since);

    const found = rows
      .map((row) => decode<Touchpoint>(text(row.document)))
      .filter((t) => {
        if (query.subjectId !== undefined) {
          if (t.subjectId !== query.subjectId && t.deviceId !== query.deviceId) return false;
        } else if (query.deviceId !== undefined && t.deviceId !== query.deviceId) {
          return false;
        }
        if (
          query.valueExchangeId !== undefined &&
          t.valueExchangeId !== undefined &&
          t.valueExchangeId !== query.valueExchangeId
        ) {
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

export interface SqliteOptions {
  /** File path, or ":memory:" for an ephemeral database. */
  readonly location?: string;
}

export class SqlitePlatformStore implements PlatformStore {
  readonly #db: DatabaseSync;
  readonly #conn: Conn;
  readonly #lock = new Mutex();

  readonly exchanges: ValueExchangeStore;
  readonly grants: GrantStore;
  readonly counters: CounterStore;
  readonly funding: FundingStore;
  readonly executions: ExecutionStore;
  readonly ledger: LedgerStore;
  readonly audit: AuditStore;
  readonly touchpoints: TouchpointStore;

  constructor(options: SqliteOptions = {}) {
    this.#db = new DatabaseSync(options.location ?? ":memory:");
    this.#conn = { db: this.#db, depth: 0 };
    this.#db.exec(SCHEMA);

    const inTx = <T>(work: () => Result<T>): Promise<Result<T>> => this.#atomic(work);

    this.exchanges = new SqliteExchangeStore(this.#conn);
    this.grants = new SqliteGrantStore(this.#conn);
    this.counters = new SqliteCounterStore(this.#conn, inTx);
    this.funding = new SqliteFundingStore(this.#conn);
    this.executions = new SqliteExecutionStore(this.#conn);
    this.ledger = new SqliteLedgerStore(this.#conn);
    this.audit = new SqliteAuditStore(this.#conn);
    this.touchpoints = new SqliteTouchpointStore(this.#conn);
  }

  /** Synchronous critical section, joining an outer transaction if one is open. */
  async #atomic<T>(work: () => Result<T>): Promise<Result<T>> {
    if (this.#conn.depth > 0) return work();
    return this.#lock.run(() => {
      this.#db.exec("BEGIN IMMEDIATE");
      this.#conn.depth += 1;
      try {
        const outcome = work();
        this.#db.exec(outcome.ok ? "COMMIT" : "ROLLBACK");
        return outcome;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      } finally {
        this.#conn.depth -= 1;
      }
    });
  }

  async transaction<T>(work: (tx: PlatformStore) => Promise<Result<T>>): Promise<Result<T>> {
    if (this.#conn.depth > 0) return work(this);

    return this.#lock.run(async () => {
      this.#db.exec("BEGIN IMMEDIATE");
      this.#conn.depth += 1;
      try {
        const outcome = await work(this);
        this.#db.exec(outcome.ok ? "COMMIT" : "ROLLBACK");
        return outcome;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      } finally {
        this.#conn.depth -= 1;
      }
    });
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
