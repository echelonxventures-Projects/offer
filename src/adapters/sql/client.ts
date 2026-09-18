/**
 * The database driver as a port.
 *
 * Node ships a SQLite driver and nothing else, so a Postgres adapter has to get
 * its driver from somewhere. Depending on `pg` would end the zero-dependency
 * promise for every deployment, including the ones using SQLite - and it would
 * also pick a driver on their behalf, which is exactly the kind of choice this
 * platform refuses to make.
 *
 * So the driver is a port. A deployment brings whatever it already runs - `pg`,
 * `postgres.js`, a serverless HTTP driver, a connection pool it configured
 * itself - and wraps it in these four methods. The adapter never knows which.
 *
 * The interface is deliberately tiny. Every method a store needs is here, and
 * nothing a driver might expose beyond it is reachable, because the moment an
 * adapter can reach a driver-specific feature it stops being portable.
 */

export interface SqlRow {
  readonly [column: string]: unknown;
}

export interface SqlClient {
  /** Rows, in order. Parameters are positional, written `?` by the caller. */
  query(sql: string, params?: readonly unknown[]): Promise<SqlRow[]>;

  /** Rows affected. Used where the count is the answer, as in a conditional update. */
  execute(sql: string, params?: readonly unknown[]): Promise<number>;

  /**
   * Run a script of several statements. Only used for schema creation.
   *
   * Separate from `execute` because most drivers will not accept multiple
   * statements in a parameterised call, and because the one place that needs it
   * is the one place with no user input in it.
   */
  script(sql: string): Promise<void>;

  close?(): Promise<void>;
}

/**
 * Rewrite `?` placeholders into a dialect's own form.
 *
 * Callers write `?` because that is what the schema and every query in this
 * adapter already used, and because one placeholder style in the source is
 * easier to read than a numbered one.
 *
 * **Limit, stated rather than discovered later:** this does not parse SQL. A
 * literal `?` inside a quoted string would be rewritten too. No query in this
 * adapter contains one, and a test asserts that stays true, because the day
 * somebody adds one the failure would be silent and bizarre.
 */
export function renumberPlaceholders(sql: string, form: (index: number) => string): string {
  if (form(1) === "?") return sql;
  let index = 0;
  let out = "";
  for (const character of sql) {
    if (character === "?") {
      index += 1;
      out += form(index);
    } else {
      out += character;
    }
  }
  return out;
}
