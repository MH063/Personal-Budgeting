/**
 * 财务体检接口 getFinancialCheckup 的查询集成测试（mock 数据库层，无 Tauri 环境）。
 * 覆盖：
 * - 8+1 个查询并行发出（并发而非串行等待，防止未来被改回串行）；
 * - 各查询的时间窗与参数正确（当月/去年同期/近 6 月/近 12 月/账本过滤）；
 * - 并行结果正确组装为 CheckupResult（均值/覆盖率/现金流/DSR/负债结构/净资产成长/诊断）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getFinancialCheckup } from './stats';
import { select } from './db';
import { getInsurancePolicies } from './insurance';
import { getLedgerInvestmentMarketValue } from './holdings';

// mock 数据库与外部依赖，使 getFinancialCheckup 可在纯 Node 环境运行
vi.mock('./db', () => ({ select: vi.fn() }));
vi.mock('./insurance', () => ({ getInsurancePolicies: vi.fn(() => []) }));
vi.mock('./holdings', () => ({ getLedgerInvestmentMarketValue: vi.fn(async () => 0) }));
vi.mock('@/lib/ledger', () => ({ currentLedgerId: vi.fn(() => 1) }));

const selectMock = vi.mocked(select);
const getInsurancePoliciesMock = vi.mocked(getInsurancePolicies);
const getMarketValueMock = vi.mocked(getLedgerInvestmentMarketValue);

/** 构造一条未结清的分期借贷（用于 DSR 与负债结构断言） */
const loanRow = { direction: 'borrow' as const, counterparty: '测试', note: null, remaining: 48000, periods: 24, date: '2025-01-01', due_date: null };

describe('getFinancialCheckup：查询并行化', () => {
  beforeEach(() => {
    // reset 清空 mockResolvedValueOnce 残留队列，保证各用例相互独立
    vi.resetAllMocks();
    getInsurancePoliciesMock.mockReturnValue([]);
    getMarketValueMock.mockResolvedValue(0);
  });

  it('9 个查询在首个查询未完成前已全部发出（Promise.all 并行）', async () => {
    const sqls: string[] = [];
    let release!: (rows: unknown[]) => void;
    const gate = new Promise<unknown[]>((res) => { release = res; });
    // 所有查询共用同一个未完成 promise：若实现是串行，首个未 resolve 时后续查询根本不会发出
    selectMock.mockImplementation((sql: string) => {
      sqls.push(String(sql).slice(0, 24));
      return gate as never;
    });

    const p = getFinancialCheckup('2026-10');
    // async 函数同步执行到 await Promise.all 时，8 个主查询 + getNetWorthTrend 的首个查询已全部发出
    // （getNetWorthTrend 内部的其余查询依赖首个查询 resolve，故不在此列）
    expect(sqls).toHaveLength(9);
    expect(sqls.every((s) => s.length > 0)).toBe(true);

    release([]); // 放行全部查询（空结果 → 指标归 0）
    const r = await p;
    expect(r.metrics.totalIncome).toBe(0);
    expect(r.metrics.incomeSourceCount).toBe(0);
    // 净资产无历史记录 → 成长率 null（level none）
    expect(r.netAssetGrowth.growthRate).toBeNull();
  });

  it('各查询时间窗与参数正确（当月/去年同期/近6月/近12月）', async () => {
    selectMock.mockResolvedValue([]);
    await getFinancialCheckup('2026-10');
    const calls = selectMock.mock.calls;
    expect(calls).toHaveLength(12);
    // 当月收支合计：BETWEEN 当月首尾
    expect(calls[2][1]).toEqual(['2026-10-01', '2026-10-31', 1]);
    // 去年同期总收入（同比锚点）
    expect(calls[3][1]).toEqual(['2025-10-01', '2025-10-31', 1]);
    // 近 6 个月支出（流动性覆盖分母）
    expect(calls[4][1]).toEqual(['2026-05-01', '2026-10-31', 1]);
    // 近 12 个月收入（DSR 分母与保障覆盖年收入基线）
    expect(calls[5][1]).toEqual(['2025-11-01', '2026-10-31', 1]);
    // 流动资产与未结清借贷仅按账本过滤
    expect(calls[6][1]).toEqual([1]);
    expect(calls[7][1]).toEqual([1]);
    // 借贷查询只取未结清且剩余本金>0，且带负债性质识别字段
    const loansSql = String(calls[7][0]);
    expect(loansSql).toContain("status != 'settled'");
    expect(loansSql).toContain('counterparty');
    // getNetWorthTrend 内部的 4 个查询：资产/负债账户合计、初始余额基线、历史累计序列，均按账本过滤
    expect(String(calls[8][0])).toContain("'cash','bank','ewallet','investment','savings','receivable'");
    expect(calls[8][1]).toEqual([1]);
    expect(String(calls[9][0])).toContain("'credit','payable'");
    expect(calls[9][1]).toEqual([1]);
    expect(String(calls[10][0])).toContain('initial_balance');
    expect(String(calls[11][0])).toContain('SUM(s) OVER (ORDER BY month)');
  });

  it('并行结果正确组装为 CheckupResult（均值/覆盖率/现金流/DSR/负债/净资产/诊断）', async () => {
    selectMock
      .mockResolvedValueOnce([{ name: '工资', total: 8000 }, { name: '基金收益', total: 1000 }]) // 收入分类
      .mockResolvedValueOnce([{ name: '餐饮', total: 3000 }]) // 支出分类
      .mockResolvedValueOnce([{ income: 9000, expense: 3000 }]) // 当月合计
      .mockResolvedValueOnce([{ income: 7000 }]) // 去年同期
      .mockResolvedValueOnce([{ ym: '2026-05', total: 3000 }, { ym: '2026-06', total: 3000 }]) // 近6月支出
      .mockResolvedValueOnce([{ ym: '2026-04', total: 8000 }, { ym: '2026-05', total: 10000 }]) // 近12月收入
      .mockResolvedValueOnce([{ total: 90000 }]) // 流动资产
      .mockResolvedValueOnce([loanRow]) // 未结清借贷
      // getNetWorthTrend：资产 150000、负债 -20000（欠款转正 20000）、初始基线 100000、去年同月累计净变化 10000
      .mockResolvedValueOnce([{ total: 150000 }]) // 资产类账户合计
      .mockResolvedValueOnce([{ total: -20000 }]) // 负债类账户合计
      .mockResolvedValueOnce([{ base: 100000 }]) // 净资产起始基线
      .mockResolvedValueOnce([{ month: '2025-10', net_change: 10000 }]); // 历史累计序列

    const r = await getFinancialCheckup('2026-10');

    // 当月合计与同比
    expect(r.metrics.totalIncome).toBe(9000);
    expect(r.lastYearIncome).toBe(7000);
    // 流动性 = 流动资产 / 近6月月均支出 = 90000 / 3000 = 30 个月
    expect(r.metrics.liquidityMonths).toBeCloseTo(30, 5);
    // DSR = 月供（48000/24=2000）÷ 月均收入 9000
    expect(r.metrics.dsr).toBeCloseTo(2000 / 9000, 5);
    // 现金流三分：工资→经营收入 8000，基金收益→投资收入 1000，餐饮→经营支出 3000
    expect(r.cashFlow.income.operating).toBe(8000);
    expect(r.cashFlow.income.investing).toBe(1000);
    expect(r.cashFlow.net.operating).toBe(5000);
    // 负债结构：借贷归「其他」，到期分布合计 = 剩余本金
    expect(r.debtStructure.maturity.reduce((a, b) => a + b.total, 0)).toBe(48000);
    // 保障覆盖：无保单 → 覆盖率 0（年收入基线 9000*12=108000）
    expect(r.insurance.totalRatio).toBe(0);
    expect(r.metrics.insuranceCoverage).toBe(0);
    // 净资产成长性：当前净资产 = 150000 − 20000 = 130000；参考 2025-10 = 100000 + 10000 = 110000
    expect(r.netAssetGrowth.currentNet).toBe(130000);
    expect(r.netAssetGrowth.baseMonth).toBe('2025-10');
    expect(r.netAssetGrowth.growthRate).toBeCloseTo(20000 / 110000, 5);
    expect(r.netAssetGrowth.level).toBe('good');
    // 应急储备达成进度：流动资产 90000 ÷ 目标（3000 × 6 = 18000）= 500% 达标，可覆盖 30 个月
    expect(r.emergencyFund.liquidAssets).toBe(90000);
    expect(r.emergencyFund.targetAmount).toBe(18000);
    expect(r.emergencyFund.coverageMonths).toBeCloseTo(30, 5);
    expect(r.emergencyFund.progress).toBe(5);
    expect(r.emergencyFund.level).toBe('good');
    // 诊断包含「尚未配置保障」风险结论、「净资产稳步增长」与「应急储备目标已达成」良好结论
    expect(r.diagnosis.some((d) => d.level === 'risk' && d.title.includes('尚未配置保障'))).toBe(true);
    expect(r.diagnosis.some((d) => d.level === 'good' && d.title.includes('净资产稳步增长'))).toBe(true);
    expect(r.diagnosis.some((d) => d.level === 'good' && d.title.includes('应急储备目标已达成'))).toBe(true);
  });
});
