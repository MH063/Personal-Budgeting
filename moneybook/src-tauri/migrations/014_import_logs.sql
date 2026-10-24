-- 014: 补建导入历史表 import_logs
--
-- 背景：import_logs 的建表语句历史上只存在于前端 schema 建表脚本，
-- 从未纳入迁移体系；上轮「清理前端孤儿 DDL、统一由迁移维护」后，
-- 新库与升级库都不再自动创建该表，导致：
--   1) 导入审计（recordImportLog / listImportLogs）报 no such table: import_logs；
--   2) 恢复出厂设置（动态清空全部表）被该缺表中断，整体失败。
-- 本迁移在 Rust 侧补建该表（幂等），字段与 src/api/importLog.ts 的读写完全对齐。
-- 009 迁移的 import_skips 表以本表 id 为外键，建表顺序在 009 之后。

CREATE TABLE IF NOT EXISTS import_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  created_accounts INTEGER NOT NULL DEFAULT 0,
  created_categories INTEGER NOT NULL DEFAULT 0,
  ledger_id INTEGER NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_import_logs_ledger_time
  ON import_logs(ledger_id, imported_at DESC);
