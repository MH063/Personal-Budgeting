-- 记息扩展：借贷增加年利率与期数字段（单利已按天计息）
-- 该迁移会被插件按版本号执行且仅执行一次；011_init.sql 已创建 loans 表，
-- 因此这里只做增量 ALTER，无需判断列是否存在。
ALTER TABLE loans ADD COLUMN rate REAL NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN periods INTEGER;