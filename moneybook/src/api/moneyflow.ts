import { select } from './db';
import dayjs from 'dayjs';
import { currentLedgerId } from '@/lib/ledger';

/**
 * 资金去向分析（本地路线）
 * ---------------------------------------------------------------
 * 本模块只做「本地」的资金去向汇总：直接读取数据库中的完整原始交易数据，
 * 按用户所选维度聚合出每个维度项的收入/支出/笔数。
 *
 * 重要：这里的维度名（分类名/账户名/标签名）与金额都是**完整的原始数据**，
 * 供本地图表与表格直接渲染，**绝不做任何脱敏**，也不受 AI 安全策略影响。
 * 脱敏只在「把上面的汇总上传云端给 AI 分析」时由 llm.ts 的构建层执行。
 *
 * 实现说明：sql.js 的 getAsObject 对多表多列 JOIN 偶发「column index out of range」，
 * 因此这里尽量使用**单表查询**，分类/账户/标签名在 JS 中通过 Map 关联，保证跨环境稳定。
 */

export type FlowDimension = 'category' | 'account' | 'tag' | 'week' | 'amount' | 'type';

export interface FlowItem {
  label: string;
  income: number;
  expense: number;
  count: number;
}
export interface FlowAnalysis {
  dimension: FlowDimension;
  from: string;
  to: string;
  items: FlowItem[];
  totalIncome: number;
  totalExpense: number;
}

interface RawTx {
  id: number;
  type: string;
  amount: number;
  date: string;
  category_id: number | null;
  account_id: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

function amountBucket(v: number): string {
  if (v <= 50) return '≤50 元';
  if (v <= 100) return '50-100 元';
  if (v <= 500) return '100-500 元';
  if (v <= 1000) return '500-1000 元';
  if (v <= 5000) return '1000-5000 元';
  return '>5000 元';
}

/** 按所选维度，求一笔交易应计入的所有维度名（tag 维度为一笔多标签，其余为单值） */
function labelsFor(
  tx: RawTx,
  dim: FlowDimension,
  catMap: Map<number, string>,
  accMap: Map<number, string>,
  tagOfTx: Map<number, string[]>
): string[] {
  switch (dim) {
    case 'category': return [catMap.get(tx.category_id ?? -1) ?? '未分类'];
    case 'account': return [accMap.get(tx.account_id) ?? '未知账户'];
    case 'tag': {
      const lst = tagOfTx.get(tx.id);
      return lst && lst.length ? lst : ['未打标签'];
    }
    case 'type': return [tx.type === 'income' ? '收入' : '支出'];
    case 'amount': return [amountBucket(tx.amount)];
    case 'week': return [`${dayjs(tx.date).startOf('week').format('YYYY-MM-DD')} 起`];
    default: return ['未分组'];
  }
}

/** 按所选维度汇总资金去向（本地原始数据，不脱敏） */
export async function getMoneyFlowAnalysis(opts: { dimension: FlowDimension; from: string; to: string }): Promise<FlowAnalysis> {
  const lid = currentLedgerId();

  const [txs, cats, accs, relRows, tags] = await Promise.all([
    select<RawTx>(
      `SELECT id, type, amount, date, category_id, account_id
       FROM transactions
       WHERE date BETWEEN $1 AND $2 AND type IN ('income','expense') AND ledger_id = $3`,
      [opts.from, opts.to, lid]
    ),
    select<{ id: number; name: string }>(`SELECT id, name FROM categories`),
    select<{ id: number; name: string }>(`SELECT id, name FROM accounts`),
    select<{ transaction_id: number; tag_id: number }>(`SELECT transaction_id, tag_id FROM transaction_tags`),
    select<{ id: number; name: string }>(`SELECT id, name FROM tags`),
  ]);

  const catMap = new Map(cats.map((c) => [c.id, c.name]));
  const accMap = new Map(accs.map((a) => [a.id, a.name]));
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  const tagOfTx = new Map<number, string[]>();
  for (const r of relRows) {
    const nm = tagName.get(r.tag_id);
    if (!nm) continue;
    const arr = tagOfTx.get(r.transaction_id) ?? [];
    arr.push(nm);
    tagOfTx.set(r.transaction_id, arr);
  }

  const agg = new Map<string, { label: string; income: number; expense: number; count: number }>();
  for (const tx of txs) {
    for (const label of labelsFor(tx, opts.dimension, catMap, accMap, tagOfTx)) {
      const cur = agg.get(label) ?? { label, income: 0, expense: 0, count: 0 };
      cur.count += 1;
      if (tx.type === 'income') cur.income += tx.amount;
      else cur.expense += tx.amount;
      agg.set(label, cur);
    }
  }

  const items: FlowItem[] = [...agg.values()].map((it) => ({
    label: it.label,
    income: round(it.income),
    expense: round(it.expense),
    count: it.count,
  }));
  items.sort((a, b) => b.expense - a.expense || b.income - a.income);

  return {
    dimension: opts.dimension,
    from: opts.from,
    to: opts.to,
    items,
    totalIncome: round(items.reduce((s, it) => s + it.income, 0)),
    totalExpense: round(items.reduce((s, it) => s + it.expense, 0)),
  };
}