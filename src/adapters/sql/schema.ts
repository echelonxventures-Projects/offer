/**
 * The schema, once, for every SQL dialect.
 *
 * Read this as a specification. The types are substituted per dialect; the
 * indexes are not, because they are not decoration - they are the difference
 * between a decision path that scales and one that does not.
 *
 * There is deliberately no second copy of this file. Two copies drift: one
 * gains an index the other does not, and two adapters that were supposed to be
 * the same store quietly stop being it. Substituting four type names is a
 * smaller price than that.
 *
 * **Money columns.** Records are stored as JSON documents using the wire codec,
 * so `bigint` survives exactly. The *arithmetic* columns - budget, reserved,
 * spent, granted - are `{{money}}`, because the conditional updates that make
 * reservation atomic have to compare them in SQL. SQLite maps that to its only
 * integer type, 64-bit signed, which bounds a single funding source at ~9.2e18
 * minor units: 92 trillion at scale 2, 9.2 billion at scale 6. That is a real
 * limit, accepted deliberately because atomicity is worth more than headroom
 * nobody will use. Postgres maps it to NUMERIC(38,0) and gives up neither.
 */
import type { SqlDialect } from "./dialect.ts";

const TEMPLATE = `

CREATE TABLE IF NOT EXISTS value_exchange (
  tenant       {{text}} NOT NULL,
  id           {{text}} NOT NULL,
  state        {{text}} NOT NULL,
  profile      {{text}} NOT NULL,
  visibility   {{text}} NOT NULL,
  code_upper   {{text}},
  realities    {{text}},            -- JSON array, or NULL meaning "all realities"
  document     {{text}} NOT NULL,
  PRIMARY KEY (tenant, id)
);
-- The hottest read on the decision path.
CREATE INDEX IF NOT EXISTS ix_vx_state ON value_exchange (tenant, state);
CREATE INDEX IF NOT EXISTS ix_vx_code  ON value_exchange (tenant, code_upper);

CREATE TABLE IF NOT EXISTS grant_row (
  tenant             {{text}} NOT NULL,
  id                 {{text}} NOT NULL,
  value_exchange_id  {{text}} NOT NULL,
  subject_id         {{text}},
  code_upper         {{text}},
  document           {{text}} NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS ix_grant_subject ON grant_row (tenant, subject_id);
CREATE INDEX IF NOT EXISTS ix_grant_code    ON grant_row (tenant, code_upper);

CREATE TABLE IF NOT EXISTS counter (
  tenant             {{text}} NOT NULL,
  value_exchange_id  {{text}} NOT NULL,
  issued             {{integer}} NOT NULL DEFAULT 0,
  redemptions        {{integer}} NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, value_exchange_id)
);

CREATE TABLE IF NOT EXISTS counter_subject (
  tenant             {{text}} NOT NULL,
  value_exchange_id  {{text}} NOT NULL,
  subject_id         {{text}} NOT NULL,
  redemptions        {{integer}} NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, value_exchange_id, subject_id)
);

-- One row per redemption, pruned on write. Without pruning this is the table
-- that grows without bound; see limit-rules.pruneRecent.
CREATE TABLE IF NOT EXISTS counter_recent (
  tenant             {{text}} NOT NULL,
  value_exchange_id  {{text}} NOT NULL,
  subject_id         {{text}} NOT NULL,
  at_seconds         {{real}} NOT NULL,
  -- Insertion order, assigned inside the write transaction the same way the
  -- ledger assigns its own. It exists because pruning and undoing both need to
  -- name one specific row, and SQLite's rowid has no portable equivalent.
  seq                {{integer}} NOT NULL,
  PRIMARY KEY (tenant, value_exchange_id, subject_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_recent ON counter_recent (tenant, value_exchange_id, subject_id, at_seconds);

CREATE TABLE IF NOT EXISTS counter_granted (
  tenant             {{text}} NOT NULL,
  value_exchange_id  {{text}} NOT NULL,
  unit               {{text}} NOT NULL,
  minor              {{money}} NOT NULL DEFAULT 0,
  scale              {{integer}} NOT NULL,
  PRIMARY KEY (tenant, value_exchange_id, unit)
);

CREATE TABLE IF NOT EXISTS funding_source (
  tenant          {{text}} NOT NULL,
  id              {{text}} NOT NULL,
  unit            {{text}} NOT NULL,
  scale           {{integer}} NOT NULL,
  budget_minor    {{money}},          -- NULL means uncapped
  reserved_minor  {{money}} NOT NULL DEFAULT 0,
  spent_minor     {{money}} NOT NULL DEFAULT 0,
  document        {{text}} NOT NULL,    -- label, party, alert threshold
  PRIMARY KEY (tenant, id)
);

CREATE TABLE IF NOT EXISTS execution (
  tenant           {{text}} NOT NULL,
  id               {{text}} NOT NULL,
  state            {{text}} NOT NULL,
  idempotency_key  {{text}},
  subject_id       {{text}},
  created_at       {{text}} NOT NULL,
  document         {{text}} NOT NULL,
  PRIMARY KEY (tenant, id)
);
-- This unique index is what makes a retried checkout safe. Without it two
-- concurrent identical requests both create an execution.
CREATE UNIQUE INDEX IF NOT EXISTS ux_exec_idem
  ON execution (tenant, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_exec_state   ON execution (tenant, state, created_at);
CREATE INDEX IF NOT EXISTS ix_exec_subject ON execution (tenant, subject_id);

CREATE TABLE IF NOT EXISTS ledger_entry (
  tenant          {{text}} NOT NULL,
  id              {{text}} NOT NULL,
  transaction_id  {{text}} NOT NULL,
  account_id      {{text}} NOT NULL,
  reference_id    {{text}} NOT NULL,
  seq             {{integer}} NOT NULL,   -- preserves append order for reversal
  document        {{text}} NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS ix_ledger_account ON ledger_entry (tenant, account_id);
CREATE INDEX IF NOT EXISTS ix_ledger_ref     ON ledger_entry (tenant, reference_id);
CREATE INDEX IF NOT EXISTS ix_ledger_seq     ON ledger_entry (tenant, seq);

-- Netted balances as of a sequence number, so reconciliation folds only what
-- is new. Without this, answering "what is each account worth" rescans the
-- fastest-growing table in the system, forever.
CREATE TABLE IF NOT EXISTS ledger_snapshot (
  tenant       {{text}} NOT NULL PRIMARY KEY,
  through_seq  {{integer}} NOT NULL,
  at           {{text}} NOT NULL,
  positions    {{text}} NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_record (
  tenant    {{text}} NOT NULL,
  seq       {{integer}} NOT NULL,
  hash      {{text}} NOT NULL,
  document  {{text}} NOT NULL,
  PRIMARY KEY (tenant, seq)
);

-- A verified point in the chain, so verification can resume rather than
-- re-walking from genesis. One row per tenant; it moves forward only.
CREATE TABLE IF NOT EXISTS audit_checkpoint (
  tenant  {{text}} NOT NULL PRIMARY KEY,
  seq     {{integer}} NOT NULL,
  hash    {{text}} NOT NULL,
  at      {{text}} NOT NULL
);

CREATE TABLE IF NOT EXISTS touchpoint (
  tenant             {{text}} NOT NULL,
  id                 {{text}} NOT NULL,
  subject_id         {{text}},
  device_id          {{text}},
  value_exchange_id  {{text}},
  at                 {{text}} NOT NULL,
  document           {{text}} NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS ix_touch_subject ON touchpoint (tenant, subject_id, at);
CREATE INDEX IF NOT EXISTS ix_touch_device  ON touchpoint (tenant, device_id, at);
`;

export function schemaFor(dialect: SqlDialect): string {
  return TEMPLATE.replaceAll("{{text}}", dialect.types.text)
    .replaceAll("{{integer}}", dialect.types.integer)
    .replaceAll("{{money}}", dialect.types.money)
    .replaceAll("{{real}}", dialect.types.real);
}

/**
 * Statements, split so a driver that refuses multi-statement scripts still works.
 *
 * Line comments are stripped before splitting. They are documentation for
 * whoever reads this file, and one of them contains a semicolon - which a naive
 * split turns into half a comment followed by a statement fragment, and a
 * syntax error pointing at a word from an English sentence.
 */
export function schemaStatements(dialect: SqlDialect): string[] {
  return schemaFor(dialect)
    .split("\n")
    .map((line) => {
      const comment = line.indexOf("--");
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
