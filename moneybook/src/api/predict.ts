import dayjs from 'dayjs';
import { select } from './db';
import { currentLedgerId } from '@/lib/ledger';

/**
 * 智能预算与支出预测（纯本地规则 + 简单时序，无网络）
 * ---------------------------------------------------------------
 * 依据近 N 个月各分类的历史支出，用「加权移动平均 + 最近趋势」预测下月支出，
 * 并给出每分类的建议预算额度（预测 × 安全系数），帮助用户提前设定预算。
 * 核心预测逻辑为纯函数（predictNext），便于单测；DB 仅负责取近 N 月按分类的月度合计。
 */

export interface StepPredict {
  /** 预测的下月支出金额 */
  predicted: number;
  /** 最近一个月环比变化率（%），数据不足为 null */
  momPct: number | null;
  /** 趋势：up / down / flat */
  trend: 'up' | 'down' | 'flat';
  /** 近 N 月该分类的月均支出 */
  avg: number;
  /** 可靠度 0~1（启发式估算＝样本量+波动，非准确率/置信区间） */
  reliability: number;
  /** 参与预测的样本月份数（= 坐到有效数据的历史月数），供界面展示"基于 N 个月" */
  sampleMonths: number;
}

/**
 * 预测下一个值：= 0.5×最近月 + 0.35×月均 + 0.15×前一月（权重和为 1）。
 * 只对有限非负值有效；空数组返回 0 / 无趋势。momPct 以最近两月环比表示。
 * 可靠度由"实际有支出的月份数"与波动共同决定：样本越多越可信、波动越大越下调。
 */
export function predictNext(values: number[]): StepPredict {
  const v = values.filter((n) => Number.isFinite(n) && n >= 0);
  const n = v.length;
  const last = v[n - 1] ?? 0;
  const avg = n ? v.reduce((a, b) => a + b, 0) / n : 0;
  const prev = n >= 2 ? v[n - 2] : last;
  const predicted = n
    ? Math.max(0, Math.round(0.5 * last + 0.35 * avg + (n >= 2 ? 0.15 * prev : 0.15 * last)))
    : 0;
  const momPct = n >= 2 && prev > 0 ? Math.round(((last - prev) / prev) * 1000) / 10 : null;
  const trend: StepPredict['trend'] = momPct == null ? 'flat' : momPct > 10 ? 'up' : momPct < -10 ? 'down' : 'flat';
  // 样本量＝实际有支出的月份数（>0），区别于"补零的窗口宽度"：稀疏历史不应被零填充虚增可靠度
  const sampleMonths = v.filter((x) => x > 0).length;
  // 可靠度：样本量基础分 + 波动惩罚（变异系数越大越不确定）。启发式估算，非准确率。
  let reliability = sampleMonths === 0 ? 0 : sampleMonths === 1 ? 0.4 : sampleMonths === 2 ? 0.7 : 0.9;
  if (n >= 2) {
    const std = Math.sqrt(v.reduce((s, x) => s + (x - avg) ** 2, 0) / n);
    const cv = avg > 0 ? std / avg : 0;
    reliability -= cv * 0.4; // 波动大则降可靠度
    reliability = Math.max(0.05, Math.min(0.95, reliability));
  }
  return { predicted, momPct, trend, avg, reliability: Math.round(reliability * 100) / 100, sampleMonths };
}

/** 单分类逐月序列（按时间升序，含完整月份填充 0） */
export interface CategorySeries {
  name: string;
  icon: string;
  color: string;
  /** 各月支出，长度 = months，时间升序 */
  values: number[];
}

/**
 * 取近 months 个月按分类的月度支出序列（补零到整月窗口）。
 * 时间窗口：含「上月」在内向前 months 个自然月。
 */
export async function fetchMonthlySeries(type: 'income' | 'expense', months = 6): Promise<{ ymList: string[]; categories: CategorySeries[] }> {
  const end = dayjs().subtract(1, 'month').endOf('month').format('YYYY-MM-DD');
  // 窗口起点 = 上月向前 months 个月（含上月共 months 个自然月）
  // 历史缺陷：起点曾用 subtract(months-1)（只覆盖 months-1 个月），
  // 且 ymList 曾用 subtract(months-1-i) 把「当月」排进序列（窗口内无当月数据），
  // 导致 lastActual（上月支出）恒为 0、环比恒为 -100%。此处两者一并修正：
  // 窗口与序列严格对齐为「上月往前 months 个月」，最后一位即上月。
  const start = dayjs().subtract(months, 'month').startOf('month').format('YYYY-MM-DD');
  const ymList: string[] = [];
  for (let i = 0; i < months; i++) ymList.push(dayjs().subtract(months - i, 'month').format('YYYY-MM'));

  const rows = await select<{ name: string; icon: string; color: string; ym: string; amt: number }>(
    `SELECT c.name, c.icon, c.color, strftime('%Y-%m', t.date) AS ym, SUM(t.amount) AS amt
     FROM transactions t JOIN categories c ON t.category_id = c.id
     WHERE t.type = $1 AND t.date BETWEEN $2 AND $3 AND t.ledger_id = $4
     GROUP BY c.id, ym ORDER BY c.name, ym`,
    [type, start, end, currentLedgerId()]
  );
  const byCat = new Map<string, { name: string; icon: string; color: string; map: Map<string, number> }>();
  for (const r of rows) {
    let c = byCat.get(r.name);
    if (!c) { c = { name: r.name, icon: r.icon || '', color: r.color || '', map: new Map() }; byCat.set(r.name, c); }
    c.map.set(r.ym, (c.map.get(r.ym) ?? 0) + r.amt);
  }
  const categories: CategorySeries[] = [];
  for (const c of byCat.values()) {
    categories.push({ name: c.name, icon: c.icon, color: c.color, values: ymList.map((ym) => c.map.get(ym) ?? 0) });
  }
  return { ymList, categories };
}

export interface CategoryForecast {
  name: string;
  icon: string;
  lastActual: number;
  predicted: number;
  momPct: number | null;
  trend: StepPredict['trend'];
  /** 可靠度 0~1（启发式估算，非准确率） */
  reliability: number;
  /** 参与预测的样本月份数 */
  sampleMonths: number;
  /** 建议预算 = 预测 × 1.1（安全系数），抹零到元 */
  suggestedBudget: number;
}

export interface ExpenseForecast {
  /** 预测目标月份 */
  month: string;
  /** 分类预测（按预测金额降序） */
  categories: CategoryForecast[];
  totalLast: number;
  totalPredicted: number;
}

/** 基于近 N 月支出生成下月预测与分拆预算建议 */
export async function buildExpenseForecast(months = 6): Promise<ExpenseForecast> {
  const { categories } = await fetchMonthlySeries('expense', months);
  const fc: CategoryForecast[] = [];
  let totalLast = 0;
  let totalPredicted = 0;
  for (const series of categories) {
    const lastActual = series.values.at(-1) ?? 0;
    const p = predictNext(series.values);
    if (p.predicted <= 0 && lastActual <= 0) continue; // 完全无支出历史则忽略
    totalLast += lastActual;
    totalPredicted += p.predicted;
    fc.push({
      name: series.name,
      icon: series.icon,
      lastActual,
      predicted: p.predicted,
      momPct: p.momPct,
      trend: p.trend,
      reliability: p.reliability,
      sampleMonths: p.sampleMonths,
      suggestedBudget: Math.round(p.predicted * 1.1),
    });
  }
  fc.sort((a, b) => b.predicted - a.predicted);
  return {
    month: dayjs().format('YYYY-MM'),
    categories: fc.slice(0, 10),
    totalLast: Math.round(totalLast),
    totalPredicted: Math.round(totalPredicted),
  };
}