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

// 增量迁移：储蓄目标多账户归集关联表
export const SAVINGS_ACCOUNTS_SQL = `
  CREATE TABLE IF NOT EXISTS savings_goal_accounts (
    goal_id     INTEGER NOT NULL,
    account_id  INTEGER NOT NULL,
    PRIMARY KEY (goal_id, account_id),
    FOREIGN KEY (goal_id)   REFERENCES savings_goals(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );
`;

// 增量迁移：还款记录补 interest 列（本金/利息拆分，利息计入收入或支出）
export const REPAYMENT_INTEREST_SQL = `
  ALTER TABLE loan_repayments ADD COLUMN interest REAL NOT NULL DEFAULT 0;
`;

// 增量迁移：还款记录补 period 期次列（分期还款跟踪）
export const REPAYMENT_PERIOD_SQL = `
  ALTER TABLE loan_repayments ADD COLUMN period INTEGER;
`;

// 周期性记账表定义
export const RECURRING_SQL = `
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
    next_run    TEXT,          -- 下次触发日（YYYY-MM-DD）
    last_run    TEXT,          -- 最近一次生成日期
    is_active   INTEGER DEFAULT 1,
    ledger_id   INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (category_id)   REFERENCES categories(id),
    FOREIGN KEY (account_id)    REFERENCES accounts(id),
    FOREIGN KEY (to_account_id) REFERENCES accounts(id)
  );
`;

// 增量迁移：储蓄目标补自动计提字段（每月自动存入）
export const AUTO_SAVINGS_SQL = `
  ALTER TABLE savings_goals ADD COLUMN auto_monthly REAL NOT NULL DEFAULT 0;
  ALTER TABLE savings_goals ADD COLUMN auto_account_id INTEGER;
  ALTER TABLE savings_goals ADD COLUMN auto_day INTEGER DEFAULT 1;
  ALTER TABLE savings_goals ADD COLUMN last_auto_month TEXT;
`;

// 增量迁移：借贷补逾期利息累计字段（存量库增量）
export const LOAN_ACCRUED_SQL = `
  ALTER TABLE loans ADD COLUMN accrued_interest REAL NOT NULL DEFAULT 0;
  ALTER TABLE loans ADD COLUMN interest_accrued_until TEXT;
`;

// 投资持仓表（依附于 investment 类型账户；市值 = quantity * price）
export const HOLDINGS_SQL = `
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
`;

// 银行对账：批次表 + 匹配明细表（银行流水行快照 + 本地交易匹配关系）
export const RECON_SQL = `
  CREATE TABLE IF NOT EXISTS reconciliations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER NOT NULL,
    period_start    TEXT,
    period_end      TEXT,
    opening_balance REAL DEFAULT 0,     -- 期初余额（用户录入）
    bank_balance    REAL,               -- 银行期末余额（手工录入）
    calc_balance    REAL,               -- 按匹配结果推算的期末余额
    diff_total      REAL DEFAULT 0,     -- 差异合计（ |calc - bank| ）
    status          TEXT DEFAULT 'draft', -- draft|locked
    created_at      TEXT DEFAULT (datetime('now','localtime')),
    ledger_id       INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS reconciliation_items (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    reconciliation_id INTEGER NOT NULL,
    bank_row          TEXT,             -- 银行行快照 JSON：{date,摘要,income,expense,balance,line}
    transaction_id    INTEGER,          -- 匹配到的本地交易（可空=未配对）
    match_kind        TEXT NOT NULL,    -- auto|manual|split|unmatched_bank|unmatched_local|amount_mismatch
    matched_at        TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (reconciliation_id) REFERENCES reconciliations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_recon_items ON reconciliation_items(reconciliation_id);
`;

// 银行对账增量迁移：transactions 表补对账归属批次列
export const RECON_TRANSACTION_COL = `
  ALTER TABLE transactions ADD COLUMN reconciliation_id INTEGER;
`;

// 常用交易模板表：一键复用（智能补全·模板复用）。
// amount 可空 = 每次手填；tag_ids 存 JSON 数组字符串。
// 仅存本机，无网络。
export const TXN_TEMPLATE_SQL = `
  CREATE TABLE IF NOT EXISTS txn_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK(type IN ('income','expense','transfer','lend','borrow')),
    amount      REAL,                          -- 可空：null 表示每次记账手填金额
    category_id INTEGER,
    account_id  INTEGER,
    to_account_id INTEGER,
    note        TEXT DEFAULT '',
    payee       TEXT DEFAULT '',               -- 收款方/商户
    pay_method  TEXT DEFAULT '',               -- 付款方式
    tag_ids     TEXT DEFAULT '[]',             -- 标签 id 数组 JSON
    ledger_id   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (category_id)   REFERENCES categories(id),
    FOREIGN KEY (account_id)    REFERENCES accounts(id),
    FOREIGN KEY (to_account_id) REFERENCES accounts(id)
  );

  CREATE INDEX IF NOT EXISTS idx_txn_templates_ledger ON txn_templates(ledger_id);
`;

// 回收站表：删除前把主行与关联子记录以快照 JSON 形式存入，支持恢复与彻底删除
export const TRASH_SQL = `
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
`;