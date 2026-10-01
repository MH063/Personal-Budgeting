-- 借贷期次还款 + 储蓄自动计提：新增列
-- 1) 还款记录按期次跟踪（等额本金/等额本息分期逐期归还，逾期按应还期次逐期判定）
ALTER TABLE loan_repayments ADD COLUMN period INTEGER;

-- 2) 储蓄目标每月自动计提
ALTER TABLE savings_goals ADD COLUMN auto_monthly REAL NOT NULL DEFAULT 0;
ALTER TABLE savings_goals ADD COLUMN auto_account_id INTEGER;
ALTER TABLE savings_goals ADD COLUMN auto_day INTEGER DEFAULT 1;
ALTER TABLE savings_goals ADD COLUMN last_auto_month TEXT;