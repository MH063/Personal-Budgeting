/**
 * 订阅/重复扣费检测（subscription）单元测试。
 * 覆盖：跨月固定金额同收款方的识别、同月去重、不足阈值不判、下一期待扣日期推算。
 */
import { describe, it, expect } from 'vitest';
import { detectMonthlyRecurring, classifyRecurring, isSeasonalBill, detectRecurringChange, cancellationGuide, nextDueDate, type BillEntry, type RecurringBatch } from './subscription';

const mk = (date: string, amount: number, payee = '某会员', note = ''): BillEntry => ({ payee, note, amount, date });

// 构造一个含新字段的 RecurringBatch，便于 nextDueDate 测试
const batch = (over: Partial<RecurringBatch>): RecurringBatch => ({
  key: 'k', label: 'x', amount: 25, hits: 2, months: [], lastDate: null,
  category: 'subscription', isSubscription: true, reason: '', confidence: 0.8, ...over,
});

describe('detectMonthlyRecurring：月度固定金额重复扣费识别', () => {
  it('连续多个月同金额同收款方 → 识别为订阅', () => {
    const entries = [mk('2026-07-01', 25, '视频会员'), mk('2026-08-01', 25, '视频会员'), mk('2026-09-01', 25, '视频会员')];
    const hits = detectMonthlyRecurring(entries);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ label: '视频会员', amount: 25, hits: 3 });
    expect(hits[0].lastDate).toBe('2026-09-01');
  });

  it('同月多次只计一次；不足 2 次不判为订阅', () => {
    expect(detectMonthlyRecurring([mk('2026-09-01', 30), mk('2026-09-10', 30)])).toHaveLength(0);
    expect(detectMonthlyRecurring([mk('2026-08-05', 30), mk('2026-09-05', 30)])).toHaveLength(1);
  });

  it('金额不同 / 收款方不同的不合并', () => {
    const entries = [mk('2026-08-01', 10), mk('2026-09-01', 20), mk('2026-09-01', 10, '不同家')];
    expect(detectMonthlyRecurring(entries).length).toBeLessThan(2);
  });
});

describe('nextDueDate：下一期待扣日期推算', () => {
  it('在最近扣费日基础上加一个月', () => {
    const b = batch({ months: ['2026-08', '2026-09'], lastDate: '2026-09-15' });
    expect(nextDueDate(b)).toBe('2026-10-15');
  });
  it('无最近日期返回 null；月末越界收敛到月末', () => {
    expect(nextDueDate(batch({ lastDate: null }))).toBeNull();
    expect(nextDueDate(batch({ lastDate: '2026-01-31' }))).toBe('2026-02-28');
  });
});

describe('classifyRecurring：性质分类与误判排除', () => {
  it('家人/生活费/还款 归为 personal，不作为可取消订阅', () => {
    const c = classifyRecurring('给妈妈的生活费', 2000);
    expect(c.category).toBe('personal');
    expect(c.isSubscription).toBe(false);
  });

  it('房租/房贷 归为 housing，不作为订阅', () => {
    expect(classifyRecurring('房租 王房东', 3200).category).toBe('housing');
    expect(classifyRecurring('房租 王房东', 3200).isSubscription).toBe(false);
  });

  it('含会员/云盘/话费/视频 等归为 subscription 可取消', () => {
    expect(classifyRecurring('爱奇艺会员', 25).category).toBe('subscription');
    expect(classifyRecurring('百度网盘超级会员', 30).isSubscription).toBe(true);
    expect(classifyRecurring('手机话费充值', 100).isSubscription).toBe(true);
  });

  it('无法识别且金额≤500 视为订阅；>500 保守归 other', () => {
    expect(classifyRecurring('某平台', 30).category).toBe('other');
    expect(classifyRecurring('某平台', 30).isSubscription).toBe(true);
    expect(classifyRecurring('某平台', 1000).isSubscription).toBe(false);
  });

  it('信用卡/花呗/白条/贷款还款不被当作可取消订阅', () => {
    expect(classifyRecurring('花呗还款', 1500).category).toBe('personal');
    expect(classifyRecurring('信用卡还款', 2000).isSubscription).toBe(false);
    expect(classifyRecurring('京东白条分期', 500).isSubscription).toBe(false);
  });
});

describe('isSeasonalBill：季节/用量型账单识别', () => {
  it('水电气/话费/宽带/加油归为季节性，不报涨价', () => {
    expect(isSeasonalBill('国家电网电费')).toBe(true);
    expect(isSeasonalBill('燃气费')).toBe(true);
    expect(isSeasonalBill('运营商话费')).toBe(true);
  });
  it('固定订阅不算季节性', () => {
    expect(isSeasonalBill('百度网盘会员')).toBe(false);
  });
});

describe('detectRecurringChange：订阅涨价/变价检测', () => {
  it('同一收款方金额从 15 涨到 25 → 判为涨价（ratio>1）', () => {
    const entries = [
      mk('2026-07-01', 15, '某云盘'), mk('2026-08-01', 15, '某云盘'), mk('2026-09-01', 25, '某云盘'),
    ];
    const change = detectRecurringChange(entries);
    expect(change).toHaveLength(1);
    expect(change[0].payee).toBe('某云盘');
    expect(change[0].prevAmount).toBe(15);
    expect(change[0].currAmount).toBe(25);
    expect(change[0].ratio).toBeCloseTo(25 / 15);
  });

  it('金额稳定不判变价；假命中月份不足不判', () => {
    const stable = [mk('2026-07-01', 15, '某云盘'), mk('2026-08-01', 15, '某云盘'), mk('2026-09-01', 15, '某云盘')];
    expect(detectRecurringChange(stable)).toHaveLength(0);
    // 仅两个月且金额不同：命中月份不足 minHits(2) 外的上月才变小 —— 这里两月不同金额会判
    const two = [mk('2026-08-01', 15, '某云盘'), mk('2026-09-01', 25, '某云盘')];
    expect(detectRecurringChange(two)).toHaveLength(1);
  });
});

describe('cancellationGuide：订阅取消引导文案', () => {
  it('可取消订阅给下一步建议；非订阅给出防误判说明', () => {
    expect(cancellationGuide(batch({ label: '某视频会员', amount: 25, isSubscription: true, lastDate: '2026-09-15' }))).toContain('取消');
    expect(cancellationGuide(batch({ isSubscription: false, category: 'personal' }))).toContain('非可取消订阅');
  });
});