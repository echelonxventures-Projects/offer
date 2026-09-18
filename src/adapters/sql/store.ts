/**
 * The SQL adapter.
 *
 * One store, every SQL database. The dialect supplies the four type names and
 * the handful of places two SQL engines genuinely disagree; everything else -
 * the schema, the indexes, the queries and the atomicity - is shared, because
 * two copies of this would drift and two adapters that were meant to be the
 * same store would quietly stop being it.
 *
 * Two properties it demonstrates that the memory adapter cannot:
 *
 *   - The transaction wrapper takes a write lock for the whole critical
 *     section, so the check-and-consume in `tryConsume` cannot interleave with
 *     another one. SQLite needs `BEGIN IMMEDIATE` to do this; Postgres takes
 *     row locks as it goes.
 *   - The conditional `UPDATE ... WHERE headroom >= ?` in `tryReserve` pushes
 *     the budget check into the write itself. That is the pattern every port of
 *     this adapter should copy.
 *
 * Read `schema.ts` alongside this: the indexes there are not decoration, they
 * are the difference between a decision path that scales and one that does not.
 *
 * Queries are written with `?` placeholders whatever the dialect. The session
 * renumbers them, so the SQL in this file reads the same for every database.
 */
import type { Result } from "../../kernel/result.ts";
import { fail, ok } from "../../kernel/result.ts";
import { ErrorCode } from "../../kernel/errors.ts";
import { decode, encode } from "../../kernel/codec.ts";
import type { ValueExchange, Grant } from "../../model/value-exchange.ts";
import type { FundingSource } from "../../model/funding.ts";
import type { Execution, ExecutionState } from "../../model/execution.ts";
import type { Amount } from "../../universal/economic/amount.ts";
import type { LedgerEntry } from "../../ledger/ledger.ts";
import type { AccountPosition } from "../../ledger/positions.ts";
import type { AuditDraft, AuditRecord } from "../../audit/audit-log.ts";
import { GENESIS_HASH, findChainBreak, sealRecord } from "../../audit/audit-log.ts";
import type { Touchpoint } from "../../attribution/touchpoint.ts";
import { Mutex } from "../mutex.ts";
import { findBreach, findIssuanceBreach, recentWindowFor, MAX_RECENT_RETAINED } from "../limit-rules.ts";
import { compareKeys } from "../../kernel/order.ts";
import type { SqlClient } from "./client.ts";
import { renumberPlaceholders } from "./client.ts";
import type { SqlDialect } from "./dialect.ts";
import { schemaStatements } from "./schema.ts";
import type {
  AuditCheckpoint,
  LedgerSnapshot,
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
} from "../store.ts";

type Row = Record<string, unknown>;

const normalise = (code: string): string => code.trim().toUpperCase();
const text = (value: unknown): string => String(value);
const int = (value: unknown): number => Number(value);
const big = (value: unknown): bigint => (typeof value === "bigint" ? value : BigInt(Number(value)));

/**
 * A connection, plus the transaction depth so a nested call joins the outer one.
 *
 * `run`, `all` and `one` stay variadic because every query in this file was
 * written that way and reads better for it. The session is what turns them into
 * the driver's positional form.
 */
export class SqlSession {
  readonly client: SqlClient;
  readonly dialect: SqlDialect;
  depth = 0;

  constructor(client: SqlClient, dialect: SqlDialect) {
    this.client = client;
    this.dialect = dialect;
  }

  #sql(sql: string): string {
    return renumberPlaceholders(sql, (index) => this.dialect.placeholder(index));
  }

  /** Rows affected. `0` from a conditional update means the condition failed. */
  async run(sql: string, ...params: unknown[]): Promise<number> {
    return this.client.execute(this.#sql(sql), params);
  }

  async all(sql: string, ...params: unknown[]): Promise<Row[]> {
    return (await this.client.query(this.#sql(sql), params)) as Row[];
  }

  async one(sql: string, ...params: unknown[]): Promise<Row | undefined> {
    return (await this.all(sql, ...params))[0];
  }

  /** Read an integer column exactly. Drivers disagree; the dialect decides. */
  big(value: unknown): bigint {
    return this.dialect.toBigInt(value);
  }
}

/* ------------------------------------------------------------------ */

class SqlExchangeStore implements ValueExchangeStore {
  readonly db: SqlSession;
  constructor(db: SqlSession) {
    this.db = db;
  }

  async put(exchange: ValueExchange): Promise<Result<ValueExchange>> {
    await this.db.run(
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
    const row = await this.db.one(`SELECT document FROM value_exchange WHERE tenant = ? AND id = ?`, tenant, id);
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
    const rows = await this.db.all(
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
    const row = await this.db.one(
      `SELECT document FROM value_exchange WHERE tenant = ? AND code_upper = ? LIMIT 1`,
      tenant,
      normalise(code),
    );
    return ok(row ? decode<ValueExchange>(text(row.document)) : undefined);
  }
}

class SqlGrantStore implements GrantStore {
  readonly db: SqlSession;
  constructor(db: SqlSession) {
    this.db = db;
  }

  async put(grant: Grant): Promise<Result<Grant>> {
    await this.db.run(
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
    const row = await this.db.one(`SELECT document FROM grant_row WHERE tenant = ? AND id = ?`, tenant, id);
    return row ? ok(decode<Grant>(text(row.document))) : fail(ErrorCode.NOT_FOUND, `no grant '${id}'`, { tenant, id });
  }

  async forSubject(tenant: string, subjectId: string): Promise<Result<Grant[]>> {
    const rows = await this.db.all(
      `SELECT document FROM grant_row WHERE tenant = ? AND subject_id = ? ORDER BY id`,
      tenant,
      subjectId,
    );
    return ok(rows.map((row) => decode<Grant>(text(row.document))));
  }

  async byCode(tenant: string, code: string): Promise<Result<Grant | undefined>> {
    const row = await this.db.one(
      `SELECT document FROM grant_row WHERE tenant = ? AND code_upper = ? LIMIT 1`,
      tenant,
      normalise(code),
    );
    return ok(row ? decode<Grant>(text(row.document)) : undefined);
  }
}

class SqlCounterStore implements CounterStore {
  readonly db: SqlSession;
  readonly tx: <T>(work: () => Promise<Result<T>>) => Promise<Result<T>>;

  constructor(db: SqlSession, tx: <T>(work: () => Promise<Result<T>>) => Promise<Result<T>>) {
    this.db = db;
    this.tx = tx;
  }

  async #snapshot(request: CounterReadRequest): Promise<CounterSnapshot> {
    const { tenant, valueExchangeId, subjectId, atSeconds, recentWindowSeconds } = request;
    const head = await this.db.one(
      `SELECT issued, redemptions FROM counter WHERE tenant = ? AND value_exchange_id = ?`,
      tenant,
      valueExchangeId,
    );
    const subject =
      subjectId === undefined
        ? undefined
        : await this.db.one(
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
        : (
            await this.db.all(
              `SELECT at_seconds FROM counter_recent
                WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ? AND at_seconds > ?
                ORDER BY at_seconds`,
              tenant,
              valueExchangeId,
              subjectId,
              cutoff,
            )
          ).map((row) => Number(row.at_seconds));

    const granted = new Map<string, Amount>();
    for (const row of await this.db.all(
      `SELECT unit, minor, scale FROM counter_granted WHERE tenant = ? AND value_exchange_id = ?`,
      tenant,
      valueExchangeId,
    )) {
      granted.set(text(row.unit), { unit: text(row.unit), minor: this.db.big(row.minor), scale: int(row.scale) });
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
    return ok(await this.#snapshot(request));
  }

  async tryConsume(request: ConsumeLimitsRequest): Promise<Result<CounterSnapshot>> {
    // BEGIN IMMEDIATE inside `tx` takes a write lock, so the read below and the
    // writes that follow cannot interleave with another consume. This is the
    // SQLite equivalent of SELECT ... FOR UPDATE.
    return this.tx(async () => {
      const window = recentWindowFor(request.limits);
      const before = await this.#snapshot({
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

      await this.db.run(
        `INSERT INTO counter (tenant, value_exchange_id, issued, redemptions) VALUES (?,?,0,1)
         ON CONFLICT(tenant, value_exchange_id) DO UPDATE SET redemptions = counter.redemptions + 1`,
        request.tenant,
        request.valueExchangeId,
      );

      if (request.subjectId !== undefined) {
        await this.db.run(
          `INSERT INTO counter_subject (tenant, value_exchange_id, subject_id, redemptions) VALUES (?,?,?,1)
           ON CONFLICT(tenant, value_exchange_id, subject_id) DO UPDATE SET redemptions = counter_subject.redemptions + 1`,
          request.tenant,
          request.valueExchangeId,
          request.subjectId,
        );
        await this.db.run(
          `INSERT INTO counter_recent (tenant, value_exchange_id, subject_id, at_seconds, seq)
           VALUES (?,?,?,?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM counter_recent
                              WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ?))`,
          request.tenant,
          request.valueExchangeId,
          request.subjectId,
          request.atSeconds,
          request.tenant,
          request.valueExchangeId,
          request.subjectId,
        );
        await this.#prune(request.tenant, request.valueExchangeId, request.subjectId, request.atSeconds, window);
      }

      for (const amount of request.granted) {
        await this.db.run(
          `INSERT INTO counter_granted (tenant, value_exchange_id, unit, minor, scale) VALUES (?,?,?,?,?)
           ON CONFLICT(tenant, value_exchange_id, unit) DO UPDATE SET minor = counter_granted.minor + excluded.minor`,
          request.tenant,
          request.valueExchangeId,
          amount.unit,
          amount.minor,
          amount.scale,
        );
      }

      return ok(
        await this.#snapshot({
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
  async #prune(
    tenant: string,
    vx: string,
    subjectId: string,
    atSeconds: number,
    window: number | undefined,
  ): Promise<void> {
    if (window !== undefined) {
      await this.db.run(
        `DELETE FROM counter_recent
          WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ? AND at_seconds <= ?`,
        tenant,
        vx,
        subjectId,
        atSeconds - window,
      );
    }
    // Keep the newest MAX_RECENT_RETAINED rows and drop the rest.
    //
    // Expressed against `seq` rather than SQLite's rowid, and with a plain
    // LIMIT rather than `LIMIT -1 OFFSET n`, because neither is portable. The
    // subquery names the rows to keep; everything else for this subject goes.
    await this.db.run(
      `DELETE FROM counter_recent
        WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ?
          AND seq NOT IN (
            SELECT seq FROM counter_recent
             WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ?
             ORDER BY seq DESC LIMIT ?
          )`,
      tenant,
      vx,
      subjectId,
      tenant,
      vx,
      subjectId,
      MAX_RECENT_RETAINED,
    );
  }

  async restore(request: RestoreLimitsRequest): Promise<Result<void>> {
    return this.tx(async () => {
      await this.db.run(
        `UPDATE counter SET redemptions = ${this.db.dialect.greatest('0', 'redemptions - 1')} WHERE tenant = ? AND value_exchange_id = ?`,
        request.tenant,
        request.valueExchangeId,
      );
      if (request.subjectId !== undefined) {
        await this.db.run(
          `UPDATE counter_subject SET redemptions = ${this.db.dialect.greatest('0', 'redemptions - 1')}
            WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ?`,
          request.tenant,
          request.valueExchangeId,
          request.subjectId,
        );
        await this.db.run(
          // The most recently inserted row, by insertion order rather than by
          // timestamp: two redemptions in the same second are ordinary, and
          // undoing "one of them" has to name exactly one.
          `DELETE FROM counter_recent
            WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ?
              AND seq = (SELECT MAX(seq) FROM counter_recent
                          WHERE tenant = ? AND value_exchange_id = ? AND subject_id = ?)`,
          request.tenant,
          request.valueExchangeId,
          request.subjectId,
          request.tenant,
          request.valueExchangeId,
          request.subjectId,
        );
      }
      for (const amount of request.granted) {
        await this.db.run(
          `UPDATE counter_granted SET minor = ${this.db.dialect.greatest('0', 'minor - ?')}
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
    return this.tx(async () => {
      const row = await this.db.one(
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
      await this.db.run(
        `INSERT INTO counter (tenant, value_exchange_id, issued, redemptions) VALUES (?,?,1,0)
         ON CONFLICT(tenant, value_exchange_id) DO UPDATE SET issued = counter.issued + 1`,
        tenant,
        valueExchangeId,
      );
      return ok(issued + 1);
    });
  }
}

class SqlFundingStore implements FundingStore {
  readonly db: SqlSession;
  constructor(db: SqlSession) {
    this.db = db;
  }

  async #read(tenant: string, id: string): Promise<FundingSource | undefined> {
    const row = await this.db.one(`SELECT * FROM funding_source WHERE tenant = ? AND id = ?`, tenant, id);
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
      ...(row.budget_minor === null ? {} : { budget: { unit, scale, minor: this.db.big(row.budget_minor) } }),
      reserved: { unit, scale, minor: this.db.big(row.reserved_minor) },
      spent: { unit, scale, minor: this.db.big(row.spent_minor) },
      ...(rest.alertBelowPercent === undefined ? {} : { alertBelowPercent: rest.alertBelowPercent }),
    };
  }

  async put(source: FundingSource): Promise<Result<FundingSource>> {
    await this.db.run(
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
    const found = await this.#read(tenant, id);
    return found ? ok(found) : fail(ErrorCode.NOT_FOUND, `no funding source '${id}'`, { tenant, id });
  }

  async list(tenant: string): Promise<Result<FundingSource[]>> {
    const rows = await this.db.all(`SELECT id FROM funding_source WHERE tenant = ? ORDER BY id`, tenant);
    const sources: FundingSource[] = [];
    for (const row of rows) {
      const found = await this.#read(tenant, text(row.id));
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
    const existing = await this.#read(tenant, sourceId);
    if (!existing) return fail(ErrorCode.NOT_FOUND, `no funding source '${sourceId}'`, { tenant, sourceId });
    if (existing.unit !== amount.unit) {
      return fail(ErrorCode.UNIT_MISMATCH, `source '${sourceId}' is in ${existing.unit}, not ${amount.unit}`);
    }

    const changes = await this.db.run(
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
    return ok(await this.#read(tenant, sourceId) as FundingSource);
  }

  async releaseReservation(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>> {
    const changes = await this.db.run(
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
    return ok(await this.#read(tenant, sourceId) as FundingSource);
  }

  async captureReserved(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>> {
    const changes = await this.db.run(
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
    return ok(await this.#read(tenant, sourceId) as FundingSource);
  }

  async restoreSpend(tenant: string, sourceId: string, amount: Amount): Promise<Result<FundingSource>> {
    await this.db.run(
      `UPDATE funding_source SET spent_minor = ${this.db.dialect.greatest('0', 'spent_minor - ?')} WHERE tenant = ? AND id = ?`,
      amount.minor,
      tenant,
      sourceId,
    );
    const found = await this.#read(tenant, sourceId);
    return found ? ok(found) : fail(ErrorCode.NOT_FOUND, `no funding source '${sourceId}'`, { tenant, sourceId });
  }
}

class SqlExecutionStore implements ExecutionStore {
  readonly db: SqlSession;
  constructor(db: SqlSession) {
    this.db = db;
  }

  async put(execution: Execution): Promise<Result<Execution>> {
    await this.db.run(
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
    const row = await this.db.one(`SELECT document FROM execution WHERE tenant = ? AND id = ?`, tenant, id);
    return row
      ? ok(decode<Execution>(text(row.document)))
      : fail(ErrorCode.NOT_FOUND, `no execution '${id}'`, { tenant, id });
  }

  async byIdempotencyKey(tenant: string, idempotencyKey: string): Promise<Result<Execution | undefined>> {
    const row = await this.db.one(
      `SELECT document FROM execution WHERE tenant = ? AND idempotency_key = ?`,
      tenant,
      idempotencyKey,
    );
    return ok(row ? decode<Execution>(text(row.document)) : undefined);
  }

  async forSubject(tenant: string, subjectId: string): Promise<Result<Execution[]>> {
    const rows = await this.db.all(
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
    // `created_at` is an opaque tick token stored as text, so ordering it by
    // age means casting. The cast type comes from the dialect because SQLite's
    // INTEGER is 64-bit and Postgres's is 32-bit - and a millisecond epoch
    // overflows the latter, which presents as "value out of range" from inside
    // a reservation sweep.
    const tick = this.db.dialect.types.integer;
    const rows = await this.db.all(
      `SELECT document FROM execution
        WHERE tenant = ? AND state = ? AND CAST(created_at AS ${tick}) < CAST(? AS ${tick})
        ORDER BY CAST(created_at AS ${tick}) LIMIT ?`,
      tenant,
      state,
      olderThan,
      limit,
    );
    return ok(rows.map((row) => decode<Execution>(text(row.document))));
  }
}

class SqlLedgerStore implements LedgerStore {
  readonly db: SqlSession;
  constructor(db: SqlSession) {
    this.db = db;
  }

  async append(entries: readonly LedgerEntry[]): Promise<Result<readonly LedgerEntry[]>> {
    for (const entry of entries) {
      const next = await this.db.one(`SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM ledger_entry WHERE tenant = ?`, entry.tenant);
      await this.db.run(
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
    const rows = await this.db.all(
      `SELECT document FROM ledger_entry WHERE tenant = ? AND account_id = ? ORDER BY seq`,
      tenant,
      accountId,
    );
    return ok(rows.map((row) => decode<LedgerEntry>(text(row.document))));
  }

  async byReference(tenant: string, referenceId: string): Promise<Result<LedgerEntry[]>> {
    const rows = await this.db.all(
      `SELECT document FROM ledger_entry WHERE tenant = ? AND reference_id = ? ORDER BY seq`,
      tenant,
      referenceId,
    );
    return ok(rows.map((row) => decode<LedgerEntry>(text(row.document))));
  }

  async all(tenant: string): Promise<Result<LedgerEntry[]>> {
    const rows = await this.db.all(`SELECT document FROM ledger_entry WHERE tenant = ? ORDER BY seq`, tenant);
    return ok(rows.map((row) => decode<LedgerEntry>(text(row.document))));
  }

  async headSeq(tenant: string): Promise<Result<number>> {
    const row = await this.db.one(`SELECT COALESCE(MAX(seq), -1) AS n FROM ledger_entry WHERE tenant = ?`, tenant);
    return ok(row ? int(row.n) : -1);
  }

  async entriesSince(
    tenant: string,
    afterSeq: number,
    limit: number,
  ): Promise<Result<{ entries: LedgerEntry[]; lastSeq: number }>> {
    const rows = await this.db.all(
      `SELECT seq, document FROM ledger_entry WHERE tenant = ? AND seq > ? ORDER BY seq LIMIT ?`,
      tenant,
      afterSeq,
      limit,
    );
    const entries = rows.map((row) => decode<LedgerEntry>(text(row.document)));
    const lastSeq = rows.length === 0 ? afterSeq : int(rows[rows.length - 1]!.seq);
    return ok({ entries, lastSeq });
  }

  async saveSnapshot(snapshot: LedgerSnapshot): Promise<Result<LedgerSnapshot>> {
    await this.db.run(
      `INSERT INTO ledger_snapshot (tenant, through_seq, at, positions) VALUES (?,?,?,?)
       ON CONFLICT(tenant) DO UPDATE SET through_seq = excluded.through_seq, at = excluded.at, positions = excluded.positions`,
      snapshot.tenant,
      snapshot.throughSeq,
      snapshot.at,
      encode(snapshot.positions),
    );
    return ok(snapshot);
  }

  async latestSnapshot(tenant: string): Promise<Result<LedgerSnapshot | undefined>> {
    const row = await this.db.one(`SELECT * FROM ledger_snapshot WHERE tenant = ?`, tenant);
    if (!row) return ok(undefined);
    return ok({
      tenant: text(row.tenant),
      throughSeq: int(row.through_seq),
      at: text(row.at),
      positions: decode<AccountPosition[]>(text(row.positions)),
    });
  }
}

class SqlAuditStore implements AuditStore {
  readonly db: SqlSession;
  constructor(db: SqlSession) {
    this.db = db;
  }

  async append(draft: AuditDraft): Promise<Result<AuditRecord>> {
    const head = await this.db.one(
      `SELECT seq, hash FROM audit_record WHERE tenant = ? ORDER BY seq DESC LIMIT 1`,
      draft.tenant,
    );
    const seq = head ? int(head.seq) + 1 : 0;
    const previousHash = head ? text(head.hash) : GENESIS_HASH;
    const record = sealRecord(draft, seq, previousHash);
    await this.db.run(
      `INSERT INTO audit_record (tenant, seq, hash, document) VALUES (?,?,?,?)`,
      record.tenant,
      record.seq,
      record.hash,
      encode(record),
    );
    return ok(record);
  }

  async head(tenant: string): Promise<Result<string>> {
    const row = await this.db.one(`SELECT hash FROM audit_record WHERE tenant = ? ORDER BY seq DESC LIMIT 1`, tenant);
    return ok(row ? text(row.hash) : GENESIS_HASH);
  }

  async headSeq(tenant: string): Promise<Result<number>> {
    const row = await this.db.one(`SELECT COALESCE(MAX(seq), -1) AS n FROM audit_record WHERE tenant = ?`, tenant);
    return ok(row ? int(row.n) : -1);
  }

  async at(tenant: string, seq: number): Promise<Result<AuditRecord | undefined>> {
    const row = await this.db.one(`SELECT document FROM audit_record WHERE tenant = ? AND seq = ?`, tenant, seq);
    return ok(row ? decode<AuditRecord>(text(row.document)) : undefined);
  }

  async saveCheckpoint(checkpoint: AuditCheckpoint): Promise<Result<AuditCheckpoint>> {
    await this.db.run(
      `INSERT INTO audit_checkpoint (tenant, seq, hash, at) VALUES (?,?,?,?)
       ON CONFLICT(tenant) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, at = excluded.at`,
      checkpoint.tenant,
      checkpoint.seq,
      checkpoint.hash,
      checkpoint.at,
    );
    return ok(checkpoint);
  }

  async latestCheckpoint(tenant: string): Promise<Result<AuditCheckpoint | undefined>> {
    const row = await this.db.one(`SELECT tenant, seq, hash, at FROM audit_checkpoint WHERE tenant = ?`, tenant);
    if (!row) return ok(undefined);
    return ok({ tenant: text(row.tenant), seq: int(row.seq), hash: text(row.hash), at: text(row.at) });
  }

  async recent(tenant: string, limit: number): Promise<Result<AuditRecord[]>> {
    const rows = await this.db.all(
      `SELECT document FROM audit_record WHERE tenant = ? ORDER BY seq DESC LIMIT ?`,
      tenant,
      limit,
    );
    return ok(rows.map((row) => decode<AuditRecord>(text(row.document))).reverse());
  }

  async range(tenant: string, fromSeq: number, limit: number): Promise<Result<AuditRecord[]>> {
    const rows = await this.db.all(
      `SELECT document FROM audit_record WHERE tenant = ? AND seq >= ? ORDER BY seq LIMIT ?`,
      tenant,
      Math.max(0, fromSeq),
      Math.max(0, limit),
    );
    return ok(rows.map((row) => decode<AuditRecord>(text(row.document))));
  }

  async verify(tenant: string, fromSeq = 0): Promise<Result<{ records: number; head: string }>> {
    const rows = await this.db.all(
      `SELECT document FROM audit_record WHERE tenant = ? AND seq >= ? ORDER BY seq`,
      tenant,
      fromSeq,
    );
    const records = rows.map((row) => decode<AuditRecord>(text(row.document)));

    let startingHash = GENESIS_HASH;
    if (fromSeq > 0) {
      const previous = await this.db.one(
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

    const total = await this.db.one(`SELECT COUNT(*) AS n FROM audit_record WHERE tenant = ?`, tenant);
    const head = records.length > 0 ? (records[records.length - 1] as AuditRecord).hash : startingHash;
    return ok({ records: total ? int(total.n) : 0, head });
  }
}

class SqlTouchpointStore implements TouchpointStore {
  readonly db: SqlSession;
  constructor(db: SqlSession) {
    this.db = db;
  }

  async append(touchpoint: Touchpoint): Promise<Result<Touchpoint>> {
    await this.db.run(
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
    const rows = await this.db.all(`SELECT document FROM touchpoint WHERE tenant = ?`, query.tenant);
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
      .sort((a, b) => (BigInt(a.at) < BigInt(b.at) ? -1 : BigInt(a.at) > BigInt(b.at) ? 1 : compareKeys(a.id, b.id)));

    return ok(query.limit === undefined ? found : found.slice(0, query.limit));
  }
}

/* ------------------------------------------------------------------ */

/**
 * Open a store against an already-connected client.
 *
 * The client is a port, so a deployment brings its own driver and its own
 * pooling. Creating the schema is opt-out rather than opt-in: a store whose
 * tables do not exist fails on its first write, and the failure names a
 * missing table rather than the reason.
 */
export interface SqlStoreOptions {
  readonly client: SqlClient;
  readonly dialect: SqlDialect;
  /** Skip DDL when migrations are owned elsewhere. Default: create it. */
  readonly createSchema?: boolean;
}

export class SqlPlatformStore implements PlatformStore {
  readonly #session: SqlSession;
  readonly #lock = new Mutex();

  readonly exchanges: ValueExchangeStore;
  readonly grants: GrantStore;
  readonly counters: CounterStore;
  readonly funding: FundingStore;
  readonly executions: ExecutionStore;
  readonly ledger: LedgerStore;
  readonly audit: AuditStore;
  readonly touchpoints: TouchpointStore;

  private constructor(session: SqlSession) {
    this.#session = session;

    const inTx = <T>(work: () => Promise<Result<T>>): Promise<Result<T>> => this.#atomic(work);

    this.exchanges = new SqlExchangeStore(session);
    this.grants = new SqlGrantStore(session);
    this.counters = new SqlCounterStore(session, inTx);
    this.funding = new SqlFundingStore(session);
    this.executions = new SqlExecutionStore(session);
    this.ledger = new SqlLedgerStore(session);
    this.audit = new SqlAuditStore(session);
    this.touchpoints = new SqlTouchpointStore(session);
  }

  /**
   * Connecting is asynchronous, so opening is too.
   *
   * A constructor cannot await, and a store that returns before its schema
   * exists is a store whose first write fails for a reason nobody will guess.
   */
  static async open(options: SqlStoreOptions): Promise<SqlPlatformStore> {
    const session = new SqlSession(options.client, options.dialect);
    for (const statement of options.dialect.setup) await options.client.script(statement);
    if (options.createSchema !== false) {
      for (const statement of schemaStatements(options.dialect)) {
        await options.client.script(statement);
      }
    }
    return new SqlPlatformStore(session);
  }

  /**
   * One critical section, joining an outer transaction if one is open.
   *
   * The mutex matters more here than it did when this adapter was synchronous.
   * An `await` inside a transaction is a point where another caller can run, so
   * without serialising, two check-and-consume sequences could interleave -
   * which is the exact bug the transaction exists to prevent.
   */
  async #atomic<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.#session.depth > 0) return work();
    return this.#lock.run(async () => {
      await this.#session.client.script(this.#session.dialect.beginWrite);
      this.#session.depth += 1;
      try {
        const outcome = await work();
        await this.#session.client.script(outcome.ok ? "COMMIT" : "ROLLBACK");
        return outcome;
      } catch (error) {
        await this.#session.client.script("ROLLBACK");
        throw error;
      } finally {
        this.#session.depth -= 1;
      }
    });
  }

  async transaction<T>(work: (tx: PlatformStore) => Promise<Result<T>>): Promise<Result<T>> {
    if (this.#session.depth > 0) return work(this);
    return this.#atomic(() => work(this));
  }

  async close(): Promise<void> {
    await this.#session.client.close?.();
  }
}
