import { select } from './db';
import dayjs from 'dayjs';
import { currentLedgerId } from '@/lib/ledger';
import { getLedgerInvestmentMarketValue } from './holdings';
import { getInsurancePolicies } from './insurance';
import { applyRolloverPolicy } from '@/lib/budgetRolloverPolicy';
import { getRolloverPolicy } from './budgetPolicy';
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
  // 滚动策略：默认「开启且不设上限」，与历史行为一致；用户可在"规划"页调整
  const policy = getRolloverPolicy();

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
      // 按滚动策略决定本期的结余能否（以及能滚多少）滚入下期
      carried = applyRolloverPolicy(Math.max(usable - actual, 0), budget.amount, policy);
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

// ---------------- 财务体检（家庭财务四张表：收入结构 / 负债结构 / 现金流量 / 人力资本） ----------------

/** 劳动收入分类关键词：命中即视为主动劳动所得（工资/奖金/兼职/劳务/薪） */
const LABOR_INCOME_KEYWORDS = ['工资', '奖金', '兼职', '劳务', '薪'];

export interface CheckupLoanRow {
  direction: 'lend' | 'borrow';
  /** 借贷对象（负债性质识别依据） */
  counterparty: string;
  /** 借贷备注（负债性质识别依据） */
  note: string | null;
  remaining: number;
  periods: number | null;
  date: string;
  due_date: string | null;
}

export interface CheckupInput {
  /** 当月收入按分类聚合（含分类名与金额） */
  incomeByCategory: { name: string; total: number }[];
  /** 当月总收入 */
  totalIncome: number;
  /** 当月总支出 */
  totalExpense: number;
  /** 月均支出（近 6 个月有记录月份平均；流动性覆盖的分母） */
  avgMonthlyExpense: number;
  /** 月均收入（近 12 个月有记录月份平均；债务收入比的分母） */
  avgMonthlyIncome: number;
  /** 流动资产余额（现金/银行/电子钱包合计） */
  liquidAssets: number;
  /** 全部未结清借贷（含借出与借入） */
  loans: CheckupLoanRow[];
  /** 计算短期负债时的基准日（YYYY-MM-DD） */
  asOf: string;
}

export interface CheckupMetrics {
  /** ① 总收入（当月） */
  totalIncome: number;
  /** ② 劳动收入占比（当月，0-1） */
  laborIncomeRatio: number;
  /** ③ 收入来源数量（当月收入分类数） */
  incomeSourceCount: number;
  /** ④ 总负债（借入未结清剩余本金合计） */
  totalDebt: number;
  /** ⑤ 债务收入比 DSR（估算月供/月均收入；无法估算时 null） */
  dsr: number | null;
  /** ⑥ 短期负债占比（剩余期数≤12 或剩余期限≤1 年的借入负债占比） */
  shortTermDebtRatio: number | null;
  /** ⑦ 净储蓄率（当月结余/收入） */
  netSavingRate: number;
  /** ⑧ 流动性覆盖月数（流动资产/月均支出） */
  liquidityMonths: number | null;
  /** ⑨ 保障覆盖率（责任缺口法综合覆盖率；无收入基线无法估算时 null） */
  insuranceCoverage: number | null;
}

/** 日期差（自然日，to 晚于 from 为正） */
function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  return Math.round((b - a) / 86400000);
}

/** 百分比文本（内联实现，避免与 format 层互相依赖） */
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/**
 * 财务体检九项指标计算（纯函数，可单测）。
 * 口径与「家庭财务四张表」保持一致：
 * - 劳动收入 = 收入分类名命中「工资/奖金/兼职/劳务/薪」的合计；
 * - 总负债 = 借入方向且未结清的剩余本金；
 * - DSR 估算月供：分期贷款取 剩余本金/剩余期数；到期一次取 剩余本金/剩余月数（按 due_date 距基准日的天数折算）；
 *   若某笔借贷既无期数也无到期日，则整体无法估算月供 → dsr 返回 null；
 * - 短期负债 = 剩余期数≤12 或剩余期限≤365 天的借入负债；
 * - 净储蓄率 = (收入-支出)/收入（收入为 0 时视为 0）；
 * - 流动性覆盖 = 流动资产/月均支出（月均支出为 0 时不可估 → null）。
 */
export function calcCheckupMetrics(input: CheckupInput): CheckupMetrics {
  const { incomeByCategory, totalIncome, totalExpense, avgMonthlyExpense, avgMonthlyIncome, liquidAssets, loans, asOf } = input;

  // ② 劳动收入占比
  const laborIncome = incomeByCategory
    .filter((c) => LABOR_INCOME_KEYWORDS.some((k) => c.name.includes(k)))
    .reduce((s, c) => s + c.total, 0);
  const laborIncomeRatio = totalIncome > 0 ? laborIncome / totalIncome : 0;

  // ③ 收入来源数量
  const incomeSourceCount = incomeByCategory.length;

  // ④⑤⑥ 负债类：只统计借入方向且未结清
  const borrowLoans = loans.filter((l) => l.direction === 'borrow' && l.remaining > 0.0001);
  const totalDebt = borrowLoans.reduce((s, l) => s + l.remaining, 0);

  let shortDebt = 0;
  let monthlyPayment = 0;
  let paymentEstimable = true;
  for (const l of borrowLoans) {
    // 剩余期数：分期贷款取 periods；到期一次按剩余天数折算成月数；两者都无 → 无法估算
    const months = l.periods && l.periods > 0
      ? l.periods
      : l.due_date ? Math.max(1, Math.round(daysBetween(asOf, l.due_date) / 30)) : null;
    if (months === null) { paymentEstimable = false; continue; }
    if (months <= 12) shortDebt += l.remaining;
    monthlyPayment += l.remaining / months;
  }
  const shortTermDebtRatio = totalDebt > 0 ? shortDebt / totalDebt : null;
  const dsr = paymentEstimable && avgMonthlyIncome > 0 ? monthlyPayment / avgMonthlyIncome : null;

  // ⑦ 净储蓄率
  const netSavingRate = totalIncome > 0 ? (totalIncome - totalExpense) / totalIncome : 0;

  // ⑧ 流动性覆盖月数
  const liquidityMonths = avgMonthlyExpense > 0 ? liquidAssets / avgMonthlyExpense : null;

  return {
    totalIncome,
    laborIncomeRatio,
    incomeSourceCount,
    totalDebt,
    dsr,
    shortTermDebtRatio,
    netSavingRate,
    liquidityMonths,
    insuranceCoverage: null,
  };
}

// ---------------- 现金流三分（经营性 / 投资性 / 融资性） ----------------

export type CashFlowKind = 'operating' | 'investing' | 'financing';

/** 投资性现金流关键词：命中即归为投资活动（理财/投资/资本收益） */
const INVEST_CASHFLOW_KEYWORDS = ['利息', '股息', '分红', '收益', '理财', '基金', '股票', '投资', '租金', '债券', '黄金'];
/** 融资性现金流关键词：命中即归为融资活动（借贷/还款/信用消费） */
const FINANCE_CASHFLOW_KEYWORDS = ['借', '还', '贷款', '信用', '分期', '白条', '花呗', '借呗', '透支', '垫付'];

/** 按分类名归类现金流属性：优先融资（借还/信用），其次投资，其余为经营 */
export function classifyCashFlowKind(name: string): CashFlowKind {
  if (FINANCE_CASHFLOW_KEYWORDS.some((k) => name.includes(k))) return 'financing';
  if (INVEST_CASHFLOW_KEYWORDS.some((k) => name.includes(k))) return 'investing';
  return 'operating';
}

export interface CashFlowSplit {
  income: Record<CashFlowKind, number>;
  expense: Record<CashFlowKind, number>;
  net: Record<CashFlowKind, number>;
}

/**
 * 现金流三分：把当月收支分类映射为经营性/投资性/融资性，并计算各自净额。
 * 口径说明：转账不产生现金流（不计入）；融资性现金流主要由借贷/还款类交易体现，普通收支分类命中「借/还/信用」等词也会归入。
 */
export function calcCashFlowSplit(
  incomeByCategory: { name: string; total: number }[],
  expenseByCategory: { name: string; total: number }[]
): CashFlowSplit {
  const income: Record<CashFlowKind, number> = { operating: 0, investing: 0, financing: 0 };
  const expense: Record<CashFlowKind, number> = { operating: 0, investing: 0, financing: 0 };
  for (const c of incomeByCategory) income[classifyCashFlowKind(c.name)] += c.total;
  for (const c of expenseByCategory) expense[classifyCashFlowKind(c.name)] += c.total;
  return {
    income,
    expense,
    net: {
      operating: income.operating - expense.operating,
      investing: income.investing - expense.investing,
      financing: income.financing - expense.financing,
    },
  };
}

// ---------------- 负债结构（性质分类 + 还款到期分布） ----------------

export type DebtNature = 'mortgage' | 'auto' | 'consumer' | 'business' | 'other';

/** 负债性质关键词映射：房贷/车贷/消费贷/经营贷（按借贷对象与备注识别） */
const NATURE_KEYWORDS: Record<Exclude<DebtNature, 'other'>, string[]> = {
  mortgage: ['房', '按揭'],
  auto: ['车', '车辆'],
  consumer: ['消费', '信用', '分期', '白条', '花呗', '借呗', '信用卡'],
  business: ['经营', '生意', '创业', '周转', '企业'],
};

/** 按借贷对象/备注识别负债性质，未命中归「其他」 */
export function classifyDebtNature(counterparty: string, note: string | null): DebtNature {
  const text = `${counterparty} ${note ?? ''}`;
  for (const [kind, kws] of Object.entries(NATURE_KEYWORDS) as [Exclude<DebtNature, 'other'>, string[]][]) {
    if (kws.some((kw) => text.includes(kw))) return kind;
  }
  return 'other';
}

/** 估算剩余月数（与 calcCheckupMetrics 中短期负债口径一致） */
function estimateRemainingMonths(l: CheckupLoanRow, asOf: string): number | null {
  if (l.periods && l.periods > 0) return l.periods;
  if (l.due_date) return Math.max(1, Math.round(daysBetween(asOf, l.due_date) / 30));
  return null;
}

export interface DebtMaturityBucket {
  /** 分桶标签：12个月内 / 1-3年 / 3年以上 / 期限未知 */
  label: string;
  total: number;
  ratio: number | null;
  count: number;
}

export interface DebtStructure {
  /** 各性质负债金额合计 */
  nature: Record<DebtNature, number>;
  /** 还款到期分布（剩余期限分桶） */
  maturity: DebtMaturityBucket[];
  /** 消费性负债占比（消费类 / 总负债；无负债时 null） */
  consumerRatio: number | null;
}

/** 负债结构：性质分类 + 还款到期分布（仅统计借入未结清） */
export function calcDebtStructure(loans: CheckupLoanRow[], asOf: string): DebtStructure {
  const borrows = loans.filter((l) => l.direction === 'borrow' && l.remaining > 0.0001);
  const nature: Record<DebtNature, number> = { mortgage: 0, auto: 0, consumer: 0, business: 0, other: 0 };
  const maturity: DebtMaturityBucket[] = [
    { label: '12个月内', total: 0, ratio: null, count: 0 },
    { label: '1-3年', total: 0, ratio: null, count: 0 },
    { label: '3年以上', total: 0, ratio: null, count: 0 },
    { label: '期限未知', total: 0, ratio: null, count: 0 },
  ];
  const totalDebt = borrows.reduce((s, l) => s + l.remaining, 0);
  for (const l of borrows) {
    nature[classifyDebtNature(l.counterparty, l.note)] += l.remaining;
    const months = estimateRemainingMonths(l, asOf);
    const idx = months === null ? 3 : months <= 12 ? 0 : months <= 36 ? 1 : 2;
    maturity[idx].total += l.remaining;
    maturity[idx].count += 1;
  }
  for (const b of maturity) b.ratio = totalDebt > 0 ? b.total / totalDebt : null;
  return { nature, maturity, consumerRatio: totalDebt > 0 ? nature.consumer / totalDebt : null };
}

// ---------------- 负债清偿周期 ----------------

export type PayoffStatus = 'clear' | 'good' | 'slow' | 'stuck';

export interface DebtPayoff {
  /** 负债总额（借入未结清剩余本金） */
  totalDebt: number;
  /** 估算月供合计（无期数且无到期日的贷款视为无固定月供，不参与月供合计） */
  monthlyPayment: number;
  /** 月均结余（近 12 个月月均收入 − 近 6 个月月均支出，与 DSR/流动性分母同源） */
  monthlySurplus: number;
  /** 预计还清所需月数：结余不足以覆盖月供或无结余 → null（按当前节奏无法清偿） */
  payoffMonths: number | null;
  /** 预计还清日期（基准日 + payoffMonths；无法估算时 null） */
  payoffDate: string | null;
  /** 清偿状态：clear 无负债 / good 一年内还清 / slow 周期较长 / stuck 难以清偿 */
  status: PayoffStatus;
}

/**
 * 负债清偿周期：估算按当前月均结余全部用于还债时，还清全部借入负债所需月数。
 * 口径说明：忽略利息（记账无利率字段）；月结余需先覆盖估算月供，其余用于提前还债，
 * 等效于「每月可还金额 = 月结余」；月结余不足以覆盖月供或无结余时视为难以清偿。
 */
export function calcDebtPayoff(loans: CheckupLoanRow[], monthlySurplus: number, asOf: string): DebtPayoff {
  const borrows = loans.filter((l) => l.direction === 'borrow' && l.remaining > 0.0001);
  const totalDebt = borrows.reduce((s, l) => s + l.remaining, 0);
  let monthlyPayment = 0;
  for (const l of borrows) {
    const months = estimateRemainingMonths(l, asOf);
    if (months !== null) monthlyPayment += l.remaining / months;
  }
  // 无负债：无需清偿
  if (totalDebt <= 0.0001) {
    return { totalDebt: 0, monthlyPayment, monthlySurplus, payoffMonths: 0, payoffDate: asOf, status: 'clear' };
  }
  // 月结余不足以覆盖估算月供（或无结余）→ 按当前节奏无法清偿
  if (monthlySurplus <= 0.0001 || monthlySurplus < monthlyPayment - 0.0001) {
    return { totalDebt, monthlyPayment, monthlySurplus, payoffMonths: null, payoffDate: null, status: 'stuck' };
  }
  const payoffMonths = Math.ceil(totalDebt / monthlySurplus);
  const payoffDate = dayjs(asOf).add(payoffMonths, 'month').format('YYYY-MM-DD');
  return { totalDebt, monthlyPayment, monthlySurplus, payoffMonths, payoffDate, status: payoffMonths <= 12 ? 'good' : 'slow' };
}

// ---------------- 支出结构体检（刚性 / 可选 + 恩格尔系数） ----------------

/** 食品类支出关键词（恩格尔系数分子，同时属刚性支出） */
const FOOD_EXPENSE_KEYWORDS = ['餐饮', '食品', '伙食', '外卖', '零食'];
/** 刚性支出关键词（住房/通勤/通讯/医疗/教育/保险等生活必需） */
const ESSENTIAL_EXPENSE_KEYWORDS = ['房', '租', '按揭', '物业', '水电', '燃气', '电费', '水费', '取暖', '供暖', '网费', '话费', '通讯', '交通', '加油', '地铁', '公交', '医疗', '药', '教育', '学费', '保险', '日用品', '日用', '生活', '家政', '保洁'];
/** 可选支出关键词（娱乐/旅行/购物/游戏/订阅等非必需） */
const DISCRETIONARY_EXPENSE_KEYWORDS = ['娱乐', '旅行', '旅游', '度假', '购物', '服饰', '衣服', '鞋', '游戏', '订阅', '会员', '美容', '护肤', '健身', '咖啡', '茶饮', '烟酒', '数码'];

export type ExpenseNature = 'essential' | 'discretionary' | 'uncategorized';

export interface SpendingStructure {
  /** 各性质支出金额 */
  byNature: Record<ExpenseNature, number>;
  /** 刚性支出占比（刚性 / 总支出；无支出时 null） */
  essentialRatio: number | null;
  /** 可选支出占比（可选 / 总支出；无支出时 null） */
  discretionaryRatio: number | null;
  /** 恩格尔系数 = 食品类支出 / 总支出（无支出时 null） */
  engelCoefficient: number | null;
  /** 食品类支出金额（恩格尔分子） */
  foodAmount: number;
  /** 食品类支出笔数 */
  foodCount: number;
}

/** 按分类名归类支出性质：食品与生活必需属刚性，非必需属可选，未命中归「未分类」 */
export function classifyExpenseNature(name: string): ExpenseNature {
  if (FOOD_EXPENSE_KEYWORDS.some((k) => name.includes(k))) return 'essential';
  if (ESSENTIAL_EXPENSE_KEYWORDS.some((k) => name.includes(k))) return 'essential';
  if (DISCRETIONARY_EXPENSE_KEYWORDS.some((k) => name.includes(k))) return 'discretionary';
  return 'uncategorized';
}

/**
 * 支出结构体检：按分类名把当月支出映射为刚性/可选/未分类，并计算刚性占比与恩格尔系数。
 * 口径说明：恩格尔系数 = 食品餐饮类支出 ÷ 总支出，>0.6 贫困、0.5-0.6 温饱、0.4-0.5 小康、<0.4 富裕；
 * 分类识别依赖分类名关键词，未命中归「未分类」，可通过调整分类名改进识别。
 */
export function calcSpendingStructure(expenseByCategory: { name: string; total: number }[]): SpendingStructure {
  const byNature: Record<ExpenseNature, number> = { essential: 0, discretionary: 0, uncategorized: 0 };
  let foodAmount = 0;
  let foodCount = 0;
  for (const c of expenseByCategory) {
    byNature[classifyExpenseNature(c.name)] += c.total;
    if (FOOD_EXPENSE_KEYWORDS.some((k) => c.name.includes(k))) {
      foodAmount += c.total;
      foodCount += 1;
    }
  }
  const total = byNature.essential + byNature.discretionary + byNature.uncategorized;
  return {
    byNature,
    essentialRatio: total > 0 ? byNature.essential / total : null,
    discretionaryRatio: total > 0 ? byNature.discretionary / total : null,
    engelCoefficient: total > 0 ? foodAmount / total : null,
    foodAmount,
    foodCount,
  };
}

// ---------------- 净资产成长性（总资产 − 总负债 的积累速度） ----------------

export interface NetAssetGrowth {
  /** 当前净资产（实时：总资产 − 总负债） */
  currentNet: number;
  /** 参考时点净资产（优先去年同期月份；记账不足一年时取最早记录） */
  baseNet: number;
  /** 参考时点月份（YYYY-MM；无历史记录时为空） */
  baseMonth: string;
  /** 成长率 = (当前 − 参考) / |参考|；参考净资产≈0 或无可参考记录 → null */
  growthRate: number | null;
  /** 参考时点到当前的覆盖月数（不足 12 说明记账数据不足，按已有记录估算） */
  monthsCovered: number;
  /** 预警等级：净资产为负 risk / 较参考缩水 warn / 增长 good / 无可参考 none */
  level: 'good' | 'warn' | 'risk' | 'none';
}

/**
 * 净资产成长性：当前净资产较参考时点的变化率。
 * 口径说明：参考时点优先取「去年同期月份」；记账不足 12 个月时取最早一条历史记录，
 * 与保障覆盖的年收入基线口径一致（不足时按已有记录估算，避免无数据时误判）。
 * 参考净资产为 0 或负数时仍用其绝对值作分母，避免正负翻转导致方向失真。
 */
export function calcNetAssetGrowth(
  currentNet: number,
  history: { month: string; net_worth: number }[],
  asOfYm: string
): NetAssetGrowth {
  if (history.length === 0) {
    // 完全无历史记录：无参考点，成长率不可估算；净资产为负仍按风险提示
    return { currentNet, baseNet: 0, baseMonth: '', growthRate: null, monthsCovered: 0, level: currentNet < -0.0001 ? 'risk' : 'none' };
  }
  // 优先取去年同期月份；记账不足一年时回退到最早记录
  const targetYm = dayjs(`${asOfYm}-01`).subtract(1, 'year').format('YYYY-MM');
  const sorted = [...history].sort((a, b) => (a.month < b.month ? -1 : 1));
  const ref = sorted.find((r) => r.month === targetYm) ?? sorted[0];
  const baseNet = ref.net_worth;
  // 覆盖月数 = 参考月到体检月的完整月数 + 1（含两端）
  const monthsCovered = Math.max(0, dayjs(`${asOfYm}-01`).diff(dayjs(`${ref.month}-01`), 'month')) + 1;
  const growthRate = Math.abs(baseNet) <= 0.0001 ? null : (currentNet - baseNet) / Math.abs(baseNet);
  let level: NetAssetGrowth['level'];
  if (currentNet < -0.0001) level = 'risk';
  else if (growthRate === null) level = 'none';
  else if (growthRate < 0) level = 'warn';
  else level = 'good';
  return { currentNet, baseNet, baseMonth: ref.month, growthRate, monthsCovered, level };
}

// ---------------- 应急储备达成进度（流动资产 ÷ 目标应急储备） ----------------

export interface EmergencyFund {
  /** 流动资产（现金/银行/电子钱包） */
  liquidAssets: number;
  /** 目标储备月数（默认 6 个月） */
  targetMonths: number;
  /** 目标金额 = 月均支出 × 目标月数 */
  targetAmount: number;
  /** 当前可覆盖月数 = 流动资产 ÷ 月均支出（月均支出为 0 时 null） */
  coverageMonths: number | null;
  /** 达成进度 = 流动资产 ÷ 目标金额（目标金额≈0 时 null） */
  progress: number | null;
  /** 缺口金额 = max(0, 目标 − 流动资产)；已达标为 0 */
  shortfall: number;
  /** 预警等级：达标 good / 过半 warn / 不足一半 risk / 无法估算 none */
  level: 'good' | 'warn' | 'risk' | 'none';
}

/**
 * 应急储备达成进度：按「流动资产 ÷ 近 6 个月月均支出」衡量当前储备能覆盖几个月开销，
 * 并以目标储备月数（默认 6 个月，对应建议区间的上限）换算目标金额与达成进度。
 * 口径说明：与流动性覆盖月数互补——流动性看「够撑几个月」，本指标看「距 6 个月目标还差多少钱」；
 * 月均支出为 0（无支出记录）时无法估算目标金额，progress 为 null 避免误导。
 */
export function calcEmergencyFund(liquidAssets: number, avgMonthlyExpense: number, targetMonths = 6): EmergencyFund {
  const targetAmount = avgMonthlyExpense * targetMonths;
  const coverageMonths = avgMonthlyExpense > 0 ? liquidAssets / avgMonthlyExpense : null;
  const progress = targetAmount > 0 ? liquidAssets / targetAmount : null;
  const shortfall = Math.max(0, targetAmount - liquidAssets);
  let level: EmergencyFund['level'];
  if (progress === null) level = 'none';
  else if (progress >= 1) level = 'good';
  else if (progress >= 0.5) level = 'warn';
  else level = 'risk';
  return { liquidAssets, targetMonths, targetAmount, coverageMonths, progress, shortfall, level };
}

// ---------------- 收入集中度（劳动 / 资本 / 转移 三大类） ----------------

/** 资本收入关键词（劳动收入关键词沿用上方 LABOR_INCOME_KEYWORDS） */
const CAPITAL_INCOME_KEYWORDS = ['利息', '股息', '分红', '收益', '理财', '基金', '股票', '租金', '投资', '债券'];

export type IncomeKind = 'labor' | 'capital' | 'transfer';

/** 收入三大类：命中劳动关键词 → 劳动；命中资本关键词 → 资本；其余（红包/补贴/报销等偶然收入）→ 转移 */
export function classifyIncomeKind(name: string): IncomeKind {
  if (LABOR_INCOME_KEYWORDS.some((k) => name.includes(k))) return 'labor';
  if (CAPITAL_INCOME_KEYWORDS.some((k) => name.includes(k))) return 'capital';
  return 'transfer';
}

export interface IncomeConcentration {
  /** 三大类收入占比（按金额降序） */
  shares: { kind: IncomeKind; label: string; total: number; ratio: number }[];
  /** 最大类别占比（预警依据） */
  maxRatio: number;
  /** 赫芬达尔指数 Σ(占比²)：1/3≈完全均衡，1=单一来源 */
  hhi: number;
  /** 预警等级：>70% 集中风险，>50% 关注，其余良好 */
  level: 'good' | 'warn' | 'risk';
}

/** 收入集中度：三大类占比 + 赫芬达尔指数 + 预警等级 */
export function calcIncomeConcentration(
  incomeByCategory: { name: string; total: number }[],
  totalIncome: number
): IncomeConcentration {
  const sums: Record<IncomeKind, number> = { labor: 0, capital: 0, transfer: 0 };
  for (const c of incomeByCategory) sums[classifyIncomeKind(c.name)] += c.total;
  const labels: Record<IncomeKind, string> = { labor: '劳动收入', capital: '资本收入', transfer: '转移收入' };
  const shares = (Object.keys(sums) as IncomeKind[])
    .map((kind) => ({ kind, label: labels[kind], total: sums[kind], ratio: totalIncome > 0 ? sums[kind] / totalIncome : 0 }))
    .sort((a, b) => b.total - a.total);
  const maxRatio = shares.length > 0 && totalIncome > 0 ? shares[0].ratio : 0;
  const hhi = shares.reduce((acc, s) => acc + s.ratio * s.ratio, 0);
  return { shares, maxRatio, hhi, level: maxRatio > 0.7 ? 'risk' : maxRatio > 0.5 ? 'warn' : 'good' };
}

// ---------------- 保障覆盖（人力资本维度：保单录入 + 责任缺口法） ----------------

export type InsuranceKind = 'life' | 'critical' | 'medical' | 'accident';

/** 保单：录入于财务体检页，存储于 settings/kv（不新增表结构） */
export interface InsurancePolicy {
  id: string;
  /** 险种：寿险/重疾/医疗/意外 */
  kind: InsuranceKind;
  /** 保单名称 */
  name: string;
  /** 保额（元） */
  coverage: number;
  /** 年缴保费（元） */
  annualPremium: number;
  /** 备注（可选） */
  note?: string;
}

/** 险种中文标签（页面与口径说明共用） */
export const INSURANCE_KIND_LABELS: Record<InsuranceKind, string> = {
  life: '寿险',
  critical: '重疾险',
  medical: '医疗险',
  accident: '意外险',
};

/**
 * 责任缺口法建议保额：
 * - 寿险/意外 = 年收入 × 10（覆盖收入损失期与家庭责任）；
 * - 重疾 = 年收入 × 5（治疗费用 + 康复期 3-5 年收入损失）；
 * - 医疗 = 固定 100 万（覆盖大额医疗费用，不随收入变动）。
 */
export function calcInsuranceSuggestions(annualIncome: number): Record<InsuranceKind, number> {
  return {
    life: annualIncome * 10,
    critical: annualIncome * 5,
    medical: 1_000_000,
    accident: annualIncome * 10,
  };
}

export interface InsuranceCoverage {
  /** 年收入估算（月均收入 × 12；无收入基线时为 0） */
  annualIncome: number;
  /** 各险种已配置保额合计（同险种多份保单累加） */
  covered: Record<InsuranceKind, number>;
  /** 各险种建议保额 */
  suggested: Record<InsuranceKind, number>;
  /** 综合覆盖率 = Σ已配置保额 ÷ Σ建议保额（无收入基线无法估算时 null） */
  totalRatio: number | null;
  /** 预警等级：≥100% 充足，70-100% 关注，<70% 缺口；无法估算 none */
  level: 'good' | 'warn' | 'risk' | 'none';
  /** 保单数量 */
  policyCount: number;
  /** 年缴保费合计 */
  totalPremium: number;
}

/**
 * 保障覆盖率计算（责任缺口法，纯函数可单测）。
 * 综合覆盖率 = Σ各险种已配置保额 ÷ Σ建议保额；年收入为 0 时无法估算 → totalRatio=null。
 */
export function calcInsuranceCoverage(policies: InsurancePolicy[], annualIncome: number): InsuranceCoverage {
  const covered: Record<InsuranceKind, number> = { life: 0, critical: 0, medical: 0, accident: 0 };
  let totalPremium = 0;
  for (const p of policies) {
    // 保额为 0 或负数的保单不参与覆盖；保费只取非负值累计用于展示
    if (p.coverage > 0) covered[p.kind] += p.coverage;
    totalPremium += Math.max(0, p.annualPremium || 0);
  }
  const suggested = calcInsuranceSuggestions(annualIncome);
  const sumCovered = covered.life + covered.critical + covered.medical + covered.accident;
  const sumSuggested = suggested.life + suggested.critical + suggested.medical + suggested.accident;
  const totalRatio = annualIncome > 0 ? sumCovered / sumSuggested : null;
  let level: InsuranceCoverage['level'] = 'none';
  if (totalRatio !== null) {
    level = totalRatio >= 1 ? 'good' : totalRatio >= 0.7 ? 'warn' : 'risk';
  }
  return { annualIncome, covered, suggested, totalRatio, level, policyCount: policies.length, totalPremium };
}

export interface CheckupDiagnosisItem {
  level: 'good' | 'warn' | 'risk';
  title: string;
  detail: string;
}

export interface CheckupExtra {
  cashFlow?: CashFlowSplit;
  debtStructure?: DebtStructure;
  incomeConcentration?: IncomeConcentration;
  insurance?: InsuranceCoverage;
  debtPayoff?: DebtPayoff;
  spendingStructure?: SpendingStructure;
  netAssetGrowth?: NetAssetGrowth;
  emergencyFund?: EmergencyFund;
}

/** 按文章诊断顺序生成结论：先看储蓄率是否入不敷出 → 债务收入比 → 流动性 → 收入结构 → 现金流 → 集中度/负债结构 → 清偿周期 → 保障 */
export function buildCheckupDiagnosis(m: CheckupMetrics, extra?: CheckupExtra): CheckupDiagnosisItem[] {
  const out: CheckupDiagnosisItem[] = [];
  // 1) 储蓄率是否健康（先看是否入不敷出）
  if (m.totalIncome > 0 && m.netSavingRate < 0) {
    out.push({ level: 'risk', title: '本月入不敷出', detail: `支出超过收入 ${pct(Math.abs(m.netSavingRate))}，已动用存量资金。建议优先削减弹性开支并盘点可选订阅。` });
  } else if (m.totalIncome > 0 && m.netSavingRate < 0.1) {
    out.push({ level: 'warn', title: '储蓄率偏低', detail: `净储蓄率仅 ${pct(m.netSavingRate)}，建议不低于 10%。` });
  } else if (m.totalIncome > 0) {
    out.push({ level: 'good', title: '储蓄情况健康', detail: `净储蓄率 ${pct(m.netSavingRate)}，收支结余良好，继续保持。` });
  }
  // 2) 债务收入比（参考线 36% / 43%）
  if (m.dsr !== null && m.totalDebt > 0) {
    if (m.dsr > 0.43) out.push({ level: 'risk', title: '债务负担偏高', detail: `债务收入比 ${pct(m.dsr)} 超过 43% 警戒线，月供压力大，警惕现金流断裂风险。` });
    else if (m.dsr > 0.36) out.push({ level: 'warn', title: '债务负担需关注', detail: `债务收入比 ${pct(m.dsr)} 超过 36% 参考线，建议逐步降低月供占比。` });
    else out.push({ level: 'good', title: '债务负担可控', detail: `债务收入比 ${pct(m.dsr)} 低于 36% 参考线。` });
  }
  // 3) 流动性覆盖（应急储备 3-6 个月）
  if (m.liquidityMonths !== null) {
    if (m.liquidityMonths < 1) out.push({ level: 'risk', title: '应急储备严重不足', detail: `流动资产仅够支撑 ${m.liquidityMonths.toFixed(1)} 个月开销，建议尽快储备 3-6 个月支出。` });
    else if (m.liquidityMonths < 3) out.push({ level: 'warn', title: '应急储备偏少', detail: `流动资产覆盖 ${m.liquidityMonths.toFixed(1)} 个月开销，建议至少储备 3-6 个月。` });
    else out.push({ level: 'good', title: '应急储备充足', detail: `流动资产可覆盖 ${m.liquidityMonths.toFixed(1)} 个月开销，抗风险能力良好。` });
  }
  // 4) 收入结构：劳动收入占比与来源数量
  if (m.totalIncome > 0 && m.laborIncomeRatio < 0.5) {
    out.push({ level: 'warn', title: '收入依赖被动所得', detail: `劳动收入仅占 ${pct(m.laborIncomeRatio)}，主动创收能力偏弱，注意收入稳定性与可持续性。` });
  }
  if (m.incomeSourceCount === 1) {
    out.push({ level: 'warn', title: '收入来源单一', detail: '当前仅 1 个收入来源，建议适当多元化以分散风险。' });
  }
  // 5) 现金流：经营性净额为负 → 日常收支缺口
  if (extra?.cashFlow && m.totalIncome > 0 && extra.cashFlow.net.operating < 0) {
    out.push({ level: 'risk', title: '经营性现金流为负', detail: `日常经营收支净额为 ${pct(extra.cashFlow.net.operating / m.totalIncome)}（负），日常开销依赖投资或融资输血，需警惕。` });
  }
  // 6) 收入集中度预警
  if (extra?.incomeConcentration && m.totalIncome > 0) {
    const c = extra.incomeConcentration;
    if (c.level === 'risk') out.push({ level: 'risk', title: '收入集中度过高', detail: `最大收入类别占比 ${pct(c.maxRatio)}，高度依赖单一来源，收入波动风险大，建议多元化。` });
    else if (c.level === 'warn') out.push({ level: 'warn', title: '收入集中度偏高', detail: `最大收入类别占比 ${pct(c.maxRatio)}，注意分散收入来源。` });
  }
  // 7) 负债结构：消费类负债占比高 → 优先清偿高息消费贷
  if (extra?.debtStructure?.consumerRatio !== null && extra?.debtStructure?.consumerRatio !== undefined && extra.debtStructure.consumerRatio > 0.5) {
    out.push({ level: 'warn', title: '消费类负债占比偏高', detail: `消费性负债占总负债 ${pct(extra.debtStructure.consumerRatio)}，通常利率较高，建议优先清偿。` });
  }
  // 8) 负债清偿周期：结余不足以覆盖月供 → 风险；周期超过 10 年 → 提示（正常房贷周期不告警）
  if (extra?.debtPayoff && extra.debtPayoff.status === 'stuck') {
    out.push({
      level: 'risk',
      title: '负债难以清偿',
      detail: `月均结余 ¥${Math.round(extra.debtPayoff.monthlySurplus).toLocaleString()} 不足以覆盖估算月供 ¥${Math.round(extra.debtPayoff.monthlyPayment).toLocaleString()}，按当前收支节奏负债将持续累积，建议优化支出结构或寻求债务重组。`,
    });
  } else if (extra?.debtPayoff?.status === 'slow' && (extra.debtPayoff.payoffMonths ?? 0) > 120) {
    out.push({ level: 'warn', title: '负债清偿周期偏长', detail: `按当前月结余估算需 ${extra.debtPayoff.payoffMonths} 个月（超 10 年）还清全部负债，建议加大还款力度或优先清偿高息贷款。` });
  }
  // 9) 支出结构：刚性占比过高 / 恩格尔偏高 / 可选支出过大 → 提示（无支出时不生成避免误导）
  if (extra?.spendingStructure) {
    const s = extra.spendingStructure;
    if (s.essentialRatio !== null && s.essentialRatio > 0.75) out.push({ level: 'warn', title: '刚性支出占比偏高', detail: `刚性支出占总支出 ${pct(s.essentialRatio)}，可灵活调配的空间小，建议梳理可选支出以增强财务弹性。` });
    if (s.engelCoefficient !== null && s.engelCoefficient > 0.5) out.push({ level: 'warn', title: '食品支出占比偏高', detail: `恩格尔系数 ${pct(s.engelCoefficient)}（食品支出占总支出比例）偏高，支出主要用于满足基本生活。` });
    if (s.discretionaryRatio !== null && s.discretionaryRatio > 0.4) out.push({ level: 'warn', title: '可选支出占比偏高', detail: `可选支出占总支出 ${pct(s.discretionaryRatio)}，建议控制娱乐购物等非必需消费。` });
  }
  // 10) 保障覆盖（人力资本：责任缺口法；无收入基线无法估算时不生成结论避免误导）
  if (extra?.insurance && extra.insurance.totalRatio !== null) {
    const r = extra.insurance.totalRatio;
    if (r === 0) out.push({ level: 'risk', title: '尚未配置保障', detail: '未录入任何保单，家庭风险敞口较大，建议优先配置医疗险与重疾险等刚需保障。' });
    else if (r < 0.7) out.push({ level: 'risk', title: '保障缺口较大', detail: `综合保障覆盖率仅 ${pct(r)}，家庭责任缺口明显，建议逐步补足寿险/重疾/医疗/意外保障。` });
    else if (r < 1) out.push({ level: 'warn', title: '保障覆盖待补充', detail: `综合保障覆盖 ${pct(r)}，建议优先补足缺口较大的险种。` });
    else out.push({ level: 'good', title: '保障配置充足', detail: `综合保障覆盖率 ${pct(r)}，主要责任缺口已覆盖，可按需优化险种结构。` });
  }
  // 11) 净资产成长性：净资产为负 → 风险；较参考时点缩水 → 警示；增长 → 良好（无参考数据时不生成避免误导）
  if (extra?.netAssetGrowth) {
    const g = extra.netAssetGrowth;
    if (g.currentNet < -0.0001) {
      out.push({ level: 'risk', title: '净资产为负', detail: `当前净资产为 ¥${Math.round(g.currentNet).toLocaleString()}，资不抵债，建议优先压缩负债并增加结余。` });
    } else if (g.growthRate !== null && g.growthRate < 0) {
      out.push({
        level: 'warn',
        title: '净资产较参考时点缩水',
        detail: `净资产由 ${g.baseMonth} 的 ¥${Math.round(g.baseNet).toLocaleString()} 降至当前 ¥${Math.round(g.currentNet).toLocaleString()}，缩水 ${pct(-g.growthRate)}；建议控制负债并保持正向结余，避免资产持续流失。`,
      });
    } else if (g.growthRate !== null) {
      out.push({ level: 'good', title: '净资产稳步增长', detail: `净资产较 ${g.baseMonth} 增长 ${pct(g.growthRate)}，当前 ¥${Math.round(g.currentNet).toLocaleString()}，财富积累情况良好。` });
    }
  }
  // 12) 应急储备达成进度：按 6 个月目标月数衡量缺口（与流动性覆盖互补；目标无法估算时不生成避免误导）
  if (extra?.emergencyFund) {
    const ef = extra.emergencyFund;
    if (ef.progress !== null) {
      if (ef.progress >= 1) {
        out.push({ level: 'good', title: '应急储备目标已达成', detail: `流动资产可覆盖 ${(ef.coverageMonths ?? 0).toFixed(1)} 个月开销，已达到 ${ef.targetMonths} 个月目标储备。` });
      } else if (ef.progress >= 0.5) {
        out.push({ level: 'warn', title: '应急储备过半', detail: `已储备目标（${ef.targetMonths} 个月开销）的 ${pct(ef.progress)}，距目标还差 ¥${Math.round(ef.shortfall).toLocaleString()}。` });
      } else {
        out.push({ level: 'risk', title: '应急储备缺口较大', detail: `仅达成 ${ef.targetMonths} 个月目标储备的 ${pct(ef.progress)}，缺口约 ¥${Math.round(ef.shortfall).toLocaleString()}，建议优先补充流动性资金。` });
      }
    }
  }
  return out;
}

export interface CheckupResult {
  ym: string;
  /** 去年同期总收入（同比锚点） */
  lastYearIncome: number;
  metrics: CheckupMetrics;
  /** 现金流三分（经营性/投资性/融资性） */
  cashFlow: CashFlowSplit;
  /** 负债结构（性质分类 + 还款到期分布） */
  debtStructure: DebtStructure;
  /** 收入集中度（劳动/资本/转移三大类 + 预警） */
  incomeConcentration: IncomeConcentration;
  /** 保障覆盖（责任缺口法：各险种已配置/建议保额 + 综合覆盖率） */
  insurance: InsuranceCoverage;
  /** 负债清偿周期（总负债/估算月供/月均结余/预计还清月数） */
  debtPayoff: DebtPayoff;
  /** 支出结构体检（刚性/可选占比 + 恩格尔系数） */
  spendingStructure: SpendingStructure;
  /** 净资产成长性（当前净资产较参考时点的变化率） */
  netAssetGrowth: NetAssetGrowth;
  /** 应急储备达成进度（流动资产 ÷ 目标储备金额） */
  emergencyFund: EmergencyFund;
  diagnosis: CheckupDiagnosisItem[];
}

/**
 * 财务体检：按「家庭财务四张表」口径计算十一项指标 + 同比 + 诊断结论。
 * - 收入类：当月收入按分类聚合（劳动收入占比/来源数量）+ 去年同期收入（同比）；
 * - 负债类：借入未结清剩余本金（总负债/DSR/短期占比）+ 负债清偿周期；
 * - 现金流量：流动资产 ÷ 近 6 个月月均支出（流动性覆盖 + 应急储备达成进度）+ 支出结构；
 * - 净资产：当前净资产（总资产 − 总负债）较去年同期的成长率；
 * - 人力资本：保障覆盖按责任缺口法计算（保单存于 settings/kv，年收入基线 = 近 12 个月月均收入 × 12）。
 */
export async function getFinancialCheckup(ym: string = dayjs().format('YYYY-MM')): Promise<CheckupResult> {
  const lid = currentLedgerId();
  const start = dayjs(`${ym}-01`).format('YYYY-MM-DD');
  const end = dayjs(start).endOf('month').format('YYYY-MM-DD');

  // 各查询的时间窗只依赖 ym，相互无数据依赖 → 全部并行执行，减少切换月份时的等待
  const lastStart = dayjs(start).subtract(1, 'year').format('YYYY-MM-DD');
  const lastEnd = dayjs(lastStart).endOf('month').format('YYYY-MM-DD');
  const expStart = dayjs(start).subtract(5, 'month').startOf('month').format('YYYY-MM-DD');
  const incStart = dayjs(start).subtract(11, 'month').startOf('month').format('YYYY-MM-DD');

  const [incomeCats, expenseCats, [cur], [last], expRows, incRows, [liq], loans, netTrend] = await Promise.all([
    // 当月收入按分类聚合（劳动收入占比/来源数量/收入集中度）
    select<{ name: string; total: number }>(
      `SELECT c.name, SUM(t.amount) AS total
       FROM transactions t JOIN categories c ON t.category_id = c.id
       WHERE t.type = 'income' AND t.date BETWEEN $1 AND $2 AND t.ledger_id = $3
       GROUP BY c.id`,
      [start, end, lid]
    ),
    // 当月支出按分类聚合（现金流三分共用）
    select<{ name: string; total: number }>(
      `SELECT c.name, SUM(t.amount) AS total
       FROM transactions t JOIN categories c ON t.category_id = c.id
       WHERE t.type = 'expense' AND t.date BETWEEN $1 AND $2 AND t.ledger_id = $3
       GROUP BY c.id`,
      [start, end, lid]
    ),
    // 当月收入/支出合计
    select<{ income: number; expense: number }>(
      `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
              COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expense
       FROM transactions WHERE date BETWEEN $1 AND $2 AND ledger_id = $3`,
      [start, end, lid]
    ),
    // 去年同期总收入（同比锚点）
    select<{ income: number }>(
      `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income
       FROM transactions WHERE date BETWEEN $1 AND $2 AND ledger_id = $3`,
      [lastStart, lastEnd, lid]
    ),
    // 近 6 个月月均支出（流动性覆盖分母；只对有支出的月份取平均，避免未记账月份拉低均值）
    select<{ ym: string; total: number }>(
      `SELECT strftime('%Y-%m', date) AS ym, SUM(amount) AS total
       FROM transactions WHERE type = 'expense' AND date >= $1 AND date <= $2 AND ledger_id = $3
       GROUP BY ym`,
      [expStart, end, lid]
    ),
    // 近 12 个月月均收入（DSR 分母；只对有收入的月份取平均）
    select<{ ym: string; total: number }>(
      `SELECT strftime('%Y-%m', date) AS ym, SUM(amount) AS total
       FROM transactions WHERE type = 'income' AND date >= $1 AND date <= $2 AND ledger_id = $3
       GROUP BY ym`,
      [incStart, end, lid]
    ),
    // 流动资产（现金/银行/电子钱包）
    select<{ total: number }>(
      `SELECT COALESCE(SUM(balance),0) AS total FROM accounts
       WHERE type IN ('cash','bank','ewallet') AND ledger_id = $1`,
      [lid]
    ),
    // 未结清借贷（负债口径在纯函数内按 direction 过滤）
    select<CheckupLoanRow>(
      `SELECT direction, counterparty, note, remaining, periods, date, due_date FROM loans
       WHERE status != 'settled' AND remaining > 0.0001 AND ledger_id = $1`,
      [lid]
    ),
    // 净资产趋势（当前净资产实时值 + 历史累计序列，供成长性参考时点使用）
    getNetWorthTrend(),
  ]);

  const incomeByCategory = incomeCats.map((r) => ({ name: r.name, total: Number(r.total) || 0 }));
  const expenseByCategory = expenseCats.map((r) => ({ name: r.name, total: Number(r.total) || 0 }));
  const asOf = dayjs().format('YYYY-MM-DD');

  // 近 6 个月月均支出（流动性覆盖分母；只对有支出的月份取平均，避免未记账月份拉低均值）
  const avgMonthlyExpense = expRows.length > 0
    ? expRows.reduce((s, r) => s + (Number(r.total) || 0), 0) / expRows.length : 0;
  // 近 12 个月月均收入（DSR 分母与保障覆盖年收入基线；只对有收入的月份取平均）
  const avgMonthlyIncome = incRows.length > 0
    ? incRows.reduce((s, r) => s + (Number(r.total) || 0), 0) / incRows.length : 0;

  const metrics = calcCheckupMetrics({
    incomeByCategory,
    totalIncome: cur?.income ?? 0,
    totalExpense: cur?.expense ?? 0,
    avgMonthlyExpense,
    avgMonthlyIncome,
    liquidAssets: liq?.total ?? 0,
    loans,
    asOf,
  });

  // 三项升级指标：现金流三分 / 负债结构 / 收入集中度
  const cashFlow = calcCashFlowSplit(incomeByCategory, expenseByCategory);
  const debtStructure = calcDebtStructure(loans, asOf);
  const incomeConcentration = calcIncomeConcentration(incomeByCategory, cur?.income ?? 0);
  // 保障覆盖（人力资本）：保单存储于 settings/kv，年收入基线 = 近 12 个月月均收入 × 12
  const insurance = calcInsuranceCoverage(getInsurancePolicies(), avgMonthlyIncome * 12);
  // 负债清偿周期：月均结余 = 近 12 个月月均收入 − 近 6 个月月均支出
  const debtPayoff = calcDebtPayoff(loans, avgMonthlyIncome - avgMonthlyExpense, asOf);
  // 支出结构体检：刚性/可选占比 + 恩格尔系数（按当月支出分类名关键词映射）
  const spendingStructure = calcSpendingStructure(expenseByCategory);
  // 净资产成长性：当前净资产 = 总资产 − 总负债（实时）；参考时点优先去年同期，记账不足一年时取最早记录
  const netAssetGrowth = calcNetAssetGrowth(netTrend.currentNet, netTrend.history, ym);
  // 应急储备达成进度：目标 = 近 6 个月月均支出 × 6 个月（复用流动性覆盖的流动资产与月均支出，不新增查询）
  const emergencyFund = calcEmergencyFund(liq?.total ?? 0, avgMonthlyExpense);
  // 第九项卡片直接展示综合覆盖率
  metrics.insuranceCoverage = insurance.totalRatio;

  return {
    ym,
    lastYearIncome: last?.income ?? 0,
    metrics,
    cashFlow,
    debtStructure,
    incomeConcentration,
    insurance,
    debtPayoff,
    spendingStructure,
    netAssetGrowth,
    emergencyFund,
    diagnosis: buildCheckupDiagnosis(metrics, { cashFlow, debtStructure, incomeConcentration, insurance, debtPayoff, spendingStructure, netAssetGrowth, emergencyFund }),
  };
}