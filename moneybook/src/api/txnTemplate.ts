import { execute, select } from './db';
import { currentLedgerId } from '@/lib/ledger';
import type { TxPayload } from './transactions';

/**
 * 常用交易模板（智能补全·模板复用）
 * ---------------------------------------------------------------
 * 目标：把高频交易（如每月房租、固定充值、某商户固定消费）存成模板，
 *      记账时一键套用并新建一笔，减少重复录入。
 * 约束：
 * 1. 仅存本机（txn_templates 表），无网络；不用 localStorage。
 * 2. amount 可空 = 每次手填；金额必填校验复核到 payload 层（validateTxPayload 已在 createTransaction 内执行）。
 * 3. 纯函数可测：入参校验、模板→表单回填为纯逻辑。
 */

export const TXN_TEMPLATE_TYPES = ['income', 'expense', 'transfer', 'lend', 'borrow'] as const;
export type TxnTemplateType = (typeof TXN_TEMPLATE_TYPES)[number];

export interface TxnTemplate {
  id: number;
  name: string;
  type: TxnTemplateType;
  /** 可空：null 表示每次手填金额 */
  amount: number | null;
  category_id: number | null;
  account_id: number | null;
  to_account_id: number | null;
  note: string;
  payee: string;
  pay_method: string;
  /** 标签 id 数组（从 tag_ids JSON 解析） */
  tag_ids: number[];
  ledger_id: number;
  created_at: string;
}

export interface TxnTemplatePayload {
  name: string;
  type: TxnTemplateType;
  amount?: number | null;
  categoryId?: number | null;
  accountId?: number | null;
  toAccountId?: number | null;
  note?: string;
  payee?: string;
  payMethod?: string;
  tagIds?: number[];
}

const TPL_TYPES: readonly string[] = TXN_TEMPLATE_TYPES;

/** 校验模板入参（纯函数）：名称非空、类型合法；其余字段宽松（可空）。返回错误信息，合法返回 null。 */
export function validateTemplatePayload(p: TxnTemplatePayload): string | null {
  if (!p || typeof p !== 'object') return '模板参数无效';
  if (!String(p.name ?? '').trim()) return '模板名称不能为空';
  if (!TPL_TYPES.includes(p.type)) return '模板类型不合法';
  if (p.amount != null && (!Number.isFinite(p.amount) || p.amount <= 0)) return '模板金额必须为大于 0 的有效数字或留空手填';
  return null;
}

/** 把数据库行反序列化为 TxnTemplate（解析 tag_ids JSON，容错为空数组）。 */
export function parseTemplateRow(row: Record<string, unknown>): TxnTemplate {
  const type = (String(row.type) as TxnTemplateType);
  let tagIds: number[] = [];
  try {
    const parsed = JSON.parse(String(row.tag_ids ?? '[]'));
    if (Array.isArray(parsed)) tagIds = parsed.filter((x) => Number.isInteger(Number(x))).map((x) => Number(x));
  } catch {
    tagIds = [];
  }
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    type: TPL_TYPES.includes(type) ? type : (null as unknown as TxnTemplateType),
    amount: row.amount == null ? null : Number(row.amount),
    category_id: row.category_id == null ? null : Number(row.category_id),
    account_id: row.account_id == null ? null : Number(row.account_id),
    to_account_id: row.to_account_id == null ? null : Number(row.to_account_id),
    note: String(row.note ?? ''),
    payee: String(row.payee ?? ''),
    pay_method: String(row.pay_method ?? ''),
    tag_ids: tagIds,
    ledger_id: Number(row.ledger_id ?? 1),
    created_at: String(row.created_at ?? ''),
  };
}

/** 当前账本的全部模板（按创建先后排序）。 */
export async function listTemplates(): Promise<TxnTemplate[]> {
  const rows = await select<Record<string, unknown>>(
    `SELECT * FROM txn_templates WHERE ledger_id = $1 ORDER BY id DESC`,
    [currentLedgerId()]
  );
  return rows.map(parseTemplateRow);
}

/** 新建模板并返回 id（名称必填、类型合法，其余可空由 getCreatePayload 回填时兜底）。 */
export async function createTemplate(p: TxnTemplatePayload): Promise<number> {
  const err = validateTemplatePayload(p);
  if (err) throw new Error(err);
  const rs = await execute(
    `INSERT INTO txn_templates
       (name, type, amount, category_id, account_id, to_account_id, note, payee, pay_method, tag_ids, ledger_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      String(p.name).trim(), p.type,
      p.amount ?? null, p.categoryId ?? null, p.accountId ?? null, p.toAccountId ?? null,
      p.note ?? '', p.payee ?? '', p.payMethod ?? '',
      JSON.stringify(p.tagIds ?? []), currentLedgerId(),
    ]
  );
  return rs.lastInsertId as number;
}

/** 删除模板（模板为纯复用快照，无需回收站；直接删除不产生数据丢失）。 */
export async function deleteTemplate(id: number): Promise<void> {
  await execute(`DELETE FROM txn_templates WHERE id = $1 AND ledger_id = $2`, [id, currentLedgerId()]);
}

/**
 * 模板 → 可写表单回填（纯函数，便于测试）。
 * 把模板字段映射为表单可 setValue 的中性结构（不含 id/ledger_id 等内部字段）。
 * amount 为空时保持 null，由 UI 提示用户手填（金额必填校验在 createTransaction.validateTxPayload 兜底）。
 */
export function templateToForm(t: TxnTemplate): {
  type: TxnTemplateType;
  amount: number | null;
  categoryId?: number;
  accountId?: number;
  toAccountId?: number;
  note: string;
  payee: string;
  payMethod: string;
  tagIds: number[];
} {
  return {
    type: t.type,
    amount: t.amount,
    categoryId: t.category_id ?? undefined,
    accountId: t.account_id ?? undefined,
    toAccountId: t.to_account_id ?? undefined,
    note: t.note,
    payee: t.payee,
    payMethod: t.pay_method,
    tagIds: t.tag_ids,
  };
}

/**
 * 模板 → 交易 payload（纯函数，便于测试与「已填模板直接建模」入口复用）。
 * 需要 amount（必填）与 accountId（转账款必填 toAccountId）。日期用 resolveBookDate 语义：
 * 传入 today（YYYY-MM-DD）作为记账归属日。
 * @returns 可供 createTransaction 直接写入的 payload
 */
export function applyTemplateToTx(
  t: TxnTemplate,
  opts: { amount: number; today?: string }
): TxPayload {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  return {
    type: t.type,
    amount: opts.amount,
    categoryId: t.category_id ?? undefined,
    accountId: t.account_id as number,
    toAccountId: t.to_account_id ?? undefined,
    date: today,
    note: t.note,
    payee: t.payee || undefined,
    payMethod: t.pay_method || undefined,
    tagIds: t.tag_ids,
  };
}