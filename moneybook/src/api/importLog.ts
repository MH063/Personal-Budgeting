import { execute, select, runInTransaction } from './db';
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

/** 一次导入中被跳过的单条明细（持久化，可追溯与补导入） */
export interface ImportSkip {
  id: number;
  log_id: number;
  /** 原文件行号 */
  line: number;
  /** 跳过原因（如：疑似重复、金额无效、类型无法识别） */
  reason: string;
  /** 原始解析字段（ImportRow 的 JSON 序列化，供补导入还原） */
  row_data: string;
  created_at: string;
}

/** 记录跳过明细入参（row 为原始解析行，序列化保存） */
export interface SkipDetailInput {
  line: number;
  reason: string;
  row: unknown;
}

/**
 * 记录一次批量导入审计：文件、落库条数、跳过/重复数、自动创建的账户/分类数与时间，
 * 并在同一事务内持久化每条跳过明细（行号 + 原因 + 原始字段 JSON）。
 * 用于追溯导入历史、识别重复导入影响，并支持日后查看 / 补导入跳过的数据。
 */
export async function recordImportLog(p: {
  fileName: string;
  fileCount: number;
  imported: number;
  skipped: number;
  duplicates: number;
  createdAccounts: number;
  createdCategories: number;
  /** 跳过的明细（行号 + 原因 + 原始字段），缺省时不写入明细 */
  skips?: SkipDetailInput[];
}): Promise<void> {
  await runInTransaction(async () => {
    const res = await execute(
      `INSERT INTO import_logs
        (file_name, file_count, imported, skipped, duplicates, created_accounts, created_categories, ledger_id, imported_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,datetime('now','localtime'))`,
      [p.fileName, p.fileCount, p.imported, p.skipped, p.duplicates, p.createdAccounts, p.createdCategories, currentLedgerId()]
    );
    const logId = res.lastInsertId;
    // 跳过明细随审计一并落库（与日志同一事务，保证「有跳过数就有明细」）
    for (const s of p.skips ?? []) {
      await execute(
        `INSERT INTO import_skips (log_id, line, reason, row_data)
         VALUES ($1,$2,$3,$4)`,
        [logId, s.line, s.reason, JSON.stringify(s.row ?? {})]
      );
    }
  });
}

/** 查询某次导入的跳过明细（按原文件行号排序） */
export function listImportSkips(logId: number): Promise<ImportSkip[]> {
  return select<ImportSkip>(
    `SELECT * FROM import_skips WHERE log_id = $1 ORDER BY line, id`,
    [logId]
  );
}

/** 查询当前账本最近的导入历史（按时间倒序，默认最近 50 条） */
export function listImportLogs(limit = 50): Promise<ImportLog[]> {
  return select<ImportLog>(
    `SELECT * FROM import_logs WHERE ledger_id = $1 ORDER BY imported_at DESC, id DESC LIMIT $2`,
    [currentLedgerId(), limit]
  );
}