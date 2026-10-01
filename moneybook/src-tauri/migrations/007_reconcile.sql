-- 银行对账：批次表 + 匹配明细表 + transactions 补对账归属批次列
-- 与 src/api/schema.ts 的 RECON_SQL / RECON_TRANSACTION_COL 保持一致

CREATE TABLE IF NOT EXISTS reconciliations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL,
  period_start    TEXT,
  period_end      TEXT,
  opening_balance REAL DEFAULT 0,
  bank_balance    REAL,
  calc_balance    REAL,
  diff_total      REAL DEFAULT 0,
  status          TEXT DEFAULT 'draft',
  created_at      TEXT DEFAULT (datetime('now','localtime')),
  ledger_id       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS reconciliation_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_id INTEGER NOT NULL,
  bank_row          TEXT,
  transaction_id    INTEGER,
  match_kind        TEXT NOT NULL,
  matched_at        TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (reconciliation_id) REFERENCES reconciliations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recon_items ON reconciliation_items(reconciliation_id);

ALTER TABLE transactions ADD COLUMN reconciliation_id INTEGER;