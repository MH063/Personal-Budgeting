-- 初始化数据库结构（版本 1）
-- 与前端 src/api/schema.ts 保持一致

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK(type IN ('income','expense')),
  icon        TEXT DEFAULT '',
  color       TEXT DEFAULT '#6B7280',
  sort_order  INTEGER DEFAULT 0,
  is_active   INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK(type IN (
                    'cash','bank','ewallet','credit',
                    'investment','savings','receivable','payable')),
  balance         REAL DEFAULT 0,
  initial_balance REAL DEFAULT 0,
  icon            TEXT DEFAULT '',
  color           TEXT DEFAULT '#6B7280',
  is_active       INTEGER DEFAULT 1,
  sort_order      INTEGER DEFAULT 0,
  note            TEXT DEFAULT '',
  ledger_id       INTEGER DEFAULT 1,
  created_at      TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS ledgers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  icon        TEXT DEFAULT '📒',
  color       TEXT DEFAULT '#3B82F6',
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT DEFAULT '#6B7280',
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id  INTEGER NOT NULL,
  tag_id          INTEGER NOT NULL,
  PRIMARY KEY (transaction_id, tag_id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id)         REFERENCES tags(id)         ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS loans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  direction     TEXT NOT NULL CHECK(direction IN ('lend','borrow')),
  counterparty  TEXT NOT NULL,
  principal     REAL NOT NULL CHECK(principal > 0),
  remaining     REAL NOT NULL,
  account_id    INTEGER,
  date          TEXT NOT NULL,
  due_date      TEXT,
  note          TEXT DEFAULT '',
  status        TEXT DEFAULT 'active'
                CHECK(status IN ('active','settled','overdue')),
  ledger_id     INTEGER DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT NOT NULL CHECK(type IN (
                    'income','expense','transfer',
                    'lend','borrow','repay_in','repay_out')),
  amount         REAL NOT NULL CHECK(amount > 0),
  category_id    INTEGER,
  account_id     INTEGER NOT NULL,
  to_account_id  INTEGER,
  loan_id        INTEGER,
  date           TEXT NOT NULL,
  note           TEXT DEFAULT '',
  pay_time       TEXT,
  pay_method     TEXT,
  payee          TEXT,
  order_no       TEXT,
  merchant_order_no TEXT,
  ledger_id      INTEGER DEFAULT 1,
  created_at     TEXT DEFAULT (datetime('now','localtime')),
  updated_at     TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (category_id)   REFERENCES categories(id),
  FOREIGN KEY (account_id)    REFERENCES accounts(id),
  FOREIGN KEY (to_account_id) REFERENCES accounts(id),
  FOREIGN KEY (loan_id)       REFERENCES loans(id)
);

CREATE TABLE IF NOT EXISTS loan_repayments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id     INTEGER NOT NULL,
  amount      REAL NOT NULL CHECK(amount > 0),
  account_id  INTEGER,
  date        TEXT NOT NULL,
  note        TEXT DEFAULT '',
  ledger_id   INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS savings_goals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  target_amount   REAL NOT NULL CHECK(target_amount > 0),
  current_amount  REAL DEFAULT 0,
  account_id      INTEGER,
  target_date     TEXT,
  icon            TEXT DEFAULT '🎯',
  color           TEXT DEFAULT '#10B981',
  status          TEXT DEFAULT 'active'
                  CHECK(status IN ('active','completed','cancelled')),
  note            TEXT DEFAULT '',
  ledger_id       INTEGER DEFAULT 1,
  created_at      TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS budgets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id  INTEGER,
  amount       REAL NOT NULL,
  period       TEXT DEFAULT 'monthly',
  start_date   TEXT NOT NULL,
  end_date     TEXT,
  ledger_id    INTEGER DEFAULT 1,
  created_at   TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_date      ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_type      ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_tx_account   ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_category  ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_tx_dt        ON transactions(date, type);
CREATE INDEX IF NOT EXISTS idx_loan_status  ON loans(status);

INSERT INTO categories (name, type, icon, color, sort_order) VALUES
  ('餐饮','expense','🍜','#EF4444',1),
  ('交通','expense','🚌','#3B82F6',2),
  ('购物','expense','🛍️','#8B5CF6',3),
  ('居住','expense','🏠','#F59E0B',4),
  ('娱乐','expense','🎮','#EC4899',5),
  ('医疗','expense','💊','#14B8A6',6),
  ('教育','expense','📚','#6366F1',7),
  ('其他支出','expense','📦','#6B7280',8),
  ('工资','income','💰','#10B981',1),
  ('奖金','income','🎁','#F59E0B',2),
  ('兼职','income','💼','#3B82F6',3),
  ('投资收益','income','📈','#8B5CF6',4),
  ('红包','income','🧧','#EF4444',5),
  ('其他收入','income','💵','#6B7280',6);

INSERT INTO accounts (name, type, balance, initial_balance, icon, color, sort_order) VALUES
  ('现金','cash',0,0,'💵','#10B981',1),
  ('微信','ewallet',0,0,'💬','#10B981',2),
  ('支付宝','ewallet',0,0,'🅰️','#3B82F6',3),
  ('银行卡','bank',0,0,'🏦','#1E6FA9',4),
  ('信用卡','credit',0,0,'💳','#EF4444',5),
  ('储蓄','savings',0,0,'🐷','#F59E0B',6),
  ('应收款','receivable',0,0,'📥','#8B5CF6',7),
  ('应付款','payable',0,0,'📤','#EC4899',8);

INSERT INTO ledgers (name) SELECT '默认账本' WHERE NOT EXISTS (SELECT 1 FROM ledgers);
INSERT INTO settings (key, value) SELECT 'active_ledger_id', '1' WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'active_ledger_id');