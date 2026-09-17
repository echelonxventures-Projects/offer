/**
 * Schema for the SQLite adapter.
 *
 * Kept as plain SQL in one place so it can be read as a specification: a
 * Postgres or MySQL adapter is this file with different types and the same
 * indexes, and the comments say which parts are load-bearing.
 *
 * Amount storage. Records are stored as JSON documents using the wire codec, so
 * `bigint` survives exactly. The *arithmetic* columns - reserved, spent, budget,
 * granted - are INTEGER, because the conditional updates that make reservation
 * atomic have to compare them in SQL. SQLite INTEGER is 64-bit signed, which
 * bounds a single funding source at ~9.2e18 minor units: 92 trillion at scale 2,
 * 9.2 billion at scale 6. That is a real limit and it is chosen deliberately:
 * atomicity is worth more than headroom nobody will use. A Postgres adapter
 * should use NUMERIC(38,0) and get both.
 */

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS value_exchange (
  tenant       TEXT NOT NULL,
  id           TEXT NOT NULL,
  state        TEXT NOT NULL,
  profile      TEXT NOT NULL,
  visibility   TEXT NOT NULL,
  code_upper   TEXT,
  realities    TEXT,            -- JSON array, or NULL meaning "all realities"
  document     TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
);
-- The hottest read on the decision path.
CREATE INDEX IF NOT EXISTS ix_vx_state ON value_exchange (tenant, state);
CREATE INDEX IF NOT EXISTS ix_vx_code  ON value_exchange (tenant, code_upper);

CREATE TABLE IF NOT EXISTS grant_row (
  tenant             TEXT NOT NULL,
  id                 TEXT NOT NULL,
  value_exchange_id  TEXT NOT NULL,
  subject_id         TEXT,
  code_upper         TEXT,
  document           TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS ix_grant_subject ON grant_row (tenant, subject_id);
CREATE INDEX IF NOT EXISTS ix_grant_code    ON grant_row (tenant, code_upper);

CREATE TABLE IF NOT EXISTS counter (
  tenant             TEXT NOT NULL,
  value_exchange_id  TEXT NOT NULL,
  issued             INTEGER NOT NULL DEFAULT 0,
  redemptions        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, value_exchange_id)
);

CREATE TABLE IF NOT EXISTS counter_subject (
  tenant             TEXT NOT NULL,
  value_exchange_id  TEXT NOT NULL,
  subject_id         TEXT NOT NULL,
  redemptions        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, value_exchange_id, subject_id)
);

-- One row per redemption, pruned on write. Without pruning this is the table
-- that grows without bound; see limit-rules.pruneRecent.
CREATE TABLE IF NOT EXISTS counter_recent (
  tenant             TEXT NOT NULL,
  value_exchange_id  TEXT NOT NULL,
  subject_id         TEXT NOT NULL,
  at_seconds         REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_recent ON counter_recent (tenant, value_exchange_id, subject_id, at_seconds);

CREATE TABLE IF NOT EXISTS counter_granted (
  tenant             TEXT NOT NULL,
  value_exchange_id  TEXT NOT NULL,
  unit               TEXT NOT NULL,
  minor              INTEGER NOT NULL DEFAULT 0,
  scale              INTEGER NOT NULL,
  PRIMARY KEY (tenant, value_exchange_id, unit)
);

CREATE TABLE IF NOT EXISTS funding_source (
  tenant          TEXT NOT NULL,
  id              TEXT NOT NULL,
  unit            TEXT NOT NULL,
  scale           INTEGER NOT NULL,
  budget_minor    INTEGER,          -- NULL means uncapped
  reserved_minor  INTEGER NOT NULL DEFAULT 0,
  spent_minor     INTEGER NOT NULL DEFAULT 0,
  document        TEXT NOT NULL,    -- label, party, alert threshold
  PRIMARY KEY (tenant, id)
);

CREATE TABLE IF NOT EXISTS execution (
  tenant           TEXT NOT NULL,
  id               TEXT NOT NULL,
  state            TEXT NOT NULL,
  idempotency_key  TEXT,
  subject_id       TEXT,
  created_at       TEXT NOT NULL,
  document         TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
);
-- This unique index is what makes a retried checkout safe. Without it two
-- concurrent identical requests both create an execution.
CREATE UNIQUE INDEX IF NOT EXISTS ux_exec_idem
  ON execution (tenant, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_exec_state   ON execution (tenant, state, created_at);
CREATE INDEX IF NOT EXISTS ix_exec_subject ON execution (tenant, subject_id);

CREATE TABLE IF NOT EXISTS ledger_entry (
  tenant          TEXT NOT NULL,
  id              TEXT NOT NULL,
  transaction_id  TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  reference_id    TEXT NOT NULL,
  seq             INTEGER NOT NULL,   -- preserves append order for reversal
  document        TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS ix_ledger_account ON ledger_entry (tenant, account_id);
CREATE INDEX IF NOT EXISTS ix_ledger_ref     ON ledger_entry (tenant, reference_id);
CREATE INDEX IF NOT EXISTS ix_ledger_seq     ON ledger_entry (tenant, seq);

CREATE TABLE IF NOT EXISTS audit_record (
  tenant    TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  hash      TEXT NOT NULL,
  document  TEXT NOT NULL,
  PRIMARY KEY (tenant, seq)
);

CREATE TABLE IF NOT EXISTS touchpoint (
  tenant             TEXT NOT NULL,
  id                 TEXT NOT NULL,
  subject_id         TEXT,
  device_id          TEXT,
  value_exchange_id  TEXT,
  at                 TEXT NOT NULL,
  document           TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS ix_touch_subject ON touchpoint (tenant, subject_id, at);
CREATE INDEX IF NOT EXISTS ix_touch_device  ON touchpoint (tenant, device_id, at);
`;
