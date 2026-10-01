import dayjs from 'dayjs';
import { select } from './db';
import { currentLedgerId } from '@/lib/ledger';

/**
 * 反欺诈 / 异常交易检测（纯本地规则，无网络）
 * ---------------------------------------------------------------
 * 识别：① 金额显著离群（z-score，剔除自身作基线）；② 同收款方短时重复扣费；
 *        ③ 盗刷"小额探路 + 随后的较大额"组合。均为确定性规则，便于单测。
 * DB 仅取近一段时间支出明细；核心判定为纯函数 detectAnomalies。
 */

export interface TxLike {
  payee: string;
  note: string;
  amount: number;
  /** YYYY-MM-DD */
  date: string;
}

export interface Anomaly {
  kind: 'amount' | 'repeat' | 'probe';
  payee: string;
  amount: number;
  date: string;
  reason: string;
  /** 可靠度 0~1（启发式估算＝按规则强度映射，非准确率），供用户判断是否当真 */
  reliability: number;
}

const DAYS = (v?: string | null) => dayjs(v ?? '');

/**
 * 判定规则：
 * - amount：金额 z≥2.5 视为显著离群（剔除自身后计算均值/σ，避免"最大那笔检测不出"）。
 * - repeat：同一收款方在 7 天内出现 ≥3 次，视为集中重复扣费。
 * - probe：同一收款方在 3 天内出现 ≤5 元小额 + ≥200 元较大额，视为疑似盗刷探路。
 */
export function detectAnomalies(entries: TxLike[], opts: { z?: number; windowDays?: number } = {}): Anomaly[] {
  const zThr = opts.z ?? 2.5;
  const winDays = opts.windowDays ?? 7;
  const out: Anomaly[] = [];
  if (!entries.length) return out;

  // —— ① 金额离群（剔除自身作基线）——
  const amounts = entries.map((e) => e.amount);
  const sum = amounts.reduce((a, b) => a + b, 0);
  const n = amounts.length;
  const meanAll = sum / n;
  const stdAll = Math.sqrt(amounts.reduce((a, v) => a + (v - meanAll) ** 2, 0) / n);
  entries.forEach((e, i) => {
    // 剔除自身后的均/σ
    const mean = n > 1 ? (sum - e.amount) / (n - 1) : e.amount;
    const std =
      n > 1
        ? Math.sqrt(amounts.reduce((a, v, j) => (j === i ? a : a + (v - mean) ** 2), 0) / (n - 1))
        : 0;
    const z = std > 0 ? (e.amount - mean) / std : stdAll > 0 ? (e.amount - meanAll) / stdAll : 0;
    if (std > 0 && z >= zThr) {
      // 可靠度按 z 值映射：越离谱越可信（启发式，非准确率）
      const reliability = z >= 4 ? 0.95 : z >= 3 ? 0.9 : 0.8;
      out.push({ kind: 'amount', payee: e.payee || '未知', amount: e.amount, date: e.date, reason: `金额显著偏高（z=${z.toFixed(1)}）`, reliability });
    }
  });

  // —— ② 同收款方短时重复（7 天内 ≥3 次）——
  const byPayee = new Map<string, TxLike[]>();
  for (const e of entries) {
    if (!e.payee) continue;
    const arr = byPayee.get(e.payee) ?? [];
    arr.push(e);
    byPayee.set(e.payee, arr);
  }
  for (const [payee, arr] of byPayee) {
    const sorted = [...arr].sort((a, b) => (a.date < b.date ? -1 : 1));
    for (let i = 0; i < sorted.length; i++) {
      let count = 1;
      for (let j = i + 1; j < sorted.length; j++) {
        if (DAYS(sorted[j].date).diff(DAYS(sorted[i].date), 'day') <= winDays) count++;
        else break;
      }
      if (count >= 3) {
        const reliability = count >= 4 ? 0.9 : 0.8;
        out.push({ kind: 'repeat', payee, amount: sorted[i].amount, date: sorted[i].date, reason: `${winDays} 天内向同一收款方扣款 ${count} 次`, reliability });
        break; // 每收款方最多报一组
      }
    }
  }

  // —— ③ 小额探路 + 大额（3 天内）——
  for (const [payee, arr] of byPayee) {
    const small = arr.filter((e) => e.amount > 0 && e.amount <= 5);
    const large = arr.filter((e) => e.amount >= 200);
    for (const s of small) {
      if (large.some((l) => Math.abs(DAYS(l.date).diff(DAYS(s.date), 'day')) <= 3)) {
        out.push({ kind: 'probe', payee, amount: s.amount, date: s.date, reason: '疑似小额探路 + 大额组合（盗刷风险）', reliability: 0.7 });
        break;
      }
    }
  }
  return out;
}

/** 取近 months 个月支出明细参与检测 */
export async function fetchExpensesForAnomaly(months = 3): Promise<TxLike[]> {
  const start = dayjs().subtract(months - 1, 'month').startOf('month').format('YYYY-MM-DD');
  const end = dayjs().endOf('month').format('YYYY-MM-DD');
  return select<TxLike>(
    `SELECT payee, note, amount, date FROM transactions
     WHERE type='expense' AND date BETWEEN $1 AND $2 AND ledger_id = $3
     ORDER BY date`,
    [start, end, currentLedgerId()]
  );
}

/** 汇总异常交易报告 */
export async function buildAnomalyReport(months = 3): Promise<Anomaly[]> {
  return detectAnomalies(await fetchExpensesForAnomaly(months));
}