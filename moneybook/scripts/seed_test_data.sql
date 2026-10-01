-- ============================================================================
-- seed_test_data.sql —— 真实数据测试脚本（幂等）
-- ----------------------------------------------------------------------------
-- 用途：给财务问答/支出预测/订阅提醒/异常检测/智能洞察 注入一组有真实感的
--       模拟交易，便于验证这些功能（尤其财务问答接入 AI 后的效果）。
--
-- 适用环境：仅 Tauri 桌面模式（moneybook.db 存在）。
--   · 浏览器预览（vite，非 Tauri）数据库不可达，无法落库，本脚本不适用。
--   · 桌面库位置：应用数据目录，通常由 `get_db_path` 返回（拖动 "moneybook.db"）。
--
-- 执行方式（任选其一）：
--   1) 控制台对桌面库：  sqlite3 "路径\moneybook.db" < scripts/seed_test_data.sql
--   2) 或把本 SQL 粘进数据库管理工具执行。
--   3) 应用需先正常启动以建好 accounts/categories（初始数据），再执行本脚本。
--
-- 幂等：重复执行会先清除本脚本写入的（note 以 `seed:` 前缀）数据，不会叠加。
-- 数据覆盖：近 3 个月，收入/支出/转账/借出/借入，多分类、多商户、订阅类、
--           涨价/重复扣费、异常大额，含交易明细 5 字段（支付时间/付款方式/
--           收款方/订单号/商家订单号）。
-- ============================================================================

-- 1) 幂等清理旧 seed 数据（先删标签关联，再删交易）
DELETE FROM transaction_tags
 WHERE transaction_id IN (SELECT id FROM transactions WHERE note LIKE 'seed:%');
DELETE FROM transactions WHERE note LIKE 'seed:%';

-- 2) 标签（INSERT OR IGNORE）
INSERT OR IGNORE INTO tags (name, color) VALUES
  ('房租','#F59E0B'), ('通勤','#3B82F6'), ('订阅','#8B5CF6'),
  ('午餐','#EF4444'), ('网购','#EC4899'), ('家人','#10B981');

-- 3) 交易（账户/分类用子查询解析，兼容已有库 id）
--    支出：餐饮 / 交通 / 购物 / 居住 / 娱乐 / 医疗
INSERT INTO transactions
 (type, amount, category_id, account_id, to_account_id, loan_id, date, note,
  pay_time, pay_method, payee, order_no, merchant_order_no, created_at, updated_at, ledger_id)
VALUES
 -- ===== 支出 · 餐饮（近 3 月，用于预测/商户画像）=====
 ('expense', 32.50, (SELECT id FROM categories WHERE name='餐饮' LIMIT 1), (SELECT id FROM accounts WHERE name='支付宝' LIMIT 1), NULL, NULL, date('now','-70 day'), 'seed:午餐 麦当劳',
  datetime('now','-70 day','+8 min'), '支付宝', '麦当劳(金拱门)', 'ORDER-20260601-001', 'M20260601001', datetime('now'), datetime('now'), 1),
 ('expense', 28.00, (SELECT id FROM categories WHERE name='餐饮' LIMIT 1), (SELECT id FROM accounts WHERE name='微信' LIMIT 1), NULL, NULL, date('now','-60 day'), 'seed:午餐 星巴克',
  datetime('now','-60 day','+12 min'), '微信支付', 'Starbucks', 'ORDER-20260611-002', 'M20260611002', datetime('now'), datetime('now'), 1),
 ('expense', 88.00, (SELECT id FROM categories WHERE name='餐饮' LIMIT 1), (SELECT id FROM accounts WHERE name='支付宝' LIMIT 1), NULL, NULL, date('now','-45 day'), 'seed:晚餐 火锅',
  datetime('now','-45 day','+18 min'), '支付宝', '海底捞火锅', 'ORDER-20260626-003', 'M20260626003', datetime('now'), datetime('now'), 1),
 ('expense', 16.50, (SELECT id FROM categories WHERE name='餐饮' LIMIT 1), (SELECT id FROM accounts WHERE name='微信' LIMIT 1), NULL, NULL, date('now','-30 day'), 'seed:午餐 麦当劳',
  datetime('now','-30 day','+9 min'), '微信支付', '麦当劳', 'ORDER-20260711-004', 'M20260711004', datetime('now'), datetime('now'), 1),
 ('expense', 12.00, (SELECT id FROM categories WHERE name='餐饮' LIMIT 1), (SELECT id FROM accounts WHERE name='支付宝' LIMIT 1), NULL, NULL, date('now','-20 day'), 'seed:早餐 生煎',
  datetime('now','-20 day','+7 min'), '支付宝', '某某生煎', 'ORDER-20260726-005', 'M20260726005', datetime('now'), datetime('now'), 1),
 ('expense', 5.00, (SELECT id FROM categories WHERE name='餐饮' LIMIT 1), (SELECT id FROM accounts WHERE name='现金' LIMIT 1), NULL, NULL, date('now','-1 day'), 'seed:油条豆浆',
  NULL, '现金', '街边早餐', NULL, NULL, datetime('now'), datetime('now'), 1),

 -- ===== 支出 · 交通 =====
 ('expense', 4.00, (SELECT id FROM categories WHERE name='交通' LIMIT 1), (SELECT id FROM accounts WHERE name='微信' LIMIT 1), NULL, NULL, date('now','-62 day'), 'seed:地铁通勤',
  datetime('now','-62 day','+40 min'), '微信支付', '地铁', 'ORDER-20260601-006', 'M20260601006', datetime('now'), datetime('now'), 1),
 ('expense', 4.00, (SELECT id FROM categories WHERE name='交通' LIMIT 1), (SELECT id FROM accounts WHERE name='微信' LIMIT 1), NULL, NULL, date('now','-32 day'), 'seed:地铁通勤',
  datetime('now','-32 day','+41 min'), '微信支付', '地铁', 'ORDER-20260701-007', 'M20260701007', datetime('now'), datetime('now'), 1),
 ('expense', 58.00, (SELECT id FROM categories WHERE name='交通' LIMIT 1), (SELECT id FROM accounts WHERE name='银行卡' LIMIT 1), NULL, NULL, date('now','-25 day'), 'seed:打车去机场',
  datetime('now','-25 day','+30 min'), '银行卡', '滴滴出行', 'ORDER-20260706-008', 'M20260706008', datetime('now'), datetime('now'), 1),
 ('expense', 100.00, (SELECT id FROM categories WHERE name='交通' LIMIT 1), (SELECT id FROM accounts WHERE name='支付宝' LIMIT 1), NULL, NULL, date('now','-10 day'), 'seed:加油',
  datetime('now','-10 day','+50 min'), '支付宝', '中石化加油站', 'ORDER-20260721-009', 'M20260721009', datetime('now'), datetime('now'), 1),

 -- ===== 支出 · 订阅/重复扣费（每月固定，用于订阅识别与涨价）=====
 ('expense', 15.00, (SELECT id FROM categories WHERE name='娱乐' LIMIT 1), (SELECT id FROM accounts WHERE name='微信' LIMIT 1), NULL, NULL, date('now','-75 day'), 'seed:视频会员',
  datetime('now','-75 day','+10 min'), '微信支付', '某视频会员', 'ORDER-6-001', 'M6-001', datetime('now'), datetime('now'), 1),
 ('expense', 15.00, (SELECT id FROM categories WHERE name='娱乐' LIMIT 1), (SELECT id FROM accounts WHERE name='微信' LIMIT 1), NULL, NULL, date('now','-45 day'), 'seed:视频会员',
  datetime('now','-45 day','+10 min'), '微信支付', '某视频会员', 'ORDER-6-002', 'M6-002', datetime('now'), datetime('now'), 1),
 ('expense', 25.00, (SELECT id FROM categories WHERE name='娱乐' LIMIT 1), (SELECT id FROM accounts WHERE name='微信' LIMIT 1), NULL, NULL, date('now','-15 day'), 'seed:视频会员（涨价）',
  datetime('now','-15 day','+10 min'), '微信支付', '某视频会员', 'ORDER-6-003', 'M6-003', datetime('now'), datetime('now'), 1), -- 15→25 触发涨价

 ('expense', 30.00, (SELECT id FROM categories WHERE name='娱乐' LIMIT 1), (SELECT id FROM accounts WHERE name='支付宝' LIMIT 1), NULL, NULL, date('now','-60 day'), 'seed:云盘会员',
  datetime('now','-60 day','+15 min'), '支付宝', '某云盘超级会员', 'ORDER-7-001', 'M7-001', datetime('now'), datetime('now'), 1),
 ('expense', 30.00, (SELECT id FROM categories WHERE name='娱乐' LIMIT 1), (SELECT id FROM accounts WHERE name='支付宝' LIMIT 1), NULL, NULL, date('now','-30 day'), 'seed:云盘会员',
  datetime('now','-30 day','+15 min'), '支付宝', '某云盘超级会员', 'ORDER-7-002', 'M7-002', datetime('now'), datetime('now'), 1),

 -- ===== 支出 · 居住（房租，每月固定）=====
 ('expense', 3200.00, (SELECT id FROM categories WHERE name='居住' LIMIT 1), (SELECT id FROM accounts WHERE name='银行卡' LIMIT 1), NULL, NULL, date('now','-70 day'), 'seed:房租',
  datetime('now','-70 day','+5 min'), '银行卡', '房租·王房东', 'ORDER-8-001', 'M8-001', datetime('now'), datetime('now'), 1),
 ('expense', 3200.00, (SELECT id FROM categories WHERE name='居住' LIMIT 1), (SELECT id FROM accounts WHERE name='银行卡' LIMIT 1), NULL, NULL, date('now','-40 day'), 'seed:房租',
  datetime('now','-40 day','+5 min'), '银行卡', '房租·王房东', 'ORDER-8-002', 'M8-002', datetime('now'), datetime('now'), 1),
 ('expense', 120.00, (SELECT id FROM categories WHERE name='居住' LIMIT 1), (SELECT id FROM accounts WHERE name='微信' LIMIT 1), NULL, NULL, date('now','-33 day'), 'seed:水电',
  datetime('now','-33 day','+3 min'), '微信支付', '国网电费', 'ORDER-9-001', 'M9-001', datetime('now'), datetime('now'), 1),
 ('expense', 150.00, (SELECT id FROM categories WHERE name='居住' LIMIT 1), (SELECT id FROM accounts WHERE name='微信' LIMIT 1), NULL, NULL, date('now','-12 day'), 'seed:水电',
  datetime('now','-12 day','+3 min'), '微信支付', '国网电费', 'ORDER-9-002', 'M9-002', datetime('now'), datetime('now'), 1),

 -- ===== 支出 · 购物/娱乐 =====
 ('expense', 199.00, (SELECT id FROM categories WHERE name='购物' LIMIT 1), (SELECT id FROM accounts WHERE name='支付宝' LIMIT 1), NULL, NULL, date('now','-55 day'), 'seed:球鞋',
  datetime('now','-55 day','+20 min'), '支付宝', '某运动旗舰店', 'ORDER-10-001', 'M10-001', datetime('now'), datetime('now'), 1),
 ('expense', 45.00, (SELECT id FROM categories WHERE name='娱乐' LIMIT 1), (SELECT id FROM accounts WHERE name='微信' LIMIT 1), NULL, NULL, date('now','-8 day'), 'seed:电影票',
  datetime('now','-8 day','+35 min'), '微信支付', '某影院', 'ORDER-10-002', 'M10-002', datetime('now'), datetime('now'), 1),

 -- ===== 支出 · 异常大额（用于异常检测，金额显著离群）=====
 ('expense', 8800.00, (SELECT id FROM categories WHERE name='购物' LIMIT 1), (SELECT id FROM accounts WHERE name='信用卡' LIMIT 1), NULL, NULL, date('now','-18 day'), 'seed:疑似大额',
  datetime('now','-18 day','+25 min'), '信用卡', '某境外网站', 'ORDER-999-001', 'M999-001', datetime('now'), datetime('now'), 1),

 -- ===== 收入 =====
 ('income', 15000.00, (SELECT id FROM categories WHERE name='工资' LIMIT 1), (SELECT id FROM accounts WHERE name='银行卡' LIMIT 1), NULL, NULL, date('now','-80 day'), 'seed:工资',
  datetime('now','-80 day','+1 min'), '银行代发', '公司', 'PAY-1-001', 'C1', datetime('now'), datetime('now'), 1),
 ('income', 15000.00, (SELECT id FROM categories WHERE name='工资' LIMIT 1), (SELECT id FROM accounts WHERE name='银行卡' LIMIT 1), NULL, NULL, date('now','-50 day'), 'seed:工资',
  datetime('now','-50 day','+1 min'), '银行代发', '公司', 'PAY-1-002', 'C1', datetime('now'), datetime('now'), 1),
 ('income', 15500.00, (SELECT id FROM categories WHERE name='工资' LIMIT 1), (SELECT id FROM accounts WHERE name='银行卡' LIMIT 1), NULL, NULL, date('now','-19 day'), 'seed:工资',
  datetime('now','-19 day','+1 min'), '银行代发', '公司', 'PAY-1-003', 'C1', datetime('now'), datetime('now'), 1),
 ('income', 500.00, (SELECT id FROM categories WHERE name='奖金' LIMIT 1), (SELECT id FROM accounts WHERE name='银行卡' LIMIT 1), NULL, NULL, date('now','-10 day'), 'seed:季度奖金',
  datetime('now','-10 day','+2 min'), '银行代发', '公司', 'PAY-2-001', 'C2', datetime('now'), datetime('now'), 1),

 -- ===== 转账（账户间）=====
 ('transfer', 2000.00, NULL, (SELECT id FROM accounts WHERE name='银行卡' LIMIT 1), (SELECT id FROM accounts WHERE name='微信' LIMIT 1), NULL, date('now','-28 day'), 'seed:转零钱',
  datetime('now','-28 day','+30 min'), '银行转账', NULL, 'T-1-001', NULL, datetime('now'), datetime('now'), 1),

 -- ===== 借出 =====
 ('lend', 1000.00, NULL, (SELECT id FROM accounts WHERE name='现金' LIMIT 1), NULL, NULL, date('now','-40 day'), 'seed:借给朋友',
  NULL, '现金', '张三', NULL, NULL, datetime('now'), datetime('now'), 1);

-- 4) 交易标签关联（用 note 前缀回查）
INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id)
SELECT t.id, tag.id FROM transactions t, tags tag
WHERE t.note LIKE 'seed:%'
  AND (
    (tag.name='午餐' AND t.note LIKE '%午餐%')
    OR (tag.name='通勤' AND t.note LIKE '%地铁%')
    OR (tag.name='订阅' AND (t.note LIKE '%会员%' OR t.note LIKE '%云盘%'))
    OR (tag.name='房租' AND t.note LIKE '%房租%')
    OR (tag.name='家人' AND t.note LIKE 'seed:借给朋友%')
  );

-- 提示：以上交易未改 accounts.balance（余额中性），便于只测统计/问答/洞察；
-- 若需余额同步，可在应用内"账户"页查看（或运行后手工核对）。重复执行本脚本会先清旧 seed 再插入。