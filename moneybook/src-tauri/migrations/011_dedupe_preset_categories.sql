-- 011: 预置分类/账户去重兜底（修复「分类成对重复」）
--
-- 背景：001 迁移的预置分类/账户 INSERT 无幂等保护（无 WHERE NOT EXISTS）。
--       当库的 _sqlx_migrations 迁移记录丢失（数据库重建 / 备份恢复 / 异常中断等）时，
--       sqlx 会在每次应用启动重跑全部迁移 → 001 每次都多插 14 个预置分类，
--       分类成批累积重复（用户实测：餐饮×2、工资×2、交通×2……共 28 个）。
--
-- 策略：对「预置特征（name + type + icon + color 全匹配）」的重复行，保留最小 id，
--       先把所有引用重定向到保留行，再删除重复行。
-- 幂等：无重复则所有语句均为无操作；001 被重跑多少次都能兜底清理。
-- 安全：判重基于 icon/color/type/name 四字段全匹配，用户自定义的同名分类因
--       图标/颜色不同不会被误删；引用联动重定向避免悬空外键。
-- 说明：迁移文件一旦发布不可修改（sqlx 校验 checksum），001 的幂等保护不可直接改，
--       后续若需调整请新增 012+。

-- ================= 一、分类去重 =================
-- ① 重定向分类引用（transactions / budgets / recurring_transactions / txn_templates）
--    仅当该行指向的分类处于「重复组」时，改指向组内最小 id。
UPDATE transactions
SET category_id = (
  SELECT MIN(c2.id) FROM categories c2
  WHERE c2.name = (SELECT c1.name FROM categories c1 WHERE c1.id = transactions.category_id)
    AND c2.type = (SELECT c1.type FROM categories c1 WHERE c1.id = transactions.category_id)
    AND c2.icon = (SELECT c1.icon FROM categories c1 WHERE c1.id = transactions.category_id)
    AND c2.color = (SELECT c1.color FROM categories c1 WHERE c1.id = transactions.category_id)
)
WHERE category_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM categories c3
    WHERE c3.name = (SELECT c1.name FROM categories c1 WHERE c1.id = transactions.category_id)
      AND c3.type = (SELECT c1.type FROM categories c1 WHERE c1.id = transactions.category_id)
      AND c3.icon = (SELECT c1.icon FROM categories c1 WHERE c1.id = transactions.category_id)
      AND c3.color = (SELECT c1.color FROM categories c1 WHERE c1.id = transactions.category_id)
  ) > 1;

UPDATE budgets
SET category_id = (
  SELECT MIN(c2.id) FROM categories c2
  WHERE c2.name = (SELECT c1.name FROM categories c1 WHERE c1.id = budgets.category_id)
    AND c2.type = (SELECT c1.type FROM categories c1 WHERE c1.id = budgets.category_id)
    AND c2.icon = (SELECT c1.icon FROM categories c1 WHERE c1.id = budgets.category_id)
    AND c2.color = (SELECT c1.color FROM categories c1 WHERE c1.id = budgets.category_id)
)
WHERE category_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM categories c3
    WHERE c3.name = (SELECT c1.name FROM categories c1 WHERE c1.id = budgets.category_id)
      AND c3.type = (SELECT c1.type FROM categories c1 WHERE c1.id = budgets.category_id)
      AND c3.icon = (SELECT c1.icon FROM categories c1 WHERE c1.id = budgets.category_id)
      AND c3.color = (SELECT c1.color FROM categories c1 WHERE c1.id = budgets.category_id)
  ) > 1;

UPDATE recurring_transactions
SET category_id = (
  SELECT MIN(c2.id) FROM categories c2
  WHERE c2.name = (SELECT c1.name FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
    AND c2.type = (SELECT c1.type FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
    AND c2.icon = (SELECT c1.icon FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
    AND c2.color = (SELECT c1.color FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
)
WHERE category_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM categories c3
    WHERE c3.name = (SELECT c1.name FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
      AND c3.type = (SELECT c1.type FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
      AND c3.icon = (SELECT c1.icon FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
      AND c3.color = (SELECT c1.color FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
  ) > 1;

UPDATE txn_templates
SET category_id = (
  SELECT MIN(c2.id) FROM categories c2
  WHERE c2.name = (SELECT c1.name FROM categories c1 WHERE c1.id = txn_templates.category_id)
    AND c2.type = (SELECT c1.type FROM categories c1 WHERE c1.id = txn_templates.category_id)
    AND c2.icon = (SELECT c1.icon FROM categories c1 WHERE c1.id = txn_templates.category_id)
    AND c2.color = (SELECT c1.color FROM categories c1 WHERE c1.id = txn_templates.category_id)
)
WHERE category_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM categories c3
    WHERE c3.name = (SELECT c1.name FROM categories c1 WHERE c1.id = txn_templates.category_id)
      AND c3.type = (SELECT c1.type FROM categories c1 WHERE c1.id = txn_templates.category_id)
      AND c3.icon = (SELECT c1.icon FROM categories c1 WHERE c1.id = txn_templates.category_id)
      AND c3.color = (SELECT c1.color FROM categories c1 WHERE c1.id = txn_templates.category_id)
  ) > 1;

-- ② 删除重复分类（保留每组最小 id）
DELETE FROM categories
WHERE (name, type, icon, color) IN (
  SELECT name, type, icon, color FROM categories
  GROUP BY name, type, icon, color HAVING COUNT(*) > 1
)
AND id NOT IN (
  SELECT MIN(id) FROM categories
  GROUP BY name, type, icon, color HAVING COUNT(*) > 1
);

-- ================= 二、账户去重 =================
-- ① 重定向账户引用（loans / transactions / loan_repayments / savings_goals /
--    savings_goal_accounts / recurring_transactions / reconciliations /
--    account_holdings / txn_templates，含 to_account_id / auto_account_id）
UPDATE loans
SET account_id = (
  SELECT MIN(a2.id) FROM accounts a2
  WHERE a2.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = loans.account_id)
    AND a2.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = loans.account_id)
    AND a2.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = loans.account_id)
    AND a2.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = loans.account_id)
)
WHERE account_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM accounts a3
    WHERE a3.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = loans.account_id)
      AND a3.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = loans.account_id)
      AND a3.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = loans.account_id)
      AND a3.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = loans.account_id)
  ) > 1;

UPDATE transactions
SET account_id = (
  SELECT MIN(a2.id) FROM accounts a2
  WHERE a2.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = transactions.account_id)
    AND a2.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = transactions.account_id)
    AND a2.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = transactions.account_id)
    AND a2.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = transactions.account_id)
)
WHERE account_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM accounts a3
    WHERE a3.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = transactions.account_id)
      AND a3.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = transactions.account_id)
      AND a3.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = transactions.account_id)
      AND a3.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = transactions.account_id)
  ) > 1;

UPDATE transactions
SET to_account_id = (
  SELECT MIN(a2.id) FROM accounts a2
  WHERE a2.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = transactions.to_account_id)
    AND a2.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = transactions.to_account_id)
    AND a2.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = transactions.to_account_id)
    AND a2.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = transactions.to_account_id)
)
WHERE to_account_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM accounts a3
    WHERE a3.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = transactions.to_account_id)
      AND a3.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = transactions.to_account_id)
      AND a3.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = transactions.to_account_id)
      AND a3.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = transactions.to_account_id)
  ) > 1;

UPDATE loan_repayments
SET account_id = (
  SELECT MIN(a2.id) FROM accounts a2
  WHERE a2.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = loan_repayments.account_id)
    AND a2.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = loan_repayments.account_id)
    AND a2.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = loan_repayments.account_id)
    AND a2.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = loan_repayments.account_id)
)
WHERE account_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM accounts a3
    WHERE a3.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = loan_repayments.account_id)
      AND a3.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = loan_repayments.account_id)
      AND a3.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = loan_repayments.account_id)
      AND a3.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = loan_repayments.account_id)
  ) > 1;

UPDATE savings_goals
SET account_id = (
  SELECT MIN(a2.id) FROM accounts a2
  WHERE a2.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = savings_goals.account_id)
    AND a2.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = savings_goals.account_id)
    AND a2.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = savings_goals.account_id)
    AND a2.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = savings_goals.account_id)
)
WHERE account_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM accounts a3
    WHERE a3.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = savings_goals.account_id)
      AND a3.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = savings_goals.account_id)
      AND a3.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = savings_goals.account_id)
      AND a3.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = savings_goals.account_id)
  ) > 1;

UPDATE savings_goals
SET auto_account_id = (
  SELECT MIN(a2.id) FROM accounts a2
  WHERE a2.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = savings_goals.auto_account_id)
    AND a2.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = savings_goals.auto_account_id)
    AND a2.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = savings_goals.auto_account_id)
    AND a2.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = savings_goals.auto_account_id)
)
WHERE auto_account_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM accounts a3
    WHERE a3.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = savings_goals.auto_account_id)
      AND a3.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = savings_goals.auto_account_id)
      AND a3.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = savings_goals.auto_account_id)
      AND a3.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = savings_goals.auto_account_id)
  ) > 1;

UPDATE savings_goal_accounts
SET account_id = (
  SELECT MIN(a2.id) FROM accounts a2
  WHERE a2.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = savings_goal_accounts.account_id)
    AND a2.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = savings_goal_accounts.account_id)
    AND a2.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = savings_goal_accounts.account_id)
    AND a2.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = savings_goal_accounts.account_id)
)
WHERE account_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM accounts a3
    WHERE a3.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = savings_goal_accounts.account_id)
      AND a3.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = savings_goal_accounts.account_id)
      AND a3.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = savings_goal_accounts.account_id)
      AND a3.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = savings_goal_accounts.account_id)
  ) > 1;

UPDATE recurring_transactions
SET account_id = (
  SELECT MIN(a2.id) FROM accounts a2
  WHERE a2.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = recurring_transactions.account_id)
    AND a2.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = recurring_transactions.account_id)
    AND a2.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = recurring_transactions.account_id)
    AND a2.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = recurring_transactions.account_id)
)
WHERE account_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM accounts a3
    WHERE a3.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = recurring_transactions.account_id)
      AND a3.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = recurring_transactions.account_id)
      AND a3.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = recurring_transactions.account_id)
      AND a3.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = recurring_transactions.account_id)
  ) > 1;

UPDATE recurring_transactions
SET to_account_id = (
  SELECT MIN(a2.id) FROM accounts a2
  WHERE a2.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = recurring_transactions.to_account_id)
    AND a2.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = recurring_transactions.to_account_id)
    AND a2.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = recurring_transactions.to_account_id)
    AND a2.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = recurring_transactions.to_account_id)
)
WHERE to_account_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM accounts a3
    WHERE a3.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = recurring_transactions.to_account_id)
      AND a3.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = recurring_transactions.to_account_id)
      AND a3.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = recurring_transactions.to_account_id)
      AND a3.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = recurring_transactions.to_account_id)
  ) > 1;

UPDATE reconciliations
SET account_id = (
  SELECT MIN(a2.id) FROM accounts a2
  WHERE a2.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = reconciliations.account_id)
    AND a2.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = reconciliations.account_id)
    AND a2.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = reconciliations.account_id)
    AND a2.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = reconciliations.account_id)
)
WHERE account_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM accounts a3
    WHERE a3.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = reconciliations.account_id)
      AND a3.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = reconciliations.account_id)
      AND a3.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = reconciliations.account_id)
      AND a3.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = reconciliations.account_id)
  ) > 1;

UPDATE account_holdings
SET account_id = (
  SELECT MIN(a2.id) FROM accounts a2
  WHERE a2.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = account_holdings.account_id)
    AND a2.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = account_holdings.account_id)
    AND a2.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = account_holdings.account_id)
    AND a2.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = account_holdings.account_id)
)
WHERE account_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM accounts a3
    WHERE a3.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = account_holdings.account_id)
      AND a3.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = account_holdings.account_id)
      AND a3.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = account_holdings.account_id)
      AND a3.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = account_holdings.account_id)
  ) > 1;

UPDATE txn_templates
SET account_id = (
  SELECT MIN(a2.id) FROM accounts a2
  WHERE a2.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = txn_templates.account_id)
    AND a2.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = txn_templates.account_id)
    AND a2.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = txn_templates.account_id)
    AND a2.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = txn_templates.account_id)
)
WHERE account_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM accounts a3
    WHERE a3.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = txn_templates.account_id)
      AND a3.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = txn_templates.account_id)
      AND a3.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = txn_templates.account_id)
      AND a3.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = txn_templates.account_id)
  ) > 1;

UPDATE txn_templates
SET to_account_id = (
  SELECT MIN(a2.id) FROM accounts a2
  WHERE a2.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = txn_templates.to_account_id)
    AND a2.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = txn_templates.to_account_id)
    AND a2.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = txn_templates.to_account_id)
    AND a2.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = txn_templates.to_account_id)
)
WHERE to_account_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM accounts a3
    WHERE a3.name = (SELECT a1.name FROM accounts a1 WHERE a1.id = txn_templates.to_account_id)
      AND a3.type = (SELECT a1.type FROM accounts a1 WHERE a1.id = txn_templates.to_account_id)
      AND a3.icon = (SELECT a1.icon FROM accounts a1 WHERE a1.id = txn_templates.to_account_id)
      AND a3.color = (SELECT a1.color FROM accounts a1 WHERE a1.id = txn_templates.to_account_id)
  ) > 1;

-- ② 删除重复账户（保留每组最小 id）
DELETE FROM accounts
WHERE (name, type, icon, color) IN (
  SELECT name, type, icon, color FROM accounts
  GROUP BY name, type, icon, color HAVING COUNT(*) > 1
)
AND id NOT IN (
  SELECT MIN(id) FROM accounts
  GROUP BY name, type, icon, color HAVING COUNT(*) > 1
);
