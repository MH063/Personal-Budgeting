-- 还款本金/利息拆分：还款记录补 interest 列
-- 本金 = amount - interest；利息部分计入收入（放贷收息）或支出（借款付息），
-- 本金部分为债权/债务冲销，不进收入支出。
ALTER TABLE loan_repayments ADD COLUMN interest REAL NOT NULL DEFAULT 0;