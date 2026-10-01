-- 008: 清理「内置预置账户」空壳（用户要求：账户应由用户自行创建，不再预置）
--
-- 背景：001 迁移曾内置 8 个默认账户（现金/微信/支付宝/银行卡/信用卡/储蓄/应收款/应付款）。
-- 本迁移只删除「从未被使用」的预置空壳账户，采用多重限缩条件，确保绝不破坏用户数据：
--   1) id 在预置区间（1..8，即 001 首次插入时分配的 id）；
--   2) 名称命中预置名单；
--   3) 当前余额与初始余额均为 0；
--   4) 没有任何流水引用（account_id / to_account_id，含转账）。
-- 效果：
--   · 全新数据库：001 刚插入的 8 个空壳会被立即清空 → 等价于「不预置账户」；
--   · 历史数据库：仅清理未使用的空壳；有余额或有流水的账户（用户真实在用）原样保留。
-- 说明：迁移文件一旦发布不可修改（sqlx 校验 checksum），后续账户相关调整请新增 009+。

DELETE FROM accounts
WHERE id BETWEEN 1 AND 8
  AND name IN ('现金', '微信', '支付宝', '银行卡', '信用卡', '储蓄', '应收款', '应付款')
  AND balance = 0
  AND initial_balance = 0
  AND NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.account_id = accounts.id OR t.to_account_id = accounts.id
  );