// 建表迁移 SQL（与 src-tauri/migrations/001_init.sql 保持一致）
export const INIT_SQL = `
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
    created_at      TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS loans (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    direction       TEXT NOT NULL CHECK(direction IN ('lend','borrow')),
    counterparty    TEXT NOT NULL,
    principal       REAL NOT NULL CHECK(principal > 0),
    remaining       REAL NOT NULL,
    account_id      INTEGER,
    date            TEXT NOT NULL,
    due_date        TEXT,
    rate            REAL NOT NULL DEFAULT 0,
    periods         INTEGER,
    compound        INTEGER NOT NULL DEFAULT 0,
    method          TEXT NOT NULL DEFAULT 'balloon'
                    CHECK(method IN ('balloon','equal_principal','equal_payment')),
    first_repay_date TEXT,
    repay_day       INTEGER,
    note            TEXT DEFAULT '',
    status          TEXT DEFAULT 'active'
                    CHECK(status IN ('active','settled','overdue')),
    accrued_interest REAL NOT NULL DEFAULT 0,  -- 已自动累计但尚未入账的逾期利息
    interest_accrued_until TEXT,               -- 逾期利息累计到的日期（用于增量累计）
    created_at      TEXT DEFAULT (datetime('now','localtime')),
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
    amortize_months INTEGER NOT NULL DEFAULT 0,
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
    interest    REAL NOT NULL DEFAULT 0, -- 其中利息部分（本金 = amount - interest）
    period      INTEGER,                 -- 对应还款计划的期次（分期还款用；到期结清为 NULL）
    account_id  INTEGER,
    date        TEXT NOT NULL,
    note        TEXT DEFAULT '',
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
    auto_monthly    REAL NOT NULL DEFAULT 0, -- 每月自动计提金额（0 表示不自动计提）
    auto_account_id INTEGER,                 -- 自动计提的来源账户
    auto_day        INTEGER DEFAULT 1,       -- 每月第几天自动计提（1-31）
    last_auto_month TEXT,                    -- 最近一次已计提的月份 'YYYY-MM'
    note            TEXT DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS savings_goal_accounts (
    goal_id     INTEGER NOT NULL,
    account_id  INTEGER NOT NULL,
    PRIMARY KEY (goal_id, account_id),
    FOREIGN KEY (goal_id)   REFERENCES savings_goals(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS budgets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id  INTEGER,
    amount       REAL NOT NULL,
    period       TEXT DEFAULT 'monthly',
    start_date   TEXT NOT NULL,
    end_date     TEXT,
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
    ('人情','expense','🎁','#F97316',8),
    ('通讯','expense','📱','#06B6D4',9),
    ('旅行','expense','✈️','#0EA5E9',10),
    ('美妆','expense','💄','#F43F5E',11),
    ('运动','expense','🏃','#22C55E',12),
    ('数码','expense','💼','#64748B',13),
    ('宠物','expense','🐱','#84CC16',14),
    ('宝宝','expense','👶','#F472B6',15),
    ('网购','expense','🛒','#D946EF',16),
    ('工资','income','💰','#10B981',1),
    ('奖金','income','🏆','#F59E0B',2),
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
`;

// 历史增量 SQL 定义（桌面端 schema 由 src-tauri/migrations 001~007 + db.ts ensureRawSchema 负责补齐，
// 以下常量仅供参考与追溯）
export const TAG_SQL = `
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
`;

// 已有数据库迁移：ledgers 表（多账本）
export const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS ledgers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    icon        TEXT DEFAULT '📒',
    color       TEXT DEFAULT '#3B82F6',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );
`;

// 增量迁移：借贷新增 复利/还款方式/首期还款日/固定还款日 字段
export const LOAN_SCHEDULE_SQL = `
  ALTER TABLE loans ADD COLUMN compound INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE loans ADD COLUMN method TEXT NOT NULL DEFAULT 'balloon';
  ALTER TABLE loans ADD COLUMN first_repay_date TEXT;
  ALTER TABLE loans ADD COLUMN repay_day INTEGER;
`;

// 建表/迁移 DDL 已统一移交 src-tauri/migrations/*.sql（Rust 侧 tauri-plugin-sql 按版本执行），
// 前端不再重复维护任何 CREATE TABLE / ALTER TABLE 语句，避免双源漂移（历史教训：
// 曾因前端兜底建表与迁移双份维护，出现「缺列/缺表」线上报错）。此处仅保留查询用常量。