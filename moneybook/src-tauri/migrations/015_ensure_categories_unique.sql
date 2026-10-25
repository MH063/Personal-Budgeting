-- 015: 内置分类「幂等去重 + 完整性补齐」（根治「分类成对重复 / 创建多余分类」）
--
-- 背景：011 做了一次性去重，但 001 迁移的预置分类 INSERT 仍无幂等保护
-- （无 WHERE NOT EXISTS）。一旦迁移记录再次丢失/库重建/旧备份恢复导致 001 重跑，
-- 22 个内置分类会被整批再插一份 → 分类管理页出现成对重复（用户实测：餐饮×2、工资×2…）。
-- 011 已标记完成不会重跑，此类新重复无人清理。
--
-- 判重口径：仅按 name+type（图标/颜色是用户可自由修改的装饰字段，且 createCategory 已按
-- 名称+类型幂等防重，同名不同图标的分支在新代码下不会再产生，故以名称+类型清理更彻底）。
-- 本迁移保证：
--   ① 引用重定向 + 删除重复（按 name+type 分组保留最小 id，对 011 之后新增的重复同样生效，
--      幂等：无重复则为无操作）；
--   ② 完整性补齐：确保 001 定义的 22 个内置分类在库中存在（软删除视为已存在、不打扰
--      用户主动删除；真正缺失才补插），使「迁移记录丢失 → 全量重跑」后仍自洽。
-- 说明：迁移文件一旦发布不可修改；后续如需调整请新增 016+。

-- ================= 一、引用重定向 =================
-- 把指向「重复组内非最小 id」的 category_id 改到组内最小 id（transactions /
-- budgets / recurring_transactions / txn_templates 四张引用表）。
UPDATE transactions
SET category_id = (
  SELECT MIN(c2.id) FROM categories c2
  WHERE c2.name = (SELECT c1.name FROM categories c1 WHERE c1.id = transactions.category_id)
    AND c2.type = (SELECT c1.type FROM categories c1 WHERE c1.id = transactions.category_id)
)
WHERE category_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM categories c3
    WHERE c3.name = (SELECT c1.name FROM categories c1 WHERE c1.id = transactions.category_id)
      AND c3.type = (SELECT c1.type FROM categories c1 WHERE c1.id = transactions.category_id)
  ) > 1;

UPDATE budgets
SET category_id = (
  SELECT MIN(c2.id) FROM categories c2
  WHERE c2.name = (SELECT c1.name FROM categories c1 WHERE c1.id = budgets.category_id)
    AND c2.type = (SELECT c1.type FROM categories c1 WHERE c1.id = budgets.category_id)
)
WHERE category_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM categories c3
    WHERE c3.name = (SELECT c1.name FROM categories c1 WHERE c1.id = budgets.category_id)
      AND c3.type = (SELECT c1.type FROM categories c1 WHERE c1.id = budgets.category_id)
  ) > 1;

UPDATE recurring_transactions
SET category_id = (
  SELECT MIN(c2.id) FROM categories c2
  WHERE c2.name = (SELECT c1.name FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
    AND c2.type = (SELECT c1.type FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
)
WHERE category_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM categories c3
    WHERE c3.name = (SELECT c1.name FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
      AND c3.type = (SELECT c1.type FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
  ) > 1;

UPDATE txn_templates
SET category_id = (
  SELECT MIN(c2.id) FROM categories c2
  WHERE c2.name = (SELECT c1.name FROM categories c1 WHERE c1.id = txn_templates.category_id)
    AND c2.type = (SELECT c1.type FROM categories c1 WHERE c1.id = txn_templates.category_id)
)
WHERE category_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM categories c3
    WHERE c3.name = (SELECT c1.name FROM categories c1 WHERE c1.id = txn_templates.category_id)
      AND c3.type = (SELECT c1.type FROM categories c1 WHERE c1.id = txn_templates.category_id)
  ) > 1;

-- ================= 二、删除重复分类（按 name+type 分组保留最小 id；幂等：无重复则无操作） =================
DELETE FROM categories
WHERE (name, type) IN (
  SELECT name, type FROM categories
  GROUP BY name, type HAVING COUNT(*) > 1
)
AND id NOT IN (
  SELECT MIN(id) FROM categories
  GROUP BY name, type HAVING COUNT(*) > 1
);

-- ================= 三、完整性补齐（与 001 种子一致；软删除视为已存在，不打扰用户） =================
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '餐饮','expense','🍜','#EF4444',1 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='餐饮' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '交通','expense','🚌','#3B82F6',2 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='交通' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '购物','expense','🛍️','#8B5CF6',3 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='购物' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '居住','expense','🏠','#F59E0B',4 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='居住' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '娱乐','expense','🎮','#EC4899',5 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='娱乐' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '医疗','expense','💊','#14B8A6',6 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='医疗' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '教育','expense','📚','#6366F1',7 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='教育' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '人情','expense','🎁','#F97316',8 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='人情' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '通讯','expense','📱','#06B6D4',9 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='通讯' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '旅行','expense','✈️','#0EA5E9',10 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='旅行' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '美妆','expense','💄','#F43F5E',11 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='美妆' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '运动','expense','🏃','#22C55E',12 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='运动' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '数码','expense','💼','#64748B',13 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='数码' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '宠物','expense','🐱','#84CC16',14 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='宠物' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '宝宝','expense','👶','#F472B6',15 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='宝宝' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '网购','expense','🛒','#D946EF',16 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='网购' AND type='expense');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '工资','income','💰','#10B981',1 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='工资' AND type='income');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '奖金','income','🏆','#F59E0B',2 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='奖金' AND type='income');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '兼职','income','💼','#3B82F6',3 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='兼职' AND type='income');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '投资收益','income','📈','#8B5CF6',4 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='投资收益' AND type='income');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '红包','income','🧧','#EF4444',5 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='红包' AND type='income');
INSERT INTO categories (name, type, icon, color, sort_order)
SELECT '其他收入','income','💵','#6B7280',6 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='其他收入' AND type='income');
