-- 周期性记账：房租/订阅等固定收入支出的自动生成
CREATE TABLE IF NOT EXISTS recurring_transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL CHECK(type IN ('income','expense','transfer')),
  amount      REAL NOT NULL CHECK(amount > 0),
  category_id INTEGER,
  account_id  INTEGER NOT NULL,
  to_account_id INTEGER,
  note        TEXT DEFAULT '',
  frequency   TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly','yearly')),
  interval    INTEGER DEFAULT 1,
  start_date  TEXT NOT NULL,
  end_date    TEXT,
  next_run    TEXT,
  last_run    TEXT,
  is_active   INTEGER DEFAULT 1,
  ledger_id   INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (category_id)   REFERENCES categories(id),
  FOREIGN KEY (account_id)    REFERENCES accounts(id),
  FOREIGN KEY (to_account_id) REFERENCES accounts(id)
);