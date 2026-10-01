import { execute, select } from './db';
import { currentLedgerId } from '@/lib/ledger';

/** 导入历史审计条目 */
export interface ImportLog {
  id: number;
  file_name: string;
  file_count: number;
  imported: number;
  skipped: number;
  duplicates: number;
  created_accounts: number;
  created_categories: number;
  ledger_id: number;
  imported_at: string;
}

/**
 * 记录一次批量导入审计：文件、落库条数、跳过/重复数、自动创建的账户/分类数与时间。
 * 用于追溯导入历史，并帮助用户识别重复导入带来的数据影响。
 */
export async function recordImportLog(p: {
  fileName: string;
  fileCount: number;
  imported: number;
  skipped: number;
  duplicates: number;
  createdAccounts: number;
  createdCategories: number;
}): Promise<void> {
  await execute(
    `INSERT INTO import_logs
      (file_name, file_count, imported, skipped, duplicates, created_accounts, created_categories, ledger_id, imported_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,datetime('now','localtime'))`,
    [p.fileName, p.fileCount, p.imported, p.skipped, p.duplicates, p.createdAccounts, p.createdCategories, currentLedgerId()]
  );
}

/** 查询当前账本最近的导入历史（按时间倒序，默认最近 50 条） */
export function listImportLogs(limit = 50): Promise<ImportLog[]> {
  return select<ImportLog>(
    `SELECT * FROM import_logs WHERE ledger_id = $1 ORDER BY imported_at DESC, id DESC LIMIT $2`,
    [currentLedgerId(), limit]
  );
}