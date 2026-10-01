import dayjs from 'dayjs';
import { select } from './db';
import { currentLedgerId } from '@/lib/ledger';
import { normalizeMerchant, loadUserRules } from './merchantNorm';

/**
 * 商户画像与消费去向（本地商户聚合）
 * ---------------------------------------------------------------
 * 按收款方（payee）聚合消费，得到每个商户的：总支出、笔数、平均单笔、最近消费、常归分类。
 * 这回答"钱主要花在哪些商户/在哪些地方"，是商圈分析的本地化近似（不接真实地图与商户经纬度库）。
 * 聚合逻辑为核心纯函数 aggregateMerchants，便于单测。
 */

export interface MerchantRow {
  payee: string;
  amount: number;
  date: string;
  categoryName: string | null;
}

export interface MerchantProfile {
  name: string;
  total: number;
  count: number;
  avg: number;
  lastDate: string | null;
  category: string | null;
}

/** 按收款方聚合（纯函数）：总支出/笔数/平均/最近/主导分类。 */
export function aggregateMerchants(rows: MerchantRow[]): MerchantProfile[] {
  const byName = new Map<string, { total: number; count: number; lastDate: string | null; catCount: Map<string, number> }>();
  for (const r of rows) {
    const name = String(r.payee ?? '').trim();
    if (!name || !(r.amount > 0)) continue; // 无收款方或金额非法不计
    let acc = byName.get(name);
    if (!acc) { acc = { total: 0, count: 0, lastDate: null, catCount: new Map() }; byName.set(name, acc); }
    acc.total += r.amount;
    acc.count += 1;
    if (!acc.lastDate || r.date > acc.lastDate) acc.lastDate = r.date;
    if (r.categoryName) acc.catCount.set(r.categoryName, (acc.catCount.get(r.categoryName) ?? 0) + 1);
  }
  const out: MerchantProfile[] = [];
  for (const [name, acc] of byName) {
    let category: string | null = null;
    let best = 0;
    for (const [c, n] of acc.catCount) if (n > best) { best = n; category = c; }
    out.push({ name, total: Math.round(acc.total * 100) / 100, count: acc.count, avg: acc.count ? Math.round((acc.total / acc.count) * 100) / 100 : 0, lastDate: acc.lastDate, category });
  }
  return out.sort((a, b) => b.total - a.total);
}

/** 取近 months 个月、有收款方的支出明细（含分类名，用于画像）。 */
export async function fetchMerchantRows(months = 3): Promise<MerchantRow[]> {
  const start = dayjs().subtract(months - 1, 'month').startOf('month').format('YYYY-MM-DD');
  const end = dayjs().endOf('month').format('YYYY-MM-DD');
  return select<MerchantRow>(
    `SELECT COALESCE(t.payee,'') AS payee, t.amount, t.date, c.name AS categoryName
     FROM transactions t LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.type='expense' AND t.payee IS NOT NULL AND t.payee<>'' AND t.date BETWEEN $1 AND $2 AND t.ledger_id = $3
     ORDER BY t.date DESC`,
    [start, end, currentLedgerId()]
  );
}

export interface MerchantReport {
  /** 按金额 TOP */
  bySpend: MerchantProfile[];
  /** 按笔数 TOP */
  byFrequency: MerchantProfile[];
}

/** 商户画像报告：金额 TOP + 高频 TOP。 */
export async function buildMerchantReport(months = 3): Promise<MerchantReport> {
  // 先做商户归一（用户规则 > 内置同义），使"金拱门 / McDonald's / 麦当劳"归并到同一商户
  const rules = loadUserRules();
  const rows = (await fetchMerchantRows(months)).map((r) => ({ ...r, payee: normalizeMerchant(r.payee, { rules }).name }));
  const profiles = aggregateMerchants(rows);
  return {
    bySpend: profiles.slice(0, 8),
    byFrequency: [...profiles].sort((a, b) => b.count - a.count || b.total - a.total).slice(0, 8),
  };
}