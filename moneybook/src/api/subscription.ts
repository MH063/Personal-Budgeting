import dayjs from 'dayjs';
import { select } from './db';
import { currentLedgerId } from '@/lib/ledger';

/**
 * 订阅 / 账单到期提醒检测（纯本地规则，无网络）
 * ---------------------------------------------------------------
 * 必要性：识别"每月固定金额、同一收款方"的周期性扣费（视频会员、云盘、话费自动充值、房租等），
 * 提前推算下一次扣费日并提醒，避免不知情扣款 / 忘记取消。
 * 核心识别逻辑为纯函数（detectMonthlyRecurring），便于单测；DB 仅取近 N 月支出明细。
 * 注意：与「周期记账」（api/recurring.ts，用户显式设定的计划）不同，这里是"从流水反向识别重复扣费"。
 */

export interface BillEntry {
  payee: string;
  note: string;
  amount: number;
  /** YYYY-MM-DD */
  date: string;
}

export interface RecurringBatch {
  /** 同一收款方+同一金额 */
  key: string;
  label: string;
  amount: number;
  /** 命中月份数 */
  hits: number;
  /** 命中的月份列表（YYYY-MM） */
  months: string[];
  /** 该账期的最近一次扣费日 */
  lastDate: string | null;
  /** 性质分类：subscription（可取消的付费订阅）/ housing（房租等刚性）/ personal（家人转账，防误判为订阅）/ other */
  category: 'subscription' | 'housing' | 'personal' | 'other';
  /** 该笔是否为"建议提醒可取消"的订阅：personal/housing 为 false，避免把给家人的固定转账当成可取消订阅 */
  isSubscription: boolean;
  /** 判定理由（L2 可解释：为什么归到该分类），供界面展示"判定为订阅，因为…" */
  reason: string;
  /** 可靠度 0~1：命中月份越多越可信（可解释性） */
  confidence: number;
}

/** 判定函数：给定跨月明细，识别"月度固定金额重复扣费"。 */
export function detectMonthlyRecurring(entries: BillEntry[], opts: { minHits?: number } = {}): RecurringBatch[] {
  const minHits = opts.minHits ?? 2;
  const byKey = new Map<string, RecurringBatch>();
  for (const e of entries) {
    const payee = String(e.payee ?? '').trim();
    if (!payee || !(e.amount > 0)) continue;
    const key = `${payee}||${Math.round(e.amount * 100)}`;
    let batch = byKey.get(key);
    if (!batch) {
      const cls = classifyRecurring(payee, e.amount);
      batch = { key, label: payee, amount: e.amount, hits: 0, months: [], lastDate: null, category: cls.category, isSubscription: cls.isSubscription, reason: cls.reason, confidence: 0 };
      byKey.set(key, batch);
    }
    const ym = String(e.date).slice(0, 7);
    if (batch.months.includes(ym)) continue;
    batch.months.push(ym);
    batch.hits = batch.months.length;
    // 置信度随命中月份数递增
    batch.confidence = batch.hits >= 4 ? 0.9 : batch.hits >= 3 ? 0.8 : 0.6;
    if (!batch.lastDate || e.date > batch.lastDate) batch.lastDate = e.date;
  }
  return [...byKey.values()]
    .filter((b) => b.hits >= minHits)
    .sort((a, b) => b.hits - a.hits || b.amount - a.amount);
}

export interface RecurringClass {
  category: RecurringBatch['category'];
  isSubscription: boolean;
  /** 判定理由（L2 可解释，供用户纠正闭环） */
  reason: string;
}

/**
 * 性质分类（纯函数，含"误判排除"）：把每月固定扣除按收款方文案归到四类。
 * personal（家人/生活费/还款）与 housing（房租等）不作为"可取消订阅"提醒，
 * 避免把"每月固定给家人转 2000"误当订阅；subscription 才是可取消/需警惕涨价的付费项。
 * 同时返回 reason（为什么如此归类），供界面展示"判定为订阅，因为…"，用户可据此纠正回写规则。
 */
export function classifyRecurring(payee: string, amount: number): RecurringClass {
  const p = String(payee ?? '');
  if (/(家人|父母|父亲|母亲|爸妈|爸爸|妈妈|老婆|老公|妻子|丈夫|孩子|小孩|儿子|女儿|亲属|亲戚|生活费|家用|转账)/.test(p)) {
    return { category: 'personal', isSubscription: false, reason: `收款方带有家人/转账字样（${p}）` };
  }
  // 花呗/白条/信用卡还款：还款性质，不是付费订阅（避免把"每月还信用卡"当订阅提醒取消）
  if (/(花呗|白条|信用卡|借呗|微粒贷|还款|还贷)/.test(p)) {
    return { category: 'personal', isSubscription: false, reason: `收款方带有还款字样（${p}）` };
  }
  if (/(房租|物业|房贷|水电|燃气|供暖|租金)/.test(p)) {
    return { category: 'housing', isSubscription: false, reason: `收款方带有住房/物业字样（${p}）` };
  }
  if (/(会员|vip|月度|月费|订阅|云盘|网盘|视频|音乐|话费|流量|保险|宽带|软件|超级会员|Plus)/i.test(p)) {
    return { category: 'subscription', isSubscription: true, reason: `收款方带有会员/订阅/服务字样（${p}）` };
  }
  return {
    category: 'other',
    isSubscription: amount > 0 && amount <= 500,
    reason: amount > 0 && amount <= 500 ? `无法识别类型但金额≤500，保守视为可取消订阅（${p}）` : `无法识别且金额>500，不作为订阅提醒（${p}）`,
  };
}

/**
 * 是否为季节性/用量型账单（纯函数）：水电气、话费、宽带等按用量计费、随季节波动属正常，
 * 不应被当作"涨价"提醒（涨价提醒针对固定订阅的单价上调）。
 */
export function isSeasonalBill(payee: string): boolean {
  return /(水费|电费|燃气|煤气|天然气|暖气|供暖|话费|流量|宽带|通信|水电|加油)/.test(String(payee ?? ''));
}

export interface PriceChange {
  payee: string;
  prevAmount: number;
  currAmount: number;
  /** 当前/上期 金额比：>1 为涨价 */
  ratio: number;
  /** 最近一次支付日 */
  date: string | null;
}

/**
 * 涨价 / 变价检测（纯函数）：对同一收款方按月聚合金额，
 * 若"较稳定的上期金额"与"最近一期金额"不同，则判为变价（含涨价），供"订阅涨价提醒"。
 * 上期金额取最近一期之前的众数金额，避免被单次噪声扰动。
 */
export function detectRecurringChange(entries: BillEntry[], opts: { minHits?: number } = {}): PriceChange[] {
  const minHits = opts.minHits ?? 2;
  const byPayee = new Map<string, { months: string[]; amounts: Map<string, number>; lastDate: string | null; lastYm: string }>();
  for (const e of entries) {
    const payee = String(e.payee ?? '').trim();
    if (!payee || !(e.amount > 0)) continue;
    const ym = String(e.date).slice(0, 7);
    let acc = byPayee.get(payee);
    if (!acc) { acc = { months: [], amounts: new Map(), lastDate: null, lastYm: '' }; byPayee.set(payee, acc); }
    if (!acc.months.includes(ym)) acc.months.push(ym);
    acc.amounts.set(ym, e.amount);
    if (!acc.lastDate || e.date > acc.lastDate) { acc.lastDate = e.date; acc.lastYm = ym; }
  }
  const out: PriceChange[] = [];
  for (const [payee, acc] of byPayee) {
    if (acc.months.length < minHits) continue;
    const currAmount = acc.amounts.get(acc.lastYm) ?? 0;
    if (!(currAmount > 0)) continue;
    // 上期金额：最近一期之前的月份中，出现最多的金额（众数，抗噪声）
    const earlier = acc.months.filter((m) => m !== acc.lastYm).map((m) => acc.amounts.get(m) ?? -1).filter((v) => v > 0);
    if (!earlier.length) continue;
    const freq = new Map<number, number>();
    for (const v of earlier) freq.set(v, (freq.get(v) ?? 0) + 1);
    let prevAmount = earlier[0];
    let best = 0;
    for (const [v, c] of freq) if (c > best) { best = c; prevAmount = v; }
    if (prevAmount > 0 && Math.abs(currAmount - prevAmount) > 0.001) {
      out.push({ payee, prevAmount, currAmount, ratio: currAmount / prevAmount, date: acc.lastDate });
    }
  }
  return out.sort((a, b) => (b.ratio - a.ratio));
}

/** 推算下一期待扣日期：最近扣费日 + 一个月（同日，月末越界收敛）。 */
export function nextDueDate(batch: RecurringBatch): string | null {
  if (!batch.lastDate) return null;
  const d = dayjs(batch.lastDate);
  const next = d.add(1, 'month');
  const day = Math.min(d.date(), next.daysInMonth());
  return `${next.format('YYYY-MM')}-${String(day).padStart(2, '0')}`;
}

/** 取近 months 个月的支出明细（含收款方/备注/日期），供订阅检测。 */
export async function fetchRecentExpenses(months = 6): Promise<BillEntry[]> {
  const start = dayjs().subtract(months - 1, 'month').startOf('month').format('YYYY-MM-DD');
  const end = dayjs().endOf('month').format('YYYY-MM-DD');
  return select<BillEntry>(
    `SELECT payee, note, amount, date FROM transactions
     WHERE type='expense' AND date BETWEEN $1 AND $2 AND ledger_id = $3
     ORDER BY date DESC`,
    [start, end, currentLedgerId()]
  );
}

/** 汇总：识别订阅并给出一批"即将到期"提醒（默认近 7 天内到期）与"变价/涨价"提醒。 */
export async function buildSubscriptionReminders(months = 6): Promise<{ items: RecurringBatch[]; dueSoon: RecurringBatch[]; priceUp: PriceChange[] }> {
  const entries = await fetchRecentExpenses(months);
  const items = detectMonthlyRecurring(entries);
  // 涨幅提醒仅针对固定订阅的单价上调：水电气等季节性/用量型账单的正常波动不算涨价
  const priceUp = detectRecurringChange(entries).filter((c) => c.ratio > 1 && !isSeasonalBill(c.payee));
  const today = dayjs().format('YYYY-MM-DD');
  const dueSoon = items.filter((b) => {
    const due = nextDueDate(b);
    if (!due) return false;
    const diff = dayjs(due).diff(dayjs(today), 'day');
    return diff >= 0 && diff <= 7;
  });
  return { items, dueSoon, priceUp };
}

/** 订阅续期/取消引导文案（纯函数）：给已识别订阅一条可执行的下一步提示，不越权操作外部账户。 */
export function cancellationGuide(b: RecurringBatch): string {
  if (!b.isSubscription) return '该扣费可能为房租/转账等固定支出，非可取消订阅，请自行确认。';
  const due = nextDueDate(b);
  const dateText = due ? `，下次扣费约 ${due}` : '';
  return `如不再需要可考虑取消「${b.label}」（${b.amount} 元/月${dateText}）。记一笔「取消」或删除该周期扣费即可；若已取消请忽略。`;
}