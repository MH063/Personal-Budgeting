// 深度智能分析 · 纯函数引擎
// -----------------------------------------------------------------------------
// 提供两类可单独交付的"更深的智能分析"：
//  1) 异常消费检测：月度支出序列异常（前 N 期均值±波动阈值突增）＋ 单笔交易按分类
//     显著偏离该分类平均水平（均值 + 2×标准差）的离群点。
//  2) 支出回归预测：对近若干月支出做最小二乘线性回归，外推下一期并给出趋势方向。
// 全部为纯函数（无副作用、无 DB/前端依赖），便于单元测试与在不同界面复用。
// -----------------------------------------------------------------------------

/** 月度支出异常项 */
export interface SpendingAnomaly {
  /** 该期标签（年-月） */
  label: string;
  /** 该期支出 */
  value: number;
  /** 基线（前几期均值） */
  baseline: number;
  /** 相对基线的增幅（0~∞） */
  diffRatio: number;
  /** 等级：warning=明显突增，danger=严重突增 */
  level: 'warning' | 'danger';
}

/** 单笔交易离群项 */
export interface TxAnomaly {
  /** 分类名（未命中分类时为类别/未知） */
  categoryName: string;
  /** 离群单笔金额 */
  amount: number;
  /** 该分类单笔均值基线 */
  baseline: number;
  /** 为均值的倍数（≥2 判为离群） */
  multiple: number;
}

/** 回归预测结果 */
export interface ExpenseForecast {
  /** 外推的下一期支出（不早于 0） */
  next: number;
  /** 回归斜率（每期变动额） */
  slope: number;
  /** 趋势方向 */
  direction: 'up' | 'down' | 'flat';
}

/** 输入样本分类（用于单笔离群检测） */
export interface TxSample {
  categoryId: number | null;
  categoryName?: string | null;
  amount: number;
}

/** 简易均值 */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 样本标准差（n-1）；样本不足 2 时返回 0 */
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/**
 * 检测月度支出序列中的异常突增。
 * 判定规则：第 i 期相对前几期均值 baseline，(value - baseline)/baseline ≥ 阈值时判为异常；
 *   ≥3   → danger（严重）
 *   ≥1.5 → warning（明显）
 * baseline 为 0 时，只要该期支出 ≥ 100 即视为新增异常。
 */
export function detectSpendingAnomalies(series: number[], labels: string[] = []): SpendingAnomaly[] {
  const out: SpendingAnomaly[] = [];
  // 至少需要 3 期才有"历史均值"可对比
  for (let i = 2; i < series.length; i++) {
    const hist = series.slice(0, i);
    const baseline = mean(hist);
    const value = series[i];
    if (value <= 0) continue;
    if (baseline > 0) {
      const diffRatio = (value - baseline) / baseline;
      if (diffRatio >= 1.5) {
        out.push({
          label: labels[i] ?? `${i}`,
          value,
          baseline: Math.round(baseline * 100) / 100,
          diffRatio: Math.round(diffRatio * 100) / 100,
          level: diffRatio >= 3 ? 'danger' : 'warning',
        });
      }
    } else if (value >= 100) {
      out.push({ label: labels[i] ?? `${i}`, value, baseline: 0, diffRatio: 1, level: 'warning' });
    }
  }
  return out;
}

/**
 * 检测单笔交易离群：按分类分组，某笔金额 ≥ 该分类单笔均值 + 2×标准差 时判为异常；
 * 该分类样本不足 3 笔时不做判定（无足够基线）。
 */
export function detectTransactionAnomalies(txs: TxSample[]): TxAnomaly[] {
  const groups = new Map<number | null, TxSample[]>();
  for (const t of txs) {
    const key = t.categoryId ?? null;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  const out: TxAnomaly[] = [];
  groups.forEach((list) => {
    if (list.length < 3) return; // 样本不足，无法形成基线
    for (const t of list) {
      // 用「剔除当前笔后的其余样本」作为基线，避免离群值自身污染均值/标准差
      const others = list.filter((o) => o !== t);
      if (others.length < 2) continue;
      const base = mean(others.map((o) => o.amount));
      const sd = stdev(others.map((o) => o.amount));
      const multiple = base > 0 ? t.amount / base : 0;
      // 有波动时用 均值+2σ；波动为 0 时要求至少达到 2 倍均值
      const exceeds = sd > 0 ? t.amount >= base + 2 * sd : t.amount >= base * 2;
      if (multiple >= 2 && exceeds) {
        out.push({
          categoryName: t.categoryName ?? '未分类',
          amount: t.amount,
          baseline: Math.round(base * 100) / 100,
          multiple: Math.round(multiple * 100) / 100,
        });
      }
    }
  });
  return out;
}

/**
 * 最小二乘线性回归：对 x=0..n-1 与 y 序列拟合 y = a + b*slope，
 * 外推下一期 y_n = a + b*n。
 * direction 判定：|slope| / max(mean(y),1) < 0.02 → flat，否则按 slope 正负。
 */
export function forecastMonthlyExpenses(series: number[]): ExpenseForecast {
  const n = series.length;
  if (n === 0) return { next: 0, slope: 0, direction: 'flat' };
  if (n === 1) return { next: Math.max(series[0], 0), slope: 0, direction: 'flat' };
  const xs = series.map((_, i) => i);
  const xMean = mean(xs);
  const yMean = mean(series);
  // 协方差与 x 方差
  let cov = 0, xvar = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - xMean) * (series[i] - yMean);
    xvar += (xs[i] - xMean) ** 2;
  }
  const slope = xvar > 0 ? cov / xvar : 0;
  const next = Math.max(yMean + slope * (n - xMean), 0); // = a + b*n
  const scale = Math.max(yMean, 1);
  const direction: ExpenseForecast['direction'] =
    slope > 0.02 * scale ? 'up' : slope < -0.02 * scale ? 'down' : 'flat';
  return { next: Math.round(next * 100) / 100, slope: Math.round(slope * 100) / 100, direction };
}