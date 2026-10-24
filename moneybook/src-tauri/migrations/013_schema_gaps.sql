-- 补齐历史迁移缺口：以下三张表此前由前端 db.ts 的 ensureRawSchema 兜底创建，
-- 在「建表职责移交 Rust 迁移」时被遗漏，导致存量库缺失：
--   account_holdings（投资持仓，净资产/体检链路依赖）、txn_templates（交易模板）、trash（回收站）。
-- 使用 CREATE TABLE IF NOT EXISTS 保证幂等；DDL 与 src/api/schema.ts 中同名常量保持一致。
CREATE TABLE IF NOT EXISTS account_holdings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL,
  symbol      TEXT DEFAULT '',       -- 代码/简称
  name        TEXT NOT NULL,         -- 持仓名称
  quantity    REAL NOT NULL DEFAULT 0,  -- 数量
  cost        REAL NOT NULL DEFAULT 0,  -- 单位成本
  price       REAL NOT NULL DEFAULT 0,  -- 当前价格
  note        TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  updated_at  TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_holdings_account ON account_holdings(account_id);

CREATE TABLE IF NOT EXISTS txn_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK(type IN ('income','expense','transfer','lend','borrow')),
  amount        REAL,                          -- 可空：null 表示每次记账手填金额
  category_id   INTEGER,
  account_id    INTEGER,
  to_account_id INTEGER,
  note          TEXT DEFAULT '',
  payee         TEXT DEFAULT '',               -- 收款方/商户
  pay_method    TEXT DEFAULT '',               -- 付款方式
  tag_ids       TEXT DEFAULT '[]',             -- 标签 id 数组 JSON
  ledger_id     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (category_id)   REFERENCES categories(id),
  FOREIGN KEY (account_id)    REFERENCES accounts(id),
  FOREIGN KEY (to_account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_txn_templates_ledger ON txn_templates(ledger_id);

CREATE TABLE IF NOT EXISTS trash (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,              -- transaction|account|category|tag|budget|savings_goal|loan|recurring
  entity_id   INTEGER NOT NULL,           -- 原业务表主键 id
  ref_object  TEXT NOT NULL,              -- 主行快照 JSON
  assoc       TEXT,                       -- 关联子记录快照 JSON（transaction_tags/loan_repayments/…）
  deleted_at  TEXT NOT NULL,
  ledger_id   INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_trash_entity ON trash(entity, ledger_id);
