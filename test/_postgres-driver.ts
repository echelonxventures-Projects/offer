/**
 * A minimal PostgreSQL driver, for the test suite only.
 *
 * The platform ships a driver *port*, not a driver: a deployment brings `pg`,
 * `postgres.js` or whatever it already runs. That keeps the zero-dependency
 * promise and avoids choosing a driver on a deployment's behalf.
 *
 * But a Postgres adapter nobody has ever run against Postgres is not an
 * adapter, it is a hopeful guess. So this speaks enough of the version 3 wire
 * protocol to put the conformance suite in front of a real server.
 *
 * **It is not a production driver and must never be used as one.** No TLS, no
 * SCRAM or MD5 authentication, no connection pooling, no prepared-statement
 * cache, no COPY, no notifications, no cancellation, and every value is read as
 * text. It handles trust authentication on a loopback socket, which is exactly
 * what the tests need and nothing more.
 */
import { createConnection, type Socket } from "node:net";
import type { SqlClient, SqlRow } from "../src/adapters/sql/client.ts";

const PROTOCOL_VERSION = 196_608; // 3.0

interface Message {
  readonly type: string;
  readonly body: Buffer;
}

export interface PostgresOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
}

/** Parse `postgres://user@host:port/database`. Enough for a test URL. */
export function parsePostgresUrl(url: string): PostgresOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username || "postgres"),
    database: parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname,
  };
}

export class TestPostgresClient implements SqlClient {
  readonly #socket: Socket;
  #buffer: Buffer = Buffer.alloc(0);
  /**
   * Decoded messages not yet read.
   *
   * The server sends several messages back to back at startup, and more than
   * one per query. Handing each straight to a waiting reader drops any that
   * arrive before a reader exists, which presents as a hang rather than an
   * error - so messages queue here and readers take from the queue.
   */
  #inbox: Message[] = [];
  #waiting: ((message: Message) => void)[] = [];
  #failure: Error | undefined;
  #closed = false;
  /**
   * One query at a time.
   *
   * A Postgres connection processes a single query at a time; two overlapping
   * exchanges on one socket read each other's replies and rows arrive attached
   * to the wrong caller. Real drivers hide this behind a pool or a queue. This
   * one queues, which is the honest minimum - and it is why the concurrency
   * tests still measure the *store's* atomicity rather than this driver's.
   */
  #gate: Promise<unknown> = Promise.resolve();
  /**
   * Queries in flight.
   *
   * An open socket keeps Node's event loop alive, so a test that opens a store
   * and never closes it would hang the whole run at exit - after every
   * assertion has already passed, which is a maddening way to fail. The socket
   * is referenced only while a query is actually outstanding.
   */
  #inFlight = 0;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk) => this.#ingest(chunk));
    socket.on("error", (error) => {
      this.#failure = error;
    });
    socket.on("close", () => {
      this.#closed = true;
    });
  }

  static async connect(options: PostgresOptions): Promise<TestPostgresClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const attempt = createConnection({ host: options.host, port: options.port }, () => resolve(attempt));
      attempt.once("error", reject);
    });
    socket.setNoDelay(true);
    // Idle until the first query.
    socket.unref();

    const client = new TestPostgresClient(socket);
    await client.startup(options);
    return client;
  }

  /* -- framing -- */

  #ingest(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#buffer.length < 5) return;
      const length = this.#buffer.readInt32BE(1);
      if (this.#buffer.length < length + 1) return;
      const type = String.fromCharCode(this.#buffer[0] as number);
      const body = this.#buffer.subarray(5, length + 1);
      this.#buffer = this.#buffer.subarray(length + 1);
      const message: Message = { type, body };
      const reader = this.#waiting.shift();
      if (reader) reader(message);
      else this.#inbox.push(message);
    }
  }

  async #next(): Promise<Message> {
    const queued = this.#inbox.shift();
    if (queued) return queued;
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new Error("postgres connection closed");
    return new Promise<Message>((resolve) => this.#waiting.push(resolve));
  }

  #send(type: string | undefined, payload: Buffer): void {
    const header = Buffer.alloc(type === undefined ? 4 : 5);
    let offset = 0;
    if (type !== undefined) {
      header.write(type, 0, "ascii");
      offset = 1;
    }
    header.writeInt32BE(payload.length + 4, offset);
    this.#socket.write(Buffer.concat([header, payload]));
  }

  async startup(options: PostgresOptions): Promise<void> {
    const parameters = Buffer.concat([
      cstring("user"), cstring(options.user),
      cstring("database"), cstring(options.database),
      Buffer.from([0]),
    ]);
    const version = Buffer.alloc(4);
    version.writeInt32BE(PROTOCOL_VERSION);
    this.#send(undefined, Buffer.concat([version, parameters]));

    for (;;) {
      const message = await this.#next();
      if (message.type === "E") throw errorFrom(message.body);
      if (message.type === "R") {
        const method = message.body.readInt32BE(0);
        if (method !== 0) {
          throw new Error(
            `this test driver only supports trust authentication; the server asked for method ${method}`,
          );
        }
        continue;
      }
      if (message.type === "Z") return; // ReadyForQuery
    }
  }

  /* -- queries -- */

  /** Serialise an exchange behind any already in flight. */
  #queued<T>(work: () => Promise<T>): Promise<T> {
    const guarded = async (): Promise<T> => {
      this.#inFlight += 1;
      this.#socket.ref();
      try {
        return await work();
      } finally {
        this.#inFlight -= 1;
        if (this.#inFlight === 0) this.#socket.unref();
      }
    };
    const next = this.#gate.then(guarded, guarded);
    // Keep the chain alive after a rejection, or one failed query wedges the
    // connection for every caller after it.
    this.#gate = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<SqlRow[]> {
    return this.#queued(async () => (await this.#run(sql, params)).rows);
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    return this.#queued(async () => (await this.#run(sql, params)).affected);
  }

  async script(sql: string): Promise<void> {
    return this.#queued(() => this.#script(sql));
  }

  async #script(sql: string): Promise<void> {
    this.#send("Q", cstring(sql));
    let failure: Error | undefined;
    for (;;) {
      const message = await this.#next();
      if (message.type === "E") failure = errorFrom(message.body);
      if (message.type === "Z") break;
    }
    if (failure) throw failure;
  }

  async #run(sql: string, params: readonly unknown[]): Promise<{ rows: SqlRow[]; affected: number }> {
    // Parse (unnamed) / Bind / Describe / Execute / Sync.
    this.#send("P", Buffer.concat([cstring(""), cstring(sql), int16(0)]));

    const encoded = params.map((value) => encodeParam(value));
    this.#send(
      "B",
      Buffer.concat([
        cstring(""), cstring(""),
        int16(0), // all parameters in text format
        int16(encoded.length),
        ...encoded,
        int16(0), // all results in text format
      ]),
    );
    this.#send("D", Buffer.concat([Buffer.from("P", "ascii"), cstring("")]));
    this.#send("E", Buffer.concat([cstring(""), int32(0)]));
    this.#send("S", Buffer.alloc(0));

    let columns: string[] = [];
    const rows: SqlRow[] = [];
    let affected = 0;
    let failure: Error | undefined;

    for (;;) {
      const message = await this.#next();
      if (message.type === "T") columns = readRowDescription(message.body);
      else if (message.type === "D") rows.push(readDataRow(message.body, columns));
      else if (message.type === "C") affected = commandTagCount(message.body);
      else if (message.type === "E") failure = errorFrom(message.body);
      else if (message.type === "Z") {
        if (failure) throw failure;
        return { rows, affected };
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#send("X", Buffer.alloc(0));
    this.#socket.end();
    this.#closed = true;
  }
}

/* -- encoding helpers -- */

function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
}

function int16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function encodeParam(value: unknown): Buffer {
  if (value === null || value === undefined) return int32(-1);
  // Everything goes as text. Postgres casts from the column type, and a bigint
  // reaches NUMERIC exactly this way - which is the entire reason money columns
  // are NUMERIC rather than anything a float could reach.
  const text = typeof value === "bigint" ? value.toString() : String(value);
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([int32(bytes.length), bytes]);
}

function readRowDescription(body: Buffer): string[] {
  const count = body.readInt16BE(0);
  const names: string[] = [];
  let offset = 2;
  for (let i = 0; i < count; i += 1) {
    const end = body.indexOf(0, offset);
    names.push(body.subarray(offset, end).toString("utf8"));
    offset = end + 1 + 18; // table oid, column, type oid, size, modifier, format
  }
  return names;
}

function readDataRow(body: Buffer, columns: string[]): SqlRow {
  const count = body.readInt16BE(0);
  const row: Record<string, unknown> = {};
  let offset = 2;
  for (let i = 0; i < count; i += 1) {
    const length = body.readInt32BE(offset);
    offset += 4;
    if (length === -1) {
      row[columns[i] ?? String(i)] = null;
      continue;
    }
    row[columns[i] ?? String(i)] = body.subarray(offset, offset + length).toString("utf8");
    offset += length;
  }
  return row;
}

function commandTagCount(body: Buffer): number {
  const tag = body.subarray(0, body.indexOf(0)).toString("utf8");
  const parts = tag.split(" ");
  const parsed = Number(parts[parts.length - 1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorFrom(body: Buffer): Error {
  const fields: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    if (body[offset] === 0) break;
    const code = String.fromCharCode(body[offset] as number);
    const end = body.indexOf(0, offset + 1);
    fields[code] = body.subarray(offset + 1, end).toString("utf8");
    offset = end + 1;
  }
  const error = new Error(`${fields.S ?? "ERROR"}: ${fields.M ?? "unknown"}`);
  (error as { code?: string }).code = fields.C;
  return error;
}
