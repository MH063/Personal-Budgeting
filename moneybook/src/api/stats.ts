import { select } from './db';
import dayjs from 'dayjs';
import { currentLedgerId } from '@/lib/ledger';
import { getLedgerInvestmentMarketValue } from './holdings';
import {
  detectSpendingAnomalies, detectTransactionAnomalies, forecastMonthlyExpenses,
  type SpendingAnomaly, type TxAnomaly, type ExpenseForecast,
} from '@/lib/analytics';

export interface PeriodStat { ym: string; income: number; expense: number; surplus: number; }

/** 本月、上月、去年同期 三组收支对比（用于同比/环比） */
export async function getPeriodComparison(baseYm: string): Promise<PeriodStat[]> {
  const base = dayjs(`${baseYm}-01`);
  const targets = [base, base.subtract(1, 'month'), base.subtract(1, 'year')];
  const out: PeriodStat[] = [];
  for (const t of targets) {
    const from = t.startOf('month').format('YYYY-MM-DD');
    const to = t.endOf('month').format('YYYY-MM-DD');
    const [row] = await select<{ income: number; expense: number; surplus: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
         COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expense,
         COALESCE(SUM(CASE WHEN type='income' THEN amount
                            WHEN type='expense' THEN -amount ELSE 0 END),0) AS surplus
       FROM transactions WHERE date BETWEEN $1 AND $2 AND ledger_id = $3`,
      [from, to, currentLedgerId()]
    );
    out.push({ ym: t.format('YYYY-MM'), income: row?.income ?? 0, expense: row?.expense ?? 0, surplus: row?.surplus ?? 0 });
  }
  return out;
}

/** 月度收支与盈余 */
export async function getMonthlySurplus(start: string, end: string) {
  return select<{ month: string; income: number; expense: number; surplus: number }>(
    `SELECT
       strftime('%Y-%m', date) AS month,
       COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
       COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expense,
       COALESCE(SUM(CASE WHEN type='income' THEN amount
                          WHEN type='expense' THEN -amount ELSE 0 END),0) AS surplus
     FROM transactions
     WHERE date BETWEEN $1 AND $2 AND ledger_id = $3
     GROUP BY month
     ORDER BY month`,
    [start, end, currentLedgerId()]
  );
}

/** 净资产（总资产 - 总负债）
 *  口径说明：账户余额统一为「资产方向」符号——资产类账户余额为正表示有资金，
 *  credit/payable 等负债类账户余额为负表示欠款（花呗/信用卡消费 → 余额递减，负得越多欠得越多），
 *  转正后的负债额 = −SUM(余额)。此前直接 SUM 会把负数欠款当作「负负债」从净资产中减去，
 *  等效于把欠款加回净资产（虚增 2×|欠款|）。修正后与「Σ全部账户余额 + 持仓市值」口径严格一致。 */
export async function getNetWorth() {
  const [assets] = await select<{ total: number }>(
    `SELECT COALESCE(SUM(balance),0) AS total FROM accounts
     WHERE type IN ('cash','bank','ewallet','investment','savings','receivable') AND ledger_id = $1`,
    [currentLedgerId()]
  );
  const [liab] = await select<{ total: number }>(
    `SELECT COALESCE(SUM(balance),0) AS total FROM accounts
     WHERE type IN ('credit','payable') AND ledger_id = $1`,
    [currentLedgerId()]
  );
  const totalAssets = (assets?.total ?? 0) + await getLedgerInvestmentMarketValue();
  const totalLiab = -(liab?.total ?? 0); // 欠款为负 → 转正；溢缴为正 → 转负（相当于资产）
  return { totalAssets, totalLiab, netWorth: totalAssets - totalLiab };
}

/** 净资产趋势
 *  当前净资产 = 总资产 - 总负债（实时查 accounts 表，含初始余额与应收/应付虚拟账户）
 *  历史趋势 = 资产/负债初始余额基线 + 每月累计的 "收入 - 支出"
 *    - 借出/借入/还款（lend/borrow/repay）与转账对净资产都是中性的：
 *      借出：真实账户 -金额，但应收款 +金额，相互抵消，净值为 0；
 *      借入：真实账户 +金额，但应付款 +金额（负债），仍然抵消。
 *      因此趋势只累计收入与支出，最后一个月累计值 + 初始基线 = 当前净资产。
 */
export async function getNetWorthTrend() {
  const { netWorth: currentNet } = await getNetWorth();
  // 净资产起始基线 = 资产类账户初始余额之和 - 负债类账户初始余额之和
  const [base] = await select<{ base: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN type IN ('cash','bank','ewallet','investment','savings','receivable')
                         THEN initial_balance ELSE 0 END),0)
       - COALESCE(SUM(CASE WHEN type IN ('credit','payable')
                           THEN initial_balance ELSE 0 END),0) AS base
     FROM accounts WHERE ledger_id = $1`,
    [currentLedgerId()]
  );
  const initial = base?.base ?? 0;
  const rows = await select<{ month: string; net_change: number }>(
    `WITH monthly AS (
       SELECT strftime('%Y-%m', date) AS month,
         SUM(CASE WHEN type='income' THEN amount
                  WHEN type='expense' THEN -amount
                  ELSE 0 END) AS s
       FROM transactions
       WHERE ledger_id = $1
       GROUP BY month
     )
     SELECT month,
       ROUND(SUM(s) OVER (ORDER BY month), 2) AS net_change
     FROM monthly
     ORDER BY month`,
    [currentLedgerId()]
  );
  const history = rows.map((r) => ({
    month: r.month,
    net_worth: Math.round((initial + r.net_change) * 100) / 100,
  }));
  return { currentNet, history };
}

/** 分类占比 */
export async function getCategoryDistribution(type: 'income' | 'expense', start: string, end: string) {
  return select<{ name: string; icon: string; color: string; total: number }>(
    `SELECT c.name, c.icon, c.color, SUM(t.amount) AS total
     FROM transactions t
     JOIN categories c ON t.category_id = c.id
     WHERE t.type = $1 AND t.date BETWEEN $2 AND $3 AND t.ledger_id = $4
     GROUP BY c.id
     ORDER BY total DESC`,
    [type, start, end, currentLedgerId()]
  );
}

/** 账户类型汇总（投资类型含持仓市值：现金 + 市值）。
 *  口径与 getNetWorth 一致：包含停用账户（停用仅归档，资金仍在账上）。 */
export async function getAccountsOverview() {
  const rows = await select<{ type: string; total: number }>(
    `SELECT type, COALESCE(SUM(balance),0) AS total FROM accounts WHERE ledger_id = $1 GROUP BY type`,
    [currentLedgerId()]
  );
  const mv = await getLedgerInvestmentMarketValue();
  if (mv) {
    const inv = rows.find((r) => r.type === 'investment');
    if (inv) inv.total += mv;
    else rows.push({ type: 'investment', total: mv });
  }
  return rows;
}

/** 储蓄率 */
export async function getSavingsRate(start: string, end: string) {
  const [row] = await select<{ income: number; expense: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
       COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expense
     FROM transactions
     WHERE date BETWEEN $1 AND $2 AND ledger_id = $3`,
    [start, end, currentLedgerId()]
  );
  const income = row?.income ?? 0;
  const expense = row?.expense ?? 0;
  const surplus = income - expense;
  const rate = income > 0 ? surplus / income : 0;
  return { income, expense, surplus, rate };
}

/** 预算对比实际支出 */
export async function getBudgetVsActual(yearMonth: string) {
  // yearMonth 格式 'YYYY-MM'；用 dayjs 计算自然月末，避免硬编码某月 31 号的脆弱约定
  const start = dayjs(`${yearMonth}-01`).format('YYYY-MM-DD');
  const end = dayjs(start).endOf('month').format('YYYY-MM-DD');
  return select<{
    id: number;
    category_id: number | null;
    category_name: string | null;
    category_icon: string | null;
    budget_amount: number;
    actual: number;
  }>(
    `SELECT b.id, b.category_id,
       c.name AS category_name, c.icon AS category_icon,
       b.amount AS budget_amount,
       COALESCE((
         SELECT SUM(t.amount) FROM transactions t
         WHERE t.type = 'expense' AND t.date BETWEEN $1 AND $2
           AND t.ledger_id = $3
           AND (b.category_id IS NULL OR t.category_id = b.category_id)
       ), 0) AS actual
     FROM budgets b
     LEFT JOIN categories c ON b.category_id = c.id
     WHERE b.ledger_id = $3
     ORDER BY b.id DESC`,
    [start, end, currentLedgerId()]
  );
}

// ---------------- 资金流向（Sankey） ----------------

export interface SankeyNode { name: string; }
export interface SankeyLink { source: string; target: string; value: number; color?: string; }
export interface CashFlow { nodes: SankeyNode[]; links: SankeyLink[]; }

// 节点/链路配色：收入绿、转账蓝、支出红
const FLOW_COLOR = {
  incomeIn: '#10B981',
  transfer: '#3B82F6',
  expenseOut: '#EF4444',
  account: '#94A3B8',
};

function addFlow(map: Map<string, number>, from: string, to: string, v: number) {
  const k = `${from}||${to}`;
  map.set(k, (map.get(k) ?? 0) + v);
}

/**
 * 资金流向：收入(分类)→账户→【转账→账户】→支出(分类)（Sankey 全链路）。
 * 返回去重后的节点列表与按起点|终点聚合后的链接。
 */
export async function getCashFlow(start: string, end: string): Promise<CashFlow> {
  const rows = await select<{
    type: string; amount: number; category_id: number | null;
    account: string | null; to_account: string | null; category: string | null;
  }>(
    `SELECT t.type, t.amount, t.category_id,
            a.name AS account, ta.name AS to_account, c.name AS category
     FROM transactions t
     JOIN accounts a ON t.account_id = a.id
     LEFT JOIN accounts ta ON t.to_account_id = ta.id
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.date BETWEEN $1 AND $2 AND t.ledger_id = $3`,
    [start, end, currentLedgerId()]
  );

  const flow = new Map<string, number>();
  const links: SankeyLink[] = [];
  const nodeColors = new Map<string, string>();

  const ensureNode = (name: string, color: string) => { if (!nodeColors.has(name)) nodeColors.set(name, color); };

  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    if (amt <= 0 || !r.account) continue;
    ensureNode(String(r.account), FLOW_COLOR.account);

    if (r.type === 'income') {
      const cat = `收入 · ${r.category ?? '未分类'}`;
      ensureNode(cat, FLOW_COLOR.incomeIn);
      addFlow(flow, cat, String(r.account), amt);
    } else if (r.type === 'expense') {
      const cat = `支出 · ${r.category ?? '未分类'}`;
      ensureNode(cat, FLOW_COLOR.expenseOut);
      addFlow(flow, String(r.account), cat, amt);
    } else if (r.type === 'transfer' && r.to_account) {
      ensureNode(String(r.to_account), FLOW_COLOR.account);
      addFlow(flow, String(r.account), String(r.to_account), amt);
    }
    // lend/borrow/repay 均涉及账户余额变动但不属于"收支/转账"流向，Sankey 里忽略以避免产生中性冗余流
  }

  for (const [k, v] of flow) {
    const [source, target] = k.split('||');
    const color = source.startsWith('收入') ? FLOW_COLOR.incomeIn
      : target.startsWith('支出') ? FLOW_COLOR.expenseOut
      : FLOW_COLOR.transfer;
    links.push({ source, target, value: Math.round(v * 100) / 100, color });
  }

  return {
    nodes: [...nodeColors.keys()].map((name) => ({ name })),
    links,
  };
}

export type BudgetPeriod = 'monthly' | 'quarterly' | 'yearly';

// ---------------- 智能洞察 / 建议（规则引擎，不依赖 AI） ----------------

export interface InsightRule {
  type: 'increase' | 'budget' | 'health';
  severity: 'info' | 'warning' | 'danger';
  title: string;
  detail: string;
}

export interface InsightsResult {
  anchor: string;
  income: number;
  expense: number;
  surplus: number;
  savingsRate: number;
  score: number;
  scoreLabel: string;
  rules: InsightRule[];
}

interface CatRow { name: string; icon: string; color: string; total: number; }

async function catExpense(lid: number, start: string, end: string): Promise<CatRow[]> {
  return select<CatRow>(
    `SELECT c.name, c.icon, c.color, SUM(t.amount) AS total
     FROM transactions t
     JOIN categories c ON t.category_id = c.id
     WHERE t.type='expense' AND t.date BETWEEN $1 AND $2 AND t.ledger_id = $3
     GROUP BY c.id`,
    [start, end, lid]
  );
}

/** 生成某锚定月的智能洞察：分类突增检测 + 预算达标 + 支出健康度评分 */
export async function getInsights(anchorYm: string = dayjs().format('YYYY-MM')): Promise<InsightsResult> {
  const lid = currentLedgerId();
  const curStart = dayjs(`${anchorYm}-01`).format('YYYY-MM-DD');
  const curEnd = dayjs(curStart).endOf('month').format('YYYY-MM-DD');
  const prevYM = dayjs(curStart).subtract(1, 'month').format('YYYY-MM');
  const prevStart = dayjs(`${prevYM}-01`).format('YYYY-MM-DD');
  const prevEnd = dayjs(prevStart).endOf('month').format('YYYY-MM-DD');

  const rules: InsightRule[] = [];

  const [cur] = await select<{ income: number; expense: number }>(
    `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
            COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expense
     FROM transactions WHERE date BETWEEN $1 AND $2 AND ledger_id = $3`,
    [curStart, curEnd, lid]
  );
  const income = cur?.income ?? 0;
  const expense = cur?.expense ?? 0;
  const surplus = income - expense;
  const savingsRate = income > 0 ? surplus / income : 0;

  // 1) 分类环比突增检测
  const curCats = await catExpense(lid, curStart, curEnd);
  const prevCats = await catExpense(lid, prevStart, prevEnd);
  const prevMap = new Map<string, number>(prevCats.map((c) => [c.name, c.total]));
  let spikeBadges = 0;
  for (const c of curCats) {
    const prev = prevMap.get(c.name) ?? 0;
    const rise = prev > 0 ? (c.total - prev) / prev : 0;
    const delta = c.total - prev;
    if ((prev > 0 && rise >= 0.3 && delta >= 50) || (prev === 0 && c.total >= 100)) {
      const pct = prev > 0 ? Math.round(rise * 100) : 100;
      rules.push({
        type: 'increase',
        severity: delta >= 200 ? 'danger' : 'warning',
        title: `${c.icon} ${c.name} 环比增长 ${pct}%`,
        detail: prev > 0
          ? `本月 ${c.name} 支出 ¥${c.total.toFixed(2)}，较上月 ¥${prev.toFixed(2)} 增加 ¥${delta.toFixed(2)}。留意是否可控、可否削减。`
          : `本月新增 ${c.name} 支出 ¥${c.total.toFixed(2)}（上月为 0）。可复核是否为大额或一次性开销，并为它单独设预算。`,
      });
      spikeBadges += 1;
    }
  }

  // 2) 预算达标检测（含周期结转）
  const budgetArr = await getBudgetVsActualAdvanced({ period: 'monthly', anchor: anchorYm, ledgerId: lid });
  let overBadges = 0;
  for (const b of budgetArr) {
    const ratio = b.usable > 0 ? b.actual / b.usable : (b.actual > 0 ? 1 : 0);
    const name = `${b.category_icon ?? ''} ${b.category_name ?? '总预算'}`.trim();
    if (ratio > 1) {
      overBadges += 1;
      rules.push({
        type: 'budget',
        severity: 'danger',
        title: `${name} 超出本月预算`,
        detail: `预算 ¥${b.usable.toFixed(2)}，实际 ¥${b.actual.toFixed(2)}，超支 ¥${(b.actual - b.usable).toFixed(2)}${b.rolled_in > 0 ? `，滚入 ¥${b.rolled_in.toFixed(2)} 已全部用完` : ''}。建议压缩该预算或上调额度。`,
      });
    } else if (ratio >= 0.8) {
      rules.push({
        type: 'budget',
        severity: 'info',
        title: `${name} 预算已用 ${Math.round(ratio * 100)}%`,
        detail: `预算 ¥${b.usable.toFixed(2)}，已用 ¥${b.actual.toFixed(2)}，剩余 ¥${(b.usable - b.actual).toFixed(2)}。请留意接近上限。`,
      });
    }
  }

  // 3) 综合健康度评分
  let sScore = 0;
  if (savingsRate >= 0.3) sScore = 40;
  else if (savingsRate >= 0.2) sScore = 32;
  else if (savingsRate >= 0.1) sScore = 24;
  else if (savingsRate >= 0) sScore = 14;
  else sScore = 0;

  let bScore: number;
  if (budgetArr.length === 0) bScore = 22; // 无预算则不惩罚
  else if (overBadges === 0) bScore = 30;
  else if (overBadges === 1) bScore = 20;
  else bScore = Math.max(8, 30 - overBadges * 10);

  const stScore = Math.max(0, 30 - spikeBadges * 10);
  const score = Math.round(sScore + bScore + stScore);

  const scoreLabel = score >= 80 ? '优秀' : score >= 60 ? '良好' : score >= 40 ? '需关注' : '风险';

  if (budgetArr.length === 0) {
    rules.push({
      type: 'health', severity: 'info',
      title: '尚未设置预算',
      detail: '为支出较大的分类设置月度预算，可以更好地预控超支。',
    });
  }
  if (spikeBadges === 0 && overBadges === 0 && income > 0) {
    rules.push({
      type: 'health', severity: 'info',
      title: '本月支出平稳',
      detail: `没有检测到明显突增或超预算，储蓄率 ${ (savingsRate * 100).toFixed(0) }%。继续保持。`,
    });
  }
  if (savingsRate < 0 && income > 0) {
    rules.push({
      type: 'health', severity: 'danger',
      title: '本月入不敷出',
      detail: `支出 ¥${expense.toFixed(2)} 超过收入 ¥${income.toFixed(2)}，结余 ¥${surplus.toFixed(2)}。建议优先削减弹性开支并盘点可选订阅。`,
    });
  }

  return { anchor: anchorYm, income, expense, surplus, savingsRate, score, scoreLabel, rules };
}

export interface BudgetVsActualAdvancedRow {
  id: number;
  category_id: number | null;
  category_name: string | null;
  category_icon: string | null;
  period: BudgetPeriod;
  /** 本期原始额度 */
  period_amount: number;
  /** 上期结转滚入余额 */
  rolled_in: number;
  /** 窗口内实际支出 */
  actual: number;
  /** 本期可用预算 = 原始额度 + 滚入 */
  usable: number;
  /** 滚入的来源：紧邻本期的上一周期结余；无滚入来源时为 null */
  rollover_source: { prev_period: string; prev_surplus: number } | null;
  status: 'ok' | 'over';
}

/** 月份字符串整体偏移若干个月（'YYYY-MM'） */
function shiftMonth(ym: string, delta: number): string {
  return dayjs(`${ym}-01`).add(delta, 'month').format('YYYY-MM');
}

function prevAnchor(period: BudgetPeriod, ym: string): string {
  return period === 'monthly' ? shiftMonth(ym, -1)
    : period === 'quarterly' ? shiftMonth(ym, -3)
    : shiftMonth(ym, -12);
}

function nextAnchor(period: BudgetPeriod, ym: string): string {
  return period === 'monthly' ? shiftMonth(ym, 1)
    : period === 'quarterly' ? shiftMonth(ym, 3)
    : shiftMonth(ym, 12);
}

/** 含 ym 所在周期的窗口 [start,end]（'YYYY-MM-DD'） */
function periodRange(period: BudgetPeriod, ym: string): { start: string; end: string } {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  if (period === 'monthly') {
    const start = dayjs(`${ym}-01`).format('YYYY-MM-DD');
    const end = dayjs(start).endOf('month').format('YYYY-MM-DD');
    return { start, end };
  }
  if (period === 'quarterly') {
    const qm = Math.floor((m - 1) / 3) * 3 + 1;
    const start = dayjs(`${y}-${String(qm).padStart(2, '0')}-01`).format('YYYY-MM-DD');
    const end = dayjs(start).add(3, 'month').subtract(1, 'day').format('YYYY-MM-DD');
    return { start, end };
  }
  const start = dayjs(`${y}-01-01`).format('YYYY-MM-DD');
  const end = dayjs(`${y}-12-31`).format('YYYY-MM-DD');
  return { start, end };
}

/** 某周期内跨月份的支出合计 */
function sumExpenseIn(
  monthMap: Map<string, Map<number, number>>,
  from: string,
  to: string,
  categoryId: number | null
): number {
  let total = 0;
  let ym = dayjs(from).format('YYYY-MM');
  const endYm = dayjs(to).format('YYYY-MM');
  while (ym <= endYm) {
    const m = monthMap.get(ym);
    if (m) {
      if (categoryId == null) {
        for (const v of m.values()) total += v;
      } else {
        total += m.get(categoryId) ?? 0;
      }
    }
    ym = shiftMonth(ym, 1);
  }
  return total;
}

/**
 * 预算 周期（月/季/年）滚动结转 对比实际支出。
 * anchor 形如 'YYYY-MM'，代表查询窗口所在年月。
 * - 窗口：monthly=当月；quarterly=当季 3 个月；yearly=当年 12 个月。
 * - 上期滚入 = max(上期可用 − 上期实际, 0)，从该预算 start_date 所在周期起逐期累积结转。
 * - 可用 = 原始额度 + 滚入；实际 > 可用 时 status='over'，否则 'ok'。
 */
export async function getBudgetVsActualAdvanced(params: {
  period: BudgetPeriod;
  anchor: string;
  ledgerId?: number;
}): Promise<BudgetVsActualAdvancedRow[]> {
  const { period, anchor } = params;
  const lid = params.ledgerId ?? currentLedgerId();
  const win = periodRange(period, anchor);

  const budgets = await select<{
    id: number;
    category_id: number | null;
    category_name: string | null;
    category_icon: string | null;
    amount: number;
    start_date: string;
  }>(
    `SELECT b.id, b.category_id, c.name AS category_name, c.icon AS category_icon,
            b.amount, b.start_date
     FROM budgets b
     LEFT JOIN categories c ON b.category_id = c.id
     WHERE b.ledger_id = $1 AND b.period = $2
       AND b.start_date <= $3 AND (b.end_date IS NULL OR b.end_date >= $4)
     ORDER BY b.id DESC`,
    [lid, period, win.end, win.start]
  );
  if (budgets.length === 0) return [];

  // 结转回溯的最早月份 = 这些预算中最早 start_date 所在周期的起点
  const earliestStart = budgets
    .map((b) => b.start_date)
    .sort()[0];
  const carryFetchStart = periodRange(period, dayjs(earliestStart).format('YYYY-MM')).start;

  // 按 月份+分类 聚合实际支出（覆盖结转回溯范围到窗口末）
  const expRows = await select<{ ym: string; cid: number | null; exp: number }>(
    `SELECT strftime('%Y-%m', t.date) AS ym, t.category_id AS cid, SUM(t.amount) AS exp
     FROM transactions t
     WHERE t.type = 'expense' AND t.ledger_id = $1 AND t.date >= $2 AND t.date <= $3
     GROUP BY ym, t.category_id`,
    [lid, carryFetchStart, win.end]
  );
  const monthMap = new Map<string, Map<number, number>>();
  for (const r of expRows) {
    if (!r.ym) continue;
    let m = monthMap.get(r.ym);
    if (!m) { m = new Map(); monthMap.set(r.ym, m); }
    const cid = r.cid ?? 0;
    m.set(cid, (m.get(cid) ?? 0) + r.exp);
  }

  // 逐期累积结转：返回本期应滚入的余额及其来源（上一周期结余）
  const rolledInFor = (budget: {
    amount: number;
    start_date: string;
    category_id: number | null;
  }): { rolled_in: number; prev_surplus: number; hasPrev: boolean } => {
    let carried = 0;
    const startYM = dayjs(budget.start_date).format('YYYY-MM');
    const prevYM = prevAnchor(period, anchor);
    let ym = startYM;
    let hasPrev = false;
    while (ym <= prevYM) {
      hasPrev = true;
      const r = periodRange(period, ym);
      const actual = sumExpenseIn(monthMap, r.start, r.end, budget.category_id ?? null);
      const usable = budget.amount + carried;
      carried = Math.max(usable - actual, 0);
      ym = nextAnchor(period, ym);
    }
    return { rolled_in: carried, prev_surplus: carried, hasPrev };
  };

  const rows: BudgetVsActualAdvancedRow[] = [];
  for (const b of budgets) {
    const period_amount = b.amount;
    const { rolled_in, prev_surplus, hasPrev } = rolledInFor(b);
    const usable = period_amount + rolled_in;
    const actual = sumExpenseIn(monthMap, win.start, win.end, b.category_id ?? null);
    rows.push({
      id: b.id,
      category_id: b.category_id,
      category_name: b.category_name,
      category_icon: b.category_icon,
      period,
      period_amount,
      rolled_in,
      actual,
      usable,
      rollover_source: hasPrev && prev_surplus > 0
        ? { prev_period: prevAnchor(period, anchor), prev_surplus }
        : null,
      status: actual > usable ? 'over' : 'ok',
    });
  }
  return rows;
}

export interface AdvancedAnalysisResult {
  anomalies: SpendingAnomaly[];
  txAnomalies: TxAnomaly[];
  forecast: ExpenseForecast;
}

/**
 * 更深智能分析（ex5）：聚合近 6 个月支出做三层诊断。
 *  - anomalies：月度支出序列的异常突增
 *  - txAnomalies：单笔交易按分类显著离群的点
 *  - forecast：最小二乘回归外推下月支出与趋势方向
 * 数据在本地聚合，纯函数部分在 src/lib/analytics.ts（可单测）。
 */
export async function getAdvancedAnalysis(
  anchorYm: string = dayjs().format('YYYY-MM')
): Promise<AdvancedAnalysisResult> {
  const lid = currentLedgerId();
  const start = dayjs(`${anchorYm}-01`).subtract(5, 'month').startOf('month').format('YYYY-MM-DD');
  const curEnd = dayjs(`${anchorYm}-01`).endOf('month').format('YYYY-MM-DD');

  // 近 6 月月度支出序列（含锚定月；无记录的月份自然缺失，底部只取最近 6 档）
  const monthRows = await select<{ ym: string; total: number }>(
    `SELECT strftime('%Y-%m', date) AS ym, COALESCE(SUM(amount),0) AS total
     FROM transactions
     WHERE type='expense' AND date BETWEEN $1 AND $2 AND ledger_id=$3
     GROUP BY strftime('%Y-%m', date) ORDER BY ym`,
    [start, curEnd, lid]
  );
  const months = monthRows.slice(-6);
  const series = months.map((m) => Number(m.total) || 0);
  const labels = months.map((m) => m.ym);

  // 同期支出明细（供按分类的单笔离群检测）
  const txs = await select<{ category_id: number | null; category_name: string | null; amount: number }>(
    `SELECT t.category_id, c.name AS category_name, t.amount
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.type='expense' AND t.date BETWEEN $1 AND $2 AND t.ledger_id=$3`,
    [start, curEnd, lid]
  );

  return {
    anomalies: detectSpendingAnomalies(series, labels),
    txAnomalies: detectTransactionAnomalies(
      txs.map((t) => ({ categoryId: t.category_id, categoryName: t.category_name, amount: Number(t.amount) || 0 }))
    ),
    forecast: forecastMonthlyExpenses(series),
  };
}