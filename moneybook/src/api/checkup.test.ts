/**
 * 财务体检指标计算 + 诊断结论纯函数单元测试。
 * 覆盖：九项指标（收入/负债/现金流）/ 现金流三分 / 负债性质与到期分布 /
 *      收入集中度，以及诊断顺序与风险等级。
 */
import { describe, it, expect } from 'vitest';
import {
  calcCheckupMetrics, buildCheckupDiagnosis,
  calcCashFlowSplit, classifyCashFlowKind,
  calcDebtStructure, calcIncomeConcentration, calcInsuranceCoverage, calcDebtPayoff,
  calcSpendingStructure, classifyExpenseNature, calcNetAssetGrowth, calcEmergencyFund,
  InsuranceKind, type InsuranceCoverage,
  type CheckupInput, type CheckupMetrics,
} from './stats';

const baseInput: CheckupInput = {
  incomeByCategory: [
    { name: '工资', total: 8000 },
    { name: '奖金', total: 2000 },
    { name: '投资收益', total: 1000 },
  ],
  totalIncome: 11000,
  totalExpense: 6600,
  avgMonthlyExpense: 6000,
  avgMonthlyIncome: 10000,
  liquidAssets: 36000,
  loans: [{ direction: 'borrow', counterparty: '测试', note: null, remaining: 48000, periods: 24, date: '2025-01-01', due_date: null }],
  asOf: '2026-10-24',
};

describe('calcCheckupMetrics：收入结构', () => {
  it('劳动收入占比：命中工资/奖金关键词，投资收益不计入', () => {
    const m = calcCheckupMetrics(baseInput);
    // 劳动收入 = 8000 + 2000 = 10000；总收入 11000
    expect(m.laborIncomeRatio).toBeCloseTo(10000 / 11000, 5);
    expect(m.incomeSourceCount).toBe(3);
    expect(m.totalIncome).toBe(11000);
  });

  it('无收入时劳动占比与储蓄率归 0，来源数量为 0', () => {
    const m = calcCheckupMetrics({ ...baseInput, incomeByCategory: [], totalIncome: 0, totalExpense: 0 });
    expect(m.laborIncomeRatio).toBe(0);
    expect(m.netSavingRate).toBe(0);
    expect(m.incomeSourceCount).toBe(0);
  });
});

describe('calcCheckupMetrics：负债结构', () => {
  it('总负债只统计借入且未结清，借出不计入', () => {
    const m = calcCheckupMetrics({
      ...baseInput,
      loans: [
        { direction: 'borrow', counterparty: '测试', note: null, remaining: 48000, periods: 24, date: '2025-01-01', due_date: null },
        { direction: 'lend', counterparty: '借出对象', note: null, remaining: 30000, periods: 12, date: '2025-01-01', due_date: null },
      ],
    });
    expect(m.totalDebt).toBe(48000);
  });

  it('DSR：分期贷款按月供=剩余本金/期数 估算', () => {
    const m = calcCheckupMetrics(baseInput);
    // 月供 = 48000 / 24 = 2000；月均收入 10000 → 0.2
    expect(m.dsr).toBeCloseTo(0.2, 5);
  });

  it('DSR：到期一次按 due_date 剩余天数折算月数后估算', () => {
    const m = calcCheckupMetrics({
      ...baseInput,
      loans: [
        { direction: 'borrow', counterparty: '测试', note: null, remaining: 6000, periods: null, date: '2025-01-01', due_date: '2026-12-24' },
      ],
    });
    // asOf 2026-10-24 → 距 due_date 2026-12-24 共 61 天 → 61/30≈2.03 → 2 个月 → 月供 3000 → 0.3
    expect(m.dsr).toBeCloseTo(0.3, 5);
  });

  it('DSR：借贷既无期数也无到期日 → 整体无法估算返回 null', () => {
    const m = calcCheckupMetrics({
      ...baseInput,
      loans: [{ direction: 'borrow', counterparty: '测试', note: null, remaining: 1000, periods: null, date: '2025-01-01', due_date: null }],
    });
    expect(m.dsr).toBeNull();
  });

  it('短期负债占比：期数≤12 计短期，其余计长期', () => {
    const m = calcCheckupMetrics({
      ...baseInput,
      loans: [
        { direction: 'borrow', counterparty: '测试', note: null, remaining: 20000, periods: 6, date: '2025-01-01', due_date: null },
        { direction: 'borrow', counterparty: '测试', note: null, remaining: 40000, periods: 24, date: '2025-01-01', due_date: null },
      ],
    });
    // 短期 20000 / 总 60000 ≈ 0.3333
    expect(m.shortTermDebtRatio).toBeCloseTo(20000 / 60000, 5);
  });

  it('短期负债占比：到期一次且剩余期限≤1 年计短期', () => {
    const m = calcCheckupMetrics({
      ...baseInput,
      loans: [
        { direction: 'borrow', counterparty: '测试', note: null, remaining: 6000, periods: null, date: '2025-01-01', due_date: '2027-01-01' },
      ],
    });
    // asOf 2026-10-24 → 距 2027-01-01 共 69 天 → 2.3 → 2 个月 ≤12 → 全部短期
    expect(m.shortTermDebtRatio).toBeCloseTo(1, 5);
  });

  it('无负债时短期占比为 null，DSR 为 0（无月供）', () => {
    const m = calcCheckupMetrics({ ...baseInput, loans: [] });
    expect(m.totalDebt).toBe(0);
    expect(m.shortTermDebtRatio).toBeNull();
    expect(m.dsr).toBe(0);
  });
});

describe('calcCheckupMetrics：现金流量', () => {
  it('净储蓄率 = (收入-支出)/收入', () => {
    const m = calcCheckupMetrics(baseInput);
    expect(m.netSavingRate).toBeCloseTo((11000 - 6600) / 11000, 5);
  });

  it('入不敷出时净储蓄率为负', () => {
    const m = calcCheckupMetrics({ ...baseInput, totalExpense: 13000 });
    expect(m.netSavingRate).toBeCloseTo((11000 - 13000) / 11000, 5);
    expect(m.netSavingRate).toBeLessThan(0);
  });

  it('流动性覆盖月数 = 流动资产 / 月均支出', () => {
    const m = calcCheckupMetrics(baseInput);
    expect(m.liquidityMonths).toBeCloseTo(36000 / 6000, 5);
  });

  it('月均支出为 0（近 6 个月无支出）时流动性不可估', () => {
    const m = calcCheckupMetrics({ ...baseInput, avgMonthlyExpense: 0 });
    expect(m.liquidityMonths).toBeNull();
  });
});

describe('buildCheckupDiagnosis：诊断结论', () => {
  const healthy: CheckupMetrics = {
    totalIncome: 11000, laborIncomeRatio: 0.8, incomeSourceCount: 3,
    totalDebt: 20000, dsr: 0.2, shortTermDebtRatio: 0.2,
    netSavingRate: 0.3, liquidityMonths: 6, insuranceCoverage: null,
  };

  it('健康画像全部给出良好结论', () => {
    const d = buildCheckupDiagnosis(healthy);
    expect(d.length).toBeGreaterThanOrEqual(3);
    expect(d.every((x) => x.level === 'good')).toBe(true);
  });

  it('入不敷出 → 储蓄率风险结论排在最前（按文章先看储蓄率）', () => {
    const d = buildCheckupDiagnosis({ ...healthy, netSavingRate: -0.1 });
    expect(d[0].level).toBe('risk');
    expect(d[0].title).toContain('入不敷出');
  });

  it('DSR 超过 43% → 债务风险结论', () => {
    const d = buildCheckupDiagnosis({ ...healthy, dsr: 0.5 });
    expect(d.some((x) => x.level === 'risk' && x.title.includes('债务负担偏高'))).toBe(true);
  });

  it('流动性不足 1 个月 → 应急储备风险结论', () => {
    const d = buildCheckupDiagnosis({ ...healthy, liquidityMonths: 0.5 });
    expect(d.some((x) => x.level === 'risk' && x.title.includes('应急储备'))).toBe(true);
  });

  it('收入来源单一 → 提示多元化的警示结论', () => {
    const d = buildCheckupDiagnosis({ ...healthy, incomeSourceCount: 1 });
    expect(d.some((x) => x.level === 'warn' && x.title.includes('收入来源单一'))).toBe(true);
  });

  it('无收入时不生成储蓄类结论（避免误导）', () => {
    const d = buildCheckupDiagnosis({ ...healthy, totalIncome: 0, netSavingRate: 0 });
    expect(d.some((x) => x.title.includes('储蓄'))).toBe(false);
  });
});

describe('calcCashFlowSplit：现金流三分', () => {
  it('分类名归入经营/投资/融资，并计算净额', () => {
    const split = calcCashFlowSplit(
      [
        { name: '工资', total: 8000 },
        { name: '基金收益', total: 1500 },
      ],
      [
        { name: '餐饮', total: 3000 },
        { name: '股票投资', total: 2000 },
        { name: '信用卡还款', total: 1000 },
      ]
    );
    // 收入：经营 8000 + 投资 1500；支出：经营 3000 + 投资 2000 + 融资 1000
    expect(split.income.operating).toBe(8000);
    expect(split.income.investing).toBe(1500);
    expect(split.income.financing).toBe(0);
    expect(split.net.operating).toBe(5000);
    expect(split.net.investing).toBe(-500);
    expect(split.net.financing).toBe(-1000);
  });

  it('关键词归类：普通/理财/借贷分别落经营/投资/融资', () => {
    expect(classifyCashFlowKind('工资')).toBe('operating');
    expect(classifyCashFlowKind('转账')).toBe('operating');
    expect(classifyCashFlowKind('理财收益')).toBe('investing');
    expect(classifyCashFlowKind('利息')).toBe('investing');
    expect(classifyCashFlowKind('借款')).toBe('financing');
    expect(classifyCashFlowKind('还款')).toBe('financing');
  });
});

describe('calcDebtStructure：负债性质与到期分布', () => {
  it('按对象/备注关键词识别性质，未命中归其他，消费类占比正确', () => {
    const s = calcDebtStructure(
      [
        { direction: 'borrow', counterparty: '工商银行住房按揭', note: null, remaining: 500000, periods: 120, date: '2025-01-01', due_date: null },
        { direction: 'borrow', counterparty: '招商银行信用卡', note: '分期', remaining: 20000, periods: 6, date: '2025-01-01', due_date: null },
        { direction: 'borrow', counterparty: '朋友', note: null, remaining: 10000, periods: null, date: '2025-01-01', due_date: null },
      ],
      '2026-10-24'
    );
    expect(s.nature.mortgage).toBe(500000);
    expect(s.nature.consumer).toBe(20000);
    expect(s.nature.other).toBe(10000);
    expect(s.consumerRatio).toBeCloseTo(20000 / 530000, 5);
  });

  it('借出方向不计入负债结构', () => {
    const s = calcDebtStructure(
      [
        { direction: 'borrow', counterparty: '房贷', note: null, remaining: 300000, periods: 240, date: '2025-01-01', due_date: null },
        { direction: 'lend', counterparty: '借款给朋友', note: null, remaining: 50000, periods: 12, date: '2025-01-01', due_date: null },
      ],
      '2026-10-24'
    );
    expect(s.nature.mortgage).toBe(300000);
    expect(s.maturity.reduce((a, b) => a + b.total, 0)).toBe(300000);
  });

  it('到期分布：≤12 月短期 / 13-36 中期 / >36 长期 / 无法估算未知', () => {
    const s = calcDebtStructure(
      [
        { direction: 'borrow', counterparty: 'a', note: null, remaining: 1000, periods: 6, date: '2025-01-01', due_date: null },
        { direction: 'borrow', counterparty: 'b', note: null, remaining: 2000, periods: 24, date: '2025-01-01', due_date: null },
        { direction: 'borrow', counterparty: 'c', note: null, remaining: 3000, periods: 60, date: '2025-01-01', due_date: null },
        { direction: 'borrow', counterparty: 'd', note: null, remaining: 4000, periods: null, date: '2025-01-01', due_date: null },
      ],
      '2026-10-24'
    );
    const byLabel = Object.fromEntries(s.maturity.map((b) => [b.label, b.total]));
    expect(byLabel['12个月内']).toBe(1000);
    expect(byLabel['1-3年']).toBe(2000);
    expect(byLabel['3年以上']).toBe(3000);
    expect(byLabel['期限未知']).toBe(4000);
    expect(s.maturity[0].count).toBe(1);
  });
});

describe('calcIncomeConcentration：收入集中度', () => {
  it('劳动收入占绝对主导 → 最大占比与预警等级为 risk，赫芬达尔指数正确', () => {
    const c = calcIncomeConcentration(
      [
        { name: '工资', total: 9000 },
        { name: '基金收益', total: 1000 },
        { name: '红包', total: 1000 },
      ],
      11000
    );
    expect(c.shares[0].kind).toBe('labor');
    expect(c.maxRatio).toBeCloseTo(9000 / 11000, 5);
    expect(c.level).toBe('risk');
    expect(c.hhi).toBeCloseTo((9000 / 11000) ** 2 + (1000 / 11000) ** 2 * 2, 5);
  });

  it('三大类分布均衡 → 等级 good，HHI 接近 1/3', () => {
    const c = calcIncomeConcentration(
      [
        { name: '工资', total: 4000 },
        { name: '基金收益', total: 3000 },
        { name: '红包', total: 3000 },
      ],
      10000
    );
    expect(c.level).toBe('good');
    expect(c.maxRatio).toBeCloseTo(0.4, 5);
    expect(c.hhi).toBeCloseTo(0.16 + 0.09 + 0.09, 5);
  });

  it('无收入时占比为 0 且等级 good', () => {
    const c = calcIncomeConcentration([], 0);
    expect(c.maxRatio).toBe(0);
    expect(c.level).toBe('good');
  });
});

describe('calcDebtPayoff：负债清偿周期', () => {
  /** 构造借入贷款行（默认 24 期分期） */
  const loan = (remaining: number, periods: number | null, due_date: string | null = null) =>
    ({ direction: 'borrow' as const, counterparty: '测试', note: null, remaining, periods, date: '2025-01-01', due_date });

  it('无负债 → clear，清偿月数为 0', () => {
    const p = calcDebtPayoff([], 5000, '2026-10-24');
    expect(p.status).toBe('clear');
    expect(p.totalDebt).toBe(0);
    expect(p.payoffMonths).toBe(0);
  });

  it('结余充足：月数 = ceil(总负债 / 月结余)，一年内 → good', () => {
    const p = calcDebtPayoff([loan(48000, 24)], 10000, '2026-10-24');
    // 估算月供 = 48000/24 = 2000 ≤ 结余 10000 → 每月可还 10000 → ceil(48000/10000) = 5
    expect(p.monthlyPayment).toBe(2000);
    expect(p.payoffMonths).toBe(5);
    expect(p.status).toBe('good');
    expect(p.payoffDate).toBe('2027-03-24'); // 2026-10-24 + 5 个月
  });

  it('周期超过 1 年 → slow', () => {
    const p = calcDebtPayoff([loan(600000, 240)], 3000, '2026-10-24');
    // 月供 2500 ≤ 3000 → ceil(600000/3000) = 200 个月
    expect(p.monthlyPayment).toBe(2500);
    expect(p.payoffMonths).toBe(200);
    expect(p.status).toBe('slow');
  });

  it('结余不足以覆盖估算月供 → stuck，无法估算还清月数', () => {
    const p = calcDebtPayoff([loan(48000, 24)], 1500, '2026-10-24');
    // 月供 2000 > 结余 1500
    expect(p.status).toBe('stuck');
    expect(p.payoffMonths).toBeNull();
    expect(p.payoffDate).toBeNull();
  });

  it('入不敷出（结余为负）→ stuck', () => {
    const p = calcDebtPayoff([loan(48000, 24)], -500, '2026-10-24');
    expect(p.status).toBe('stuck');
    expect(p.payoffMonths).toBeNull();
  });

  it('无固定月供（无期数无到期日）且结余充足 → 可还清', () => {
    const p = calcDebtPayoff([loan(12000, null, null)], 3000, '2026-10-24');
    expect(p.monthlyPayment).toBe(0);
    expect(p.payoffMonths).toBe(4);
    expect(p.status).toBe('good');
  });

  it('借出方向不计入清偿范围', () => {
    const p = calcDebtPayoff(
      [{ direction: 'lend', counterparty: '借出对象', note: null, remaining: 30000, periods: 12, date: '2025-01-01', due_date: null }],
      5000, '2026-10-24'
    );
    expect(p.status).toBe('clear');
    expect(p.totalDebt).toBe(0);
  });
});

describe('calcSpendingStructure：支出结构体检', () => {
  it('分类归组：食品/住房/通勤属刚性，娱乐/旅行/购物属可选，其余未分类', () => {
    expect(classifyExpenseNature('餐饮')).toBe('essential');
    expect(classifyExpenseNature('房租')).toBe('essential');
    expect(classifyExpenseNature('交通')).toBe('essential');
    expect(classifyExpenseNature('娱乐')).toBe('discretionary');
    expect(classifyExpenseNature('旅行')).toBe('discretionary');
    expect(classifyExpenseNature('宠物')).toBe('uncategorized');
  });

  it('占比与恩格尔系数计算正确', () => {
    const s = calcSpendingStructure([
      { name: '餐饮', total: 3000 }, // 刚性 + 食品
      { name: '房租', total: 4000 }, // 刚性
      { name: '娱乐', total: 2000 }, // 可选
      { name: '宠物', total: 1000 }, // 未分类
    ]);
    // 总 10000：刚性 7000、可选 2000、未分类 1000；恩格尔 = 3000/10000
    expect(s.byNature.essential).toBe(7000);
    expect(s.byNature.discretionary).toBe(2000);
    expect(s.byNature.uncategorized).toBe(1000);
    expect(s.essentialRatio).toBeCloseTo(0.7, 5);
    expect(s.discretionaryRatio).toBeCloseTo(0.2, 5);
    expect(s.engelCoefficient).toBeCloseTo(0.3, 5);
    expect(s.foodAmount).toBe(3000);
    expect(s.foodCount).toBe(1);
  });

  it('无支出时占比均为 null，食品金额为 0', () => {
    const s = calcSpendingStructure([]);
    expect(s.essentialRatio).toBeNull();
    expect(s.engelCoefficient).toBeNull();
    expect(s.foodAmount).toBe(0);
    expect(s.foodCount).toBe(0);
  });
});

describe('buildCheckupDiagnosis：升级指标诊断', () => {
  const healthy: CheckupMetrics = {
    totalIncome: 11000, laborIncomeRatio: 0.8, incomeSourceCount: 3,
    totalDebt: 20000, dsr: 0.2, shortTermDebtRatio: 0.2,
    netSavingRate: 0.3, liquidityMonths: 6, insuranceCoverage: null,
  };
  const baseExtra = {
    cashFlow: {
      income: { operating: 10000, investing: 1000, financing: 0 },
      expense: { operating: 7000, investing: 500, financing: 0 },
      net: { operating: 3000, investing: 500, financing: 0 },
    },
    incomeConcentration: { shares: [], maxRatio: 0.6, hhi: 0.4, level: 'warn' as const },
    debtStructure: { nature: { mortgage: 0, auto: 0, consumer: 10000, business: 0, other: 0 }, maturity: [], consumerRatio: 0.8 },
  };

  it('经营性现金流为负 → 风险结论', () => {
    const d = buildCheckupDiagnosis(healthy, {
      ...baseExtra,
      cashFlow: {
        income: { operating: 10000, investing: 1000, financing: 0 },
        expense: { operating: 12000, investing: 500, financing: 0 },
        net: { operating: -2000, investing: 500, financing: 0 },
      },
    });
    expect(d.some((x) => x.level === 'risk' && x.title.includes('经营性现金流为负'))).toBe(true);
  });

  it('收入集中度 risk → 风险结论', () => {
    const d = buildCheckupDiagnosis(healthy, { ...baseExtra, incomeConcentration: { shares: [], maxRatio: 0.85, hhi: 0.7, level: 'risk' } });
    expect(d.some((x) => x.level === 'risk' && x.title.includes('收入集中度过高'))).toBe(true);
  });

  it('消费类负债占比高 → 警示结论', () => {
    const d = buildCheckupDiagnosis(healthy, baseExtra);
    expect(d.some((x) => x.level === 'warn' && x.title.includes('消费类负债占比偏高'))).toBe(true);
  });

  it('清偿困难（stuck）→ 风险结论', () => {
    const d = buildCheckupDiagnosis(healthy, {
      ...baseExtra,
      debtPayoff: { totalDebt: 48000, monthlyPayment: 2000, monthlySurplus: 1500, payoffMonths: null, payoffDate: null, status: 'stuck' },
    });
    expect(d.some((x) => x.level === 'risk' && x.title.includes('负债难以清偿'))).toBe(true);
  });

  it('清偿周期超过 10 年 → 警示结论', () => {
    const d = buildCheckupDiagnosis(healthy, {
      ...baseExtra,
      debtPayoff: { totalDebt: 600000, monthlyPayment: 2500, monthlySurplus: 3000, payoffMonths: 200, payoffDate: '2043-06-24', status: 'slow' },
    });
    expect(d.some((x) => x.level === 'warn' && x.title.includes('负债清偿周期偏长'))).toBe(true);
  });

  it('一年内可还清（good）→ 不生成清偿告警', () => {
    const d = buildCheckupDiagnosis(healthy, {
      ...baseExtra,
      debtPayoff: { totalDebt: 48000, monthlyPayment: 2000, monthlySurplus: 10000, payoffMonths: 5, payoffDate: '2027-03-24', status: 'good' },
    });
    expect(d.some((x) => x.title.includes('清偿'))).toBe(false);
  });

  it('刚性支出占比高 → 警示结论', () => {
    const d = buildCheckupDiagnosis(healthy, {
      ...baseExtra,
      spendingStructure: { byNature: { essential: 8000, discretionary: 1000, uncategorized: 1000 }, essentialRatio: 0.8, discretionaryRatio: 0.1, engelCoefficient: 0.4, foodAmount: 4000, foodCount: 1 },
    });
    expect(d.some((x) => x.level === 'warn' && x.title.includes('刚性支出占比偏高'))).toBe(true);
  });

  it('恩格尔系数偏高 → 警示结论', () => {
    const d = buildCheckupDiagnosis(healthy, {
      ...baseExtra,
      spendingStructure: { byNature: { essential: 6000, discretionary: 2000, uncategorized: 2000 }, essentialRatio: 0.6, discretionaryRatio: 0.2, engelCoefficient: 0.55, foodAmount: 5500, foodCount: 1 },
    });
    expect(d.some((x) => x.level === 'warn' && x.title.includes('食品支出占比偏高'))).toBe(true);
  });

  it('可选支出占比高 → 警示结论', () => {
    const d = buildCheckupDiagnosis(healthy, {
      ...baseExtra,
      spendingStructure: { byNature: { essential: 3000, discretionary: 5000, uncategorized: 2000 }, essentialRatio: 0.3, discretionaryRatio: 0.5, engelCoefficient: 0.2, foodAmount: 2000, foodCount: 1 },
    });
    expect(d.some((x) => x.level === 'warn' && x.title.includes('可选支出占比偏高'))).toBe(true);
  });

  it('支出结构健康 → 不生成支出告警', () => {
    const d = buildCheckupDiagnosis(healthy, {
      ...baseExtra,
      spendingStructure: { byNature: { essential: 6000, discretionary: 2000, uncategorized: 2000 }, essentialRatio: 0.6, discretionaryRatio: 0.2, engelCoefficient: 0.4, foodAmount: 4000, foodCount: 1 },
    });
    expect(d.some((x) => x.title.includes('刚性') || x.title.includes('食品') || x.title.includes('可选'))).toBe(false);
  });
});

describe('calcInsuranceCoverage：保障覆盖（责任缺口法）', () => {
  // 年收入 10 万 → 建议保额：寿险 100万 + 意外 100万 + 重疾 50万 + 医疗 100万 = 350万
  const annual = 100000;
  const p = (kind: InsuranceKind, coverage: number, premium = 0) => ({ id: 'x', kind, name: '测试保单', coverage, annualPremium: premium });

  it('无保单 → 综合覆盖率 0，风险等级 risk', () => {
    const c = calcInsuranceCoverage([], annual);
    expect(c.totalRatio).toBe(0);
    expect(c.level).toBe('risk');
    expect(c.policyCount).toBe(0);
  });

  it('年收入为 0（无收入基线）→ 无法估算，totalRatio 为 null', () => {
    const c = calcInsuranceCoverage([p('medical', 1000000)], 0);
    expect(c.totalRatio).toBeNull();
    expect(c.level).toBe('none');
  });

  it('仅配置医疗 100 万 → 覆盖率 = 100/350，风险等级 risk', () => {
    const c = calcInsuranceCoverage([p('medical', 1000000)], annual);
    expect(c.totalRatio).toBeCloseTo(1000000 / 3500000, 5);
    expect(c.level).toBe('risk');
    expect(c.covered.medical).toBe(1000000);
  });

  it('覆盖率达 71.4% → 等级 warn（≥70%）', () => {
    // 寿险 100万 + 重疾 50万 + 医疗 100万 = 250万 → 250/350 ≈ 0.7143
    const c = calcInsuranceCoverage(
      [p('life', 1000000), p('critical', 500000), p('medical', 1000000)],
      annual
    );
    expect(c.totalRatio).toBeCloseTo(2500000 / 3500000, 5);
    expect(c.level).toBe('warn');
  });

  it('四险种配满 → 覆盖率 100%，等级 good', () => {
    const c = calcInsuranceCoverage(
      [p('life', 1000000), p('accident', 1000000), p('critical', 500000), p('medical', 1000000)],
      annual
    );
    expect(c.totalRatio).toBeCloseTo(1, 5);
    expect(c.level).toBe('good');
  });

  it('超配 → 覆盖率超过 100%，仍为 good', () => {
    // 医疗 200万 + 寿险 100万 + 意外 100万 + 重疾 50万 = 450万 > 建议合计 350万
    const c = calcInsuranceCoverage(
      [p('medical', 2000000), p('life', 1000000), p('accident', 1000000), p('critical', 500000)],
      annual
    );
    expect(c.totalRatio).toBeCloseTo(4500000 / 3500000, 5);
    expect(c.level).toBe('good');
  });

  it('同险种多份保单保额累加，年缴保费合计（负数保费按 0 计）', () => {
    const c = calcInsuranceCoverage(
      [p('medical', 600000, 800), p('medical', 400000, 500), p('life', 1000000, -100)],
      annual
    );
    expect(c.covered.medical).toBe(1000000);
    expect(c.totalPremium).toBe(1300);
    expect(c.policyCount).toBe(3);
  });
});

describe('buildCheckupDiagnosis：保障覆盖诊断', () => {
  const healthy: CheckupMetrics = {
    totalIncome: 11000, laborIncomeRatio: 0.8, incomeSourceCount: 3,
    totalDebt: 20000, dsr: 0.2, shortTermDebtRatio: 0.2,
    netSavingRate: 0.3, liquidityMonths: 6, insuranceCoverage: 0,
  };
  const mkInsurance = (totalRatio: number | null): InsuranceCoverage => ({
    annualIncome: 120000,
    covered: { life: 0, critical: 0, medical: 0, accident: 0 },
    suggested: { life: 0, critical: 0, medical: 0, accident: 0 },
    totalRatio, level: 'none', policyCount: 0, totalPremium: 0,
  });

  it('无保单（覆盖率 0）→ 风险结论「尚未配置保障」', () => {
    const d = buildCheckupDiagnosis(healthy, { insurance: mkInsurance(0) });
    expect(d.some((x) => x.level === 'risk' && x.title.includes('尚未配置保障'))).toBe(true);
  });

  it('覆盖率 30% → 风险结论「保障缺口较大」', () => {
    const d = buildCheckupDiagnosis(healthy, { insurance: mkInsurance(0.3) });
    expect(d.some((x) => x.level === 'risk' && x.title.includes('保障缺口较大'))).toBe(true);
  });

  it('覆盖率 80% → 警示结论「保障覆盖待补充」', () => {
    const d = buildCheckupDiagnosis(healthy, { insurance: mkInsurance(0.8) });
    expect(d.some((x) => x.level === 'warn' && x.title.includes('保障覆盖待补充'))).toBe(true);
  });

  it('覆盖率 120% → 良好结论「保障配置充足」', () => {
    const d = buildCheckupDiagnosis(healthy, { insurance: mkInsurance(1.2) });
    expect(d.some((x) => x.level === 'good' && x.title.includes('保障配置充足'))).toBe(true);
  });

  it('无法估算（覆盖率 null）→ 不生成保障结论，避免误导', () => {
    const d = buildCheckupDiagnosis(healthy, { insurance: mkInsurance(null) });
    expect(d.some((x) => x.title.includes('保障'))).toBe(false);
  });
});

describe('calcNetAssetGrowth：净资产成长性', () => {
  it('有去年同期记录 → 参考取去年同月，成长率 = (当前−参考)/|参考|，覆盖 13 个月', () => {
    const g = calcNetAssetGrowth(130000, [
      { month: '2025-09', net_worth: 90000 },
      { month: '2025-10', net_worth: 110000 },
      { month: '2026-09', net_worth: 125000 },
    ], '2026-10');
    expect(g.baseMonth).toBe('2025-10');
    expect(g.baseNet).toBe(110000);
    expect(g.growthRate).toBeCloseTo(20000 / 110000, 5);
    expect(g.monthsCovered).toBe(13);
    expect(g.level).toBe('good');
  });

  it('记账不足一年 → 回退到最早记录作参考，覆盖月数 < 12', () => {
    const g = calcNetAssetGrowth(50000, [{ month: '2026-06', net_worth: 30000 }], '2026-10');
    expect(g.baseMonth).toBe('2026-06');
    expect(g.monthsCovered).toBe(5);
    expect(g.growthRate).toBeCloseTo(20000 / 30000, 5);
    expect(g.level).toBe('good');
  });

  it('净资产较参考缩水 → warn', () => {
    const g = calcNetAssetGrowth(90000, [{ month: '2025-10', net_worth: 100000 }], '2026-10');
    expect(g.growthRate).toBeCloseTo(-10000 / 100000, 5);
    expect(g.level).toBe('warn');
  });

  it('净资产为负 → risk（参考为负时仍用绝对值作分母）', () => {
    const g = calcNetAssetGrowth(-5000, [{ month: '2025-10', net_worth: -20000 }], '2026-10');
    expect(g.growthRate).toBeCloseTo(15000 / 20000, 5);
    expect(g.level).toBe('risk');
  });

  it('参考净资产约等于 0 → 成长率无法估算 → none', () => {
    const g = calcNetAssetGrowth(1000, [{ month: '2025-10', net_worth: 0 }], '2026-10');
    expect(g.growthRate).toBeNull();
    expect(g.level).toBe('none');
  });

  it('无历史记录 → 成长率 null；净资产非负 → none', () => {
    const g = calcNetAssetGrowth(5000, [], '2026-10');
    expect(g.growthRate).toBeNull();
    expect(g.monthsCovered).toBe(0);
    expect(g.level).toBe('none');
  });

  it('无历史记录但净资产为负 → 仍按风险提示', () => {
    const g = calcNetAssetGrowth(-5000, [], '2026-10');
    expect(g.level).toBe('risk');
  });
});

describe('buildCheckupDiagnosis：净资产成长性诊断', () => {
  const healthy: CheckupMetrics = {
    totalIncome: 11000, laborIncomeRatio: 0.8, incomeSourceCount: 3,
    totalDebt: 20000, dsr: 0.2, shortTermDebtRatio: 0.2,
    netSavingRate: 0.3, liquidityMonths: 6, insuranceCoverage: null,
  };

  it('净资产增长 → 良好结论「净资产稳步增长」', () => {
    const d = buildCheckupDiagnosis(healthy, {
      netAssetGrowth: { currentNet: 130000, baseNet: 110000, baseMonth: '2025-10', growthRate: 0.1818, monthsCovered: 13, level: 'good' },
    });
    expect(d.some((x) => x.level === 'good' && x.title.includes('净资产'))).toBe(true);
  });

  it('净资产缩水 → 警示结论', () => {
    const d = buildCheckupDiagnosis(healthy, {
      netAssetGrowth: { currentNet: 90000, baseNet: 100000, baseMonth: '2025-10', growthRate: -0.1, monthsCovered: 13, level: 'warn' },
    });
    expect(d.some((x) => x.level === 'warn' && x.title.includes('净资产'))).toBe(true);
  });

  it('净资产为负 → 风险结论「净资产为负」', () => {
    const d = buildCheckupDiagnosis(healthy, {
      netAssetGrowth: { currentNet: -5000, baseNet: -20000, baseMonth: '2025-10', growthRate: 0.75, monthsCovered: 13, level: 'risk' },
    });
    expect(d.some((x) => x.level === 'risk' && x.title.includes('净资产为负'))).toBe(true);
  });

  it('无参考数据（growthRate null 且净资产非负）→ 不生成结论避免误导', () => {
    const d = buildCheckupDiagnosis(healthy, {
      netAssetGrowth: { currentNet: 5000, baseNet: 0, baseMonth: '', growthRate: null, monthsCovered: 0, level: 'none' },
    });
    expect(d.some((x) => x.title.includes('净资产'))).toBe(false);
  });
});

describe('calcEmergencyFund：应急储备达成进度', () => {
  it('达标（流动资产 ≥ 6 个月目标）→ progress ≥ 1，缺口 0，good', () => {
    const e = calcEmergencyFund(36000, 6000);
    expect(e.targetAmount).toBe(36000);
    expect(e.coverageMonths).toBe(6);
    expect(e.progress).toBe(1);
    expect(e.shortfall).toBe(0);
    expect(e.level).toBe('good');
  });

  it('储备过半（3 个月）→ warn，缺口 = 目标 − 流动资产', () => {
    const e = calcEmergencyFund(18000, 6000);
    expect(e.coverageMonths).toBe(3);
    expect(e.progress).toBe(0.5);
    expect(e.shortfall).toBe(18000);
    expect(e.level).toBe('warn');
  });

  it('不足一半（1 个月）→ risk', () => {
    const e = calcEmergencyFund(6000, 6000);
    expect(e.progress).toBeCloseTo(1 / 6, 5);
    expect(e.level).toBe('risk');
  });

  it('自定义目标月数（如 3 个月）→ 目标金额随之变化', () => {
    const e = calcEmergencyFund(15000, 5000, 3);
    expect(e.targetMonths).toBe(3);
    expect(e.targetAmount).toBe(15000);
    expect(e.progress).toBe(1);
    expect(e.level).toBe('good');
  });

  it('月均支出为 0（无支出记录）→ 覆盖月数 null、进度 null、无法估算', () => {
    const e = calcEmergencyFund(10000, 0);
    expect(e.coverageMonths).toBeNull();
    expect(e.progress).toBeNull();
    expect(e.shortfall).toBe(0);
    expect(e.level).toBe('none');
  });
});

describe('buildCheckupDiagnosis：应急储备达成进度诊断', () => {
  const healthy: CheckupMetrics = {
    totalIncome: 11000, laborIncomeRatio: 0.8, incomeSourceCount: 3,
    totalDebt: 20000, dsr: 0.2, shortTermDebtRatio: 0.2,
    netSavingRate: 0.3, liquidityMonths: 6, insuranceCoverage: null,
  };

  it('达标 → 良好结论「应急储备目标已达成」', () => {
    const d = buildCheckupDiagnosis(healthy, {
      emergencyFund: { liquidAssets: 36000, targetMonths: 6, targetAmount: 36000, coverageMonths: 6, progress: 1, shortfall: 0, level: 'good' },
    });
    expect(d.some((x) => x.level === 'good' && x.title.includes('应急储备目标已达成'))).toBe(true);
  });

  it('储备过半 → 警示结论「应急储备过半」', () => {
    const d = buildCheckupDiagnosis(healthy, {
      emergencyFund: { liquidAssets: 18000, targetMonths: 6, targetAmount: 36000, coverageMonths: 3, progress: 0.5, shortfall: 18000, level: 'warn' },
    });
    expect(d.some((x) => x.level === 'warn' && x.title.includes('应急储备过半'))).toBe(true);
  });

  it('缺口较大 → 风险结论「应急储备缺口较大」', () => {
    const d = buildCheckupDiagnosis(healthy, {
      emergencyFund: { liquidAssets: 6000, targetMonths: 6, targetAmount: 36000, coverageMonths: 1, progress: 1 / 6, shortfall: 30000, level: 'risk' },
    });
    expect(d.some((x) => x.level === 'risk' && x.title.includes('应急储备缺口较大'))).toBe(true);
  });

  it('无法估算（progress null）→ 不生成进度类结论避免误导', () => {
    const d = buildCheckupDiagnosis(healthy, {
      emergencyFund: { liquidAssets: 10000, targetMonths: 6, targetAmount: 0, coverageMonths: null, progress: null, shortfall: 0, level: 'none' },
    });
    // 注意：healthy 会触发「应急储备充足」流动性结论，这里只断言不生成「进度/缺口」类结论
    expect(d.some((x) => ['应急储备目标已达成', '应急储备过半', '应急储备缺口较大'].includes(x.title))).toBe(false);
  });
});
