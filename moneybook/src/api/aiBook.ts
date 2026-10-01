// AI 自然语言记账增强模块
// -----------------------------------------------------------------------------
// 职责：把用户的一句/多句自然语言记账描述解析成「多条结构化记账项」。
// 设计要点：
//  1. 严格 JSON 规范：system 只允许输出结构数组，本地用 zod 逐项校验并过滤非法项；
//  2. 隐私安全：user 内容只含记账文本 + 账户/分类「名称白名单」，
//     绝不发送任何余额、统计、明细原文（白名单仅是名称，不含金额）；
//  3. 模糊匹配：账户/分类按 精确 → 包含 → 去空白/符号归一 三级匹配，
//     匹配失败的项降级为「可编辑占位」，不让用户卡死，确认页可手动修正；
//  4. 多语句批量：按换行/分号/句号切分为多条分别解析，聚合为预览列表。
// -----------------------------------------------------------------------------
import { z } from 'zod';
import dayjs from 'dayjs';
import type { Account } from '@/api/accounts';
import type { Category } from '@/api/categories';

export type BookType = 'income' | 'expense' | 'transfer' | 'lend' | 'borrow';

export interface AiBookItem {
  type: BookType;
  amount: number;
  accountId?: number;
  categoryId?: number;
  toAccountId?: number;
  date: string;
  note: string;
  /** 交易扩展字段（爬升自 OCR/AI 解析） */
  payTime?: string;
  payMethod?: string;
  payee?: string;
  orderNo?: string;
  merchantOrderNo?: string;
  /** 适配状态：ok=已匹配；missing_account/missing_category=未匹配到，需用户确认时修正 */
  unmatched?: ('account' | 'category')[];
}

/** system 提示：严格 JSON 输出规范 + 权限范围约束（只允许使用白名单名称）。 */
export const BOOK_SYSTEM = `你是记账解析器。把用户按自然语言描述的记账内容解析成严格 JSON 数组，只返回 JSON 数组本身，不要任何解释、代码块标记或额外文字。
数组元素结构：
{"type":"income"|"expense"|"transfer"|"lend"|"borrow","amount":数字,"categoryName":"分类名","accountName":"账户名","toAccountName":"转入账户名(仅transfer)","note":"简短备注","date":"YYYY-MM-DD","payTime":"支付时间，如 2026-09-27 19:02:40（无则空字符串）","payMethod":"付款方式，如 微信支付/支付宝/银行卡（无则空字符串）","payee":"收款方全称（无则空字符串）","orderNo":"订单号（无则空字符串）","merchantOrderNo":"商家订单号（无则空字符串）"}
规则：
1. 金额必须为正数；日期信息不足时为空字符串，默认记账日。
2. type、categoryName、accountName 只能从系统给出的「可用名称清单」中选择，绝不能编造清单之外的名称；若描述中未提及账户则 accountName 留空。
3. 转账（transfer）必须给出 toAccountName；多个句子/多笔记账在数组中平铺（一笔一条）。
4. payTime/payMethod/payee/orderNo/merchantOrderNo 若无明确信息一律留空字符串，不要猜、不要编造。
5. 实在无法判断的字段留空字符串，不要猜。`;

/** 解析文本中的 JSON 数组（稳健剥离围栏，任何异常返回空数组）。 */
export function extractBookArray(raw: string): unknown[] {
  try {
    let t = String(raw ?? '').trim();
    t = t.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return [];
    const parsed: unknown = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 单条记账项 schema：严格校验类型与金额；缺失字段允许空/可选
const BookSchema = z.object({
  type: z.enum(['income', 'expense', 'transfer', 'lend', 'borrow']).optional(),
  amount: z.number().positive().finite().optional(),
  categoryName: z.string().optional(),
  accountName: z.string().optional(),
  toAccountName: z.string().optional(),
  note: z.string().optional(),
  date: z.string().optional(),
  payTime: z.string().optional(),
  payMethod: z.string().optional(),
  payee: z.string().optional(),
  orderNo: z.string().optional(),
  merchantOrderNo: z.string().optional(),
});

interface ParsedRow {
  type?: string;
  amount?: number;
  categoryName?: string;
  accountName?: string;
  toAccountName?: string;
  note?: string;
  date?: string;
  payTime?: string;
  payMethod?: string;
  payee?: string;
  orderNo?: string;
  merchantOrderNo?: string;
}

/** 名称归一化：去空白、常见符号、转小写，用于容错匹配 */
function norm(s: string): string {
  return (s ?? '').replace(/[\s\-_（）()【】\[\]/\\:：,，。.]/g, '').toLowerCase();
}

/** 账户模糊匹配：精确 → 包含 → 归一包含；返回匹配项或 undefined */
function matchAccount(name: string, accounts: Account[]): Account | undefined {
  if (!name) return undefined;
  const target = name.trim();
  const exact = accounts.find((a) => a.name === target);
  if (exact) return exact;
  const contains = accounts.find((a) => a.name.includes(target));
  if (contains) return contains;
  return accounts.find((a) => norm(a.name).includes(norm(target)));
}

/** 分类模糊匹配（限定 type 方向）；返回匹配项或 undefined */
function matchCategory(name: string, type: string, cats: Category[]): Category | undefined {
  if (!name) return undefined;
  const target = name.trim();
  const pool = cats.filter((c) => c.type === type);
  for (const fn of [
    (c: Category) => c.name,
    (c: Category) => c.name.includes(target),
    (c: Category) => norm(c.name).includes(norm(target)),
  ]) {
    const hit = pool.find((c) => fn(c) === target);
    if (hit) return hit;
  }
  return undefined;
}

/** 将一条解析行映射为可写入的记账项；匹配失败的标记 unmatched，不抛错 */
export function toBookItem(row: ParsedRow, accounts: Account[], cats: Category[]): AiBookItem | null {
  try {
    const type = (row.type ?? 'expense') as BookType;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const account = matchAccount(row.accountName ?? '', accounts);
    let toAccount: Account | undefined;
    if (type === 'transfer') toAccount = matchAccount(row.toAccountName ?? '', accounts);
    const category = row.categoryName ? matchCategory(row.categoryName, type === 'income' ? 'income' : 'expense', cats) : undefined;
    const unmatched: ('account' | 'category')[] = [];
    if (type !== 'transfer' && !account) unmatched.push('account');
    if (type === 'transfer' && !toAccount) unmatched.push('account');
    if (row.categoryName && !category) unmatched.push('category');
    const date = row.date && dayjs(row.date).isValid() ? dayjs(row.date).format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD');
    return {
      type,
      amount,
      accountId: (type === 'transfer' ? toAccount : account)?.id ?? (account?.id),
      toAccountId: type === 'transfer' ? toAccount?.id : undefined,
      categoryId: category?.id,
      date,
      note: (row.note ?? '').trim() || 'AI 记账',
      payTime: (row.payTime ?? '').trim() || undefined,
      payMethod: (row.payMethod ?? '').trim() || undefined,
      payee: (row.payee ?? '').trim() || undefined,
      orderNo: (row.orderNo ?? '').trim() || undefined,
      merchantOrderNo: (row.merchantOrderNo ?? '').trim() || undefined,
      unmatched,
    };
  } catch {
    return null;
  }
}

/** 解析 AI 输出并映射为记账预览列表（zod 校验 + 过滤非法，绝不抛异常） */
export function parseBookOutput(raw: string, accounts: Account[], cats: Category[]): AiBookItem[] {
  const items: AiBookItem[] = [];
  for (const ent of extractBookArray(raw)) {
    if (!ent || typeof ent !== 'object') continue;
    const parsed = BookSchema.safeParse(ent);
    if (!parsed.success) continue;
    const item = toBookItem(parsed.data as ParsedRow, accounts, cats);
    if (item) items.push(item);
  }
  return items;
}

/** 按换行/分号/句号将一段自然语言切分为多句（便于逐句解析为多条记账） */
export function splitStatements(text: string): string[] {
  return (text ?? '')
    .split(/\n|；|;|。/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}