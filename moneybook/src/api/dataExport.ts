import { select } from './db';
import { maskSensitive } from '@/lib/sanitize';

/**
 * 一键导出全部数据（JSON 可迁移格式）
 * ---------------------------------------------------------------
 * 把本机所有业务表导出为一个可读的 { version, exportedAt, data } 结构，
 * 满足"用户能一键导出全部数据"的合规底线；配合备份恢复做双保险。
 * 纯读操作用于导出；JSON 便于人工阅读/迁移，SQLite 备份为另一份完整备份。
 */

/** 参与导出的业务表（常量白名单，杜绝注入） */
export const EXPORT_TABLES = [
  'categories', 'accounts', 'transactions', 'loans', 'loan_repayments',
  'savings_goals', 'budgets', 'tags', 'transaction_tags', 'txn_templates',
  'settings', 'ai_audit_log', 'trash',
] as const;

export interface ExportBundle {
  version: number;
  /** 导出时间（ISO） */
  exportedAt: string;
  data: Record<string, unknown[]>;
}

export interface ExportValidation {
  ok: boolean;
  error?: string;
  version?: number;
  exportedAt?: string;
}

/**
 * 导出包 schema/版本校验（纯函数，供任何"JSON 导入/恢复"入口在正式写入前作为闸门）。
 * 校验：object 结构、版本号为数字、exportedAt 为字符串、data 是对象且每个已知表为数组。
 * 防止被篡改/版本不匹配的包注入脏数据。当前该文件只导出不做 JSON 导入，
 * 但此守卫可复用于后续导入路径（导出的孪生风险）。
 */
export function validateExportBundle(raw: unknown): ExportValidation {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '导出包不是对象' };
  const b = raw as Record<string, unknown>;
  if (typeof b.version !== 'number' || b.version < 0) return { ok: false, error: '导出版本号缺失或非法' };
  if (typeof b.exportedAt !== 'string' || !b.exportedAt) return { ok: false, error: '导出时间缺失' };
  if (typeof b.data !== 'object' || b.data === null || Array.isArray(b.data)) return { ok: false, error: 'data 结构非法' };
  const data = b.data as Record<string, unknown>;
  for (const t of EXPORT_TABLES) {
    const rows = data[t];
    if (rows === undefined) continue; // 兼容旧版本缺表
    if (!Array.isArray(rows)) return { ok: false, error: `表 ${t} 数据不是数组（可能被篡改）` };
  }
  return { ok: true, version: b.version as number, exportedAt: b.exportedAt as string };
}

/** 读取全部业务表数据组装为导出包（仅当前账本的表忽略 ledger 过滤，整库导出）。 */
export async function exportAllData(): Promise<ExportBundle> {
  const data: Record<string, unknown[]> = {};
  for (const t of EXPORT_TABLES) {
    try {
      data[t] = await select<Record<string, unknown>>(`SELECT * FROM ${t}`);
    } catch {
      data[t] = [];
    }
  }
  return { version: 1, exportedAt: new Date().toISOString(), data };
}

/** 交易表里可能含采购主体可读 PII 的文本列（备注/收款方/付款方式/订单号/商家订单号） */
const PII_TEXT_COLS = ['note', 'payee', 'pay_method', 'order_no', 'merchant_order_no'] as const;

/**
 * 对导出包做脱敏（纯函数，可单测、复用 maskSensitive）：
 * 默认导出前对交易类的文本列走 maskSensitive（手机/卡号/邮箱/身份证等 PII 打码）。
 * inclSensitive 传 true 时保留原文（供"含敏感字段"二次确认后使用）。
 */
export function maskExportBundle(bundle: ExportBundle, inclSensitive = false): ExportBundle {
  if (inclSensitive) return bundle;
  const txRows = (bundle.data.transactions ?? []) as Record<string, unknown>[];
  const masked = txRows.map((r) => {
    const next = { ...r };
    for (const col of PII_TEXT_COLS) {
      if (typeof next[col] === 'string' && next[col]) next[col] = maskSensitive(next[col] as string);
    }
    return next;
  });
  return { ...bundle, data: { ...bundle.data, transactions: masked } };
}