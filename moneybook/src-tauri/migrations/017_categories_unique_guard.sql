-- 017: 分类「同名同类型唯一」数据库级护栏（根治分类整批重复）
--
-- 根因（为什么更新后还会重复）：
--   001 迁移的 22 条预置分类 INSERT 没有幂等保护（无 NOT EXISTS）。迁移记录
--   （_sqlx_migrations）一旦再次丢失——数据目录切换、便携迁移、备份恢复、异常中断、
--   版本回滚等——001 就会整批重跑，再插一份 22 条，表现为分类管理页「餐饮×2、工资×2…」。
--   011 / 015 只是在「当时」做了一次去重，属于一次性补丁：它们标记完成后不会重跑，
--   所以 001 之后再重跑时，重复照样产生且无人清理。
--
-- 本质修复：把约束下沉到数据库，而不是依赖「某次迁移恰好跑过」。
--   ① 先把当前已存在的活跃重复合并掉（引用重定向 + 删除）；
--   ② 建 BEFORE INSERT 触发器：库里已有同名同类型的活跃分类时，直接 IGNORE 掉本次插入。
--      这样无论 001 重跑、导入自动建类、引导补插、用户手建，任何路径都不可能再产生重复；
--      且 001 重跑时 INSERT 被静默忽略，迁移不会因唯一冲突而失败。
--
-- 口径说明：
--   * 只看 is_active = 1（活跃）行：软删除（is_active = 0）的分类不参与查重，
--     与 createCategory / 导入查重的既有语义一致（删除后可重新创建同名分类）。
--   * 合并保留「活跃组内最小 id」，与 015 的保留口径一致，避免引用漂移。
--
-- 迁移文件一旦发布不可修改；后续如需调整请新增 018+。

-- ================= 一、引用重定向（指向被合并的活跃重复项 → 组内最小活跃 id） =================
UPDATE transactions
SET category_id = (
  SELECT MIN(c2.id) FROM categories c2
  WHERE c2.name = (SELECT c1.name FROM categories c1 WHERE c1.id = transactions.category_id)
    AND c2.type = (SELECT c1.type FROM categories c1 WHERE c1.id = transactions.category_id)
    AND c2.is_active = 1
)
WHERE category_id IS NOT NULL
  AND (SELECT c1.is_active FROM categories c1 WHERE c1.id = transactions.category_id) = 1
  AND (
    SELECT COUNT(*) FROM categories c3
    WHERE c3.name = (SELECT c1.name FROM categories c1 WHERE c1.id = transactions.category_id)
      AND c3.type = (SELECT c1.type FROM categories c1 WHERE c1.id = transactions.category_id)
      AND c3.is_active = 1
  ) > 1;

UPDATE budgets
SET category_id = (
  SELECT MIN(c2.id) FROM categories c2
  WHERE c2.name = (SELECT c1.name FROM categories c1 WHERE c1.id = budgets.category_id)
    AND c2.type = (SELECT c1.type FROM categories c1 WHERE c1.id = budgets.category_id)
    AND c2.is_active = 1
)
WHERE category_id IS NOT NULL
  AND (SELECT c1.is_active FROM categories c1 WHERE c1.id = budgets.category_id) = 1
  AND (
    SELECT COUNT(*) FROM categories c3
    WHERE c3.name = (SELECT c1.name FROM categories c1 WHERE c1.id = budgets.category_id)
      AND c3.type = (SELECT c1.type FROM categories c1 WHERE c1.id = budgets.category_id)
      AND c3.is_active = 1
  ) > 1;

UPDATE recurring_transactions
SET category_id = (
  SELECT MIN(c2.id) FROM categories c2
  WHERE c2.name = (SELECT c1.name FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
    AND c2.type = (SELECT c1.type FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
    AND c2.is_active = 1
)
WHERE category_id IS NOT NULL
  AND (SELECT c1.is_active FROM categories c1 WHERE c1.id = recurring_transactions.category_id) = 1
  AND (
    SELECT COUNT(*) FROM categories c3
    WHERE c3.name = (SELECT c1.name FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
      AND c3.type = (SELECT c1.type FROM categories c1 WHERE c1.id = recurring_transactions.category_id)
      AND c3.is_active = 1
  ) > 1;

UPDATE txn_templates
SET category_id = (
  SELECT MIN(c2.id) FROM categories c2
  WHERE c2.name = (SELECT c1.name FROM categories c1 WHERE c1.id = txn_templates.category_id)
    AND c2.type = (SELECT c1.type FROM categories c1 WHERE c1.id = txn_templates.category_id)
    AND c2.is_active = 1
)
WHERE category_id IS NOT NULL
  AND (SELECT c1.is_active FROM categories c1 WHERE c1.id = txn_templates.category_id) = 1
  AND (
    SELECT COUNT(*) FROM categories c3
    WHERE c3.name = (SELECT c1.name FROM categories c1 WHERE c1.id = txn_templates.category_id)
      AND c3.type = (SELECT c1.type FROM categories c1 WHERE c1.id = txn_templates.category_id)
      AND c3.is_active = 1
  ) > 1;

-- ================= 二、删除活跃重复（同名同类型多份时，仅保留最小 id 的活跃行） =================
-- 注意：只删 is_active = 1 的行；软删除行保持原样，不做跨状态合并（避免把活跃引用指向已删分类）。
DELETE FROM categories
WHERE is_active = 1
  AND id NOT IN (
    SELECT MIN(id) FROM categories WHERE is_active = 1 GROUP BY name, type
  )
  AND (name, type) IN (
    SELECT name, type FROM categories WHERE is_active = 1 GROUP BY name, type HAVING COUNT(*) > 1
  );

-- ================= 三、插入护栏：同名同类型已存在活跃行时，静默忽略本次插入 =================
-- 为什么不用 UNIQUE 索引：001 重跑时 INSERT 是「无条件 VALUES」，唯一冲突会让整条迁移失败、
-- 进而导致应用无法打开数据库；RAISE(IGNORE) 则跳过重复行、迁移照常完成，且不产生重复。
DROP TRIGGER IF EXISTS trg_categories_unique_active;
CREATE TRIGGER trg_categories_unique_active
BEFORE INSERT ON categories
WHEN NEW.is_active = 1 AND EXISTS (
  SELECT 1 FROM categories
  WHERE name = NEW.name AND type = NEW.type AND is_active = 1
)
BEGIN
  SELECT RAISE(IGNORE);
END;
