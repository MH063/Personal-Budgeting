-- 借贷还款计划扩展 + 储蓄多账户归集（版本 3）
-- loans 表补齐 复利/还款方式/首期还款日/固定还款日 字段
ALTER TABLE loans ADD COLUMN compound INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN method TEXT NOT NULL DEFAULT 'balloon';
ALTER TABLE loans ADD COLUMN first_repay_date TEXT;
ALTER TABLE loans ADD COLUMN repay_day INTEGER;

-- 储蓄目标多账户归集关联表
CREATE TABLE IF NOT EXISTS savings_goal_accounts (
  goal_id     INTEGER NOT NULL,
  account_id  INTEGER NOT NULL,
  PRIMARY KEY (goal_id, account_id),
  FOREIGN KEY (goal_id)   REFERENCES savings_goals(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);