/**
 * 支出预测引擎（predict）DB 集成层单元测试。
 * 目标：覆盖核心链路 fetch（取历史）→ build（构造预测）中 34.6% 未测的 DB 分支，
 *     包括空数据、单月、跨年对齐、缺失月补零。mock ./db 的 select。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import dayjs from 'dayjs';
import { buildExpenseForecast } from './predict';

// 控制"当前时间"，使月份窗口（跨年对齐）可精确断言
vi.useFakeTimers();
vi.setSystemTime(new Date(2026, 0, 15)); // 2026-01-15

const { selectMock } = vi.hoisted(() => ({
  selectMock: vi.fn(async (_sql?: unknown, _params?: unknown[]) => [] as unknown[]),
}));

vi.mock('./db', () => ({
  select: (sql: unknown, params: unknown[]) => selectMock(sql, params),
}));
vi.mock('@/lib/ledger', () => ({ currentLedgerId: () => 1 }));

import { fetchMonthlySeries } from './predict';

beforeEach(() => {
  selectMock.mockClear();
});

/** 构造 fetchMonthlySeries 返回的原始行（name/icon/color/ym/amt） */
function row(name: string, ym: string, amt: number, icon = '🍜', color = '#000') {
  return { name, icon, color, ym, amt };
}

describe('fetchMonthlySeries：月份窗口与补零', () => {
  it('窗口=上月往前 N 个自然月：ymList 升序且末位为上月', async () => {
    // 2026-01-15 现在，months=3 → 窗口 2025-10,2025-11,2025-12（含上月，不含当月）
    selectMock.mockResolvedValue([]);
    const { ymList } = await fetchMonthlySeries('expense', 3);
    expect(ymList).toEqual(['2025-10', '2025-11', '2025-12']);
  });

  it('缺失月份补 0，不因某月无记录而错位', async () => {
    // 餐饮只有 10 月与 12 月记录，11 月缺失 → 11 月补 0
    selectMock.mockResolvedValue([row('餐饮', '2025-10', 100), row('餐饮', '2025-12', 150)]);
    const { categories } = await fetchMonthlySeries('expense', 3);
    const c = categories[0];
    expect(c.values).toEqual([100, 0, 150]);
  });
});

describe('buildExpenseForecast：从数据构造预测', () => {
  it('空历史 → total 与分类列表均为空/0，不抛错', async () => {
    selectMock.mockResolvedValue([]);
    const res = await buildExpenseForecast(6);
    expect(res.categories).toEqual([]);
    expect(res.totalLast).toBe(0);
    expect(res.totalPredicted).toBe(0);
  });

  it('只有 1 个月数据 → 仅一条分类预测，sampleMonths=1、可靠度低', async () => {
    // 上月（窗口末位）有数据 → lastActual=300
    selectMock.mockResolvedValue([row('餐饮', '2025-12', 300)]);
    const res = await buildExpenseForecast(6);
    expect(res.categories).toHaveLength(1);
    expect(res.categories[0].name).toBe('餐饮');
    expect(res.categories[0].sampleMonths).toBe(1);
    expect(res.categories[0].reliability).toBeLessThan(0.6);
    expect(res.totalLast).toBe(300);
  });

  it('正常跨年序列 → 用上期结余窗口聚合出 totalLast/totalPredicted', async () => {
    // 餐饮 3 个月 100/120/140；交通 2 个月 50/60（首月缺 → 0）
    selectMock.mockResolvedValue([
      row('餐饮', '2025-10', 100), row('餐饮', '2025-11', 120), row('餐饮', '2025-12', 140),
      row('交通', '2025-11', 50), row('交通', '2025-12', 60),
    ]);
    const res = await buildExpenseForecast(3);
    const names = res.categories.map((c) => c.name);
    expect(names).toContain('餐饮');
    // 交通首月补 0 → 也进入预测
    expect(names).toContain('交通');
    // totalLast = 餐饮 140 + 交通 60 = 200
    expect(res.totalLast).toBe(200);
  });
});