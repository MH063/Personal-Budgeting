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
 * settings 表中含敏感配置的键（默认导出时剔除）：
 *  - `kv.ai`：AI 提供商配置 JSON，内含加密的 API Key（apiKeyEnc，AES-GCM + 设备指纹派生密钥）。
 *    虽为密文，但属隐私配置，默认导出不应携带（恢复后需重新填写密钥）。
 * 其余 settings 键（导入规则、主题、备份提醒等）非敏感，默认导出保留。
 */
const SENSITIVE_SETTING_KEYS: readonly string[] = ['kv.ai'];

/**
 * 对导出包做脱敏与敏感表过滤（纯函数，可单测、复用 maskSensitive）。
 *
 * 与「含敏感」导出保持对称：inclSensitive=false（默认导出）时——
 *  - 交易文本列（备注/收款方/付款方式/订单号/商家订单号）走 maskSensitive 打码 PII；
 *  - settings 剔除 SENSITIVE_SETTING_KEYS（含 API Key 的配置项）；
 *  - ai_audit_log（AI 操作日志，含请求/描述文本）整表剔除，不外泄；
 * inclSensitive=true 时返回原文引用，供用户二次确认后的完整备份/迁移使用。
 */
export function maskExportBundle(bundle: ExportBundle, inclSensitive = false): ExportBundle {
  if (inclSensitive) return bundle;
  const data: Record<string, unknown[]> = { ...bundle.data };
  // 1) 交易 PII 文本列脱敏
  const txRows = (data.transactions ?? []) as Record<string, unknown>[];
  data.transactions = txRows.map((r) => {
    const next = { ...r };
    for (const col of PII_TEXT_COLS) {
      if (typeof next[col] === 'string' && next[col]) next[col] = maskSensitive(next[col] as string);
    }
    return next;
  });
  // 2) settings 剔除含 API Key 的敏感配置项（保留导入规则、主题等非敏感项）
  const settingRows = (data.settings ?? []) as Record<string, unknown>[];
  if (settingRows.length) {
    data.settings = settingRows.filter((r) => !SENSITIVE_SETTING_KEYS.includes(String(r.key)));
  }
  // 3) AI 操作日志（含请求文本）整表剔除，避免经导出外泄
  data.ai_audit_log = [];
  return { ...bundle, data };
}