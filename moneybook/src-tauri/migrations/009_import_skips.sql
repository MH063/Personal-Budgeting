-- 009: 导入跳过明细持久化（用户要求：跳过的数据可追溯、可补导入）
--
-- 背景：此前批量导入时被跳过的数据（疑似重复、金额无效、类型无法识别等）
-- 只记录数量（import_logs.skipped / duplicates），不保存明细，关闭页面即丢失，
-- 无法追溯与补导入。本迁移新增 import_skips 表，逐条保存被跳过的行号、
-- 原因与原始解析字段（JSON），与导入历史 import_logs 关联，供追溯与补导入。
--
-- 说明：本表由 009 迁移创建（幂等），随版本发布在应用启动时自动执行；
-- 如需手动建表，可直接执行下方 CREATE TABLE 语句（SQLite，与迁移等价）。

CREATE TABLE IF NOT EXISTS import_skips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id INTEGER NOT NULL REFERENCES import_logs(id) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  reason TEXT NOT NULL,
  row_data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_import_skips_log ON import_skips(log_id);
