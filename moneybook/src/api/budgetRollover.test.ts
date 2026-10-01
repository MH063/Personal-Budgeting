/**
 * 预算滚动收口（ensureBudgetCurrentPeriod）单元测试。
 * 采用 mock db 层验证：
 *  - 无异常行时零写入（滚动由动态结转承载，不硬固化期间）；
 *  - 存在"未来起点"的月度预算行时，将其 start_date 幂等归一收口到当前月首日；
 *  - 同一个月内的未来日（如当月 15 号）不重复写入。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import dayjs from 'dayjs';

const execMock = vi.fn();
const selectMock = vi.fn();

vi.mock('@/api/db', () => ({
  execute: (...args: unknown[]) => execMock(...args),
  select: (...args: unknown[]) => selectMock(...args),
}));

vi.mock('@/lib/ledger', () => ({
  currentLedgerId: () => 1,
}));

import { ensureBudgetCurrentPeriod } from '@/api/budgetRollover';

beforeEach(() => {
  execMock.mockReset();
  selectMock.mockReset();
  selectMock.mockResolvedValue([]);
  execMock.mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
});

const thisMonth = dayjs().format('YYYY-MM');
const firstDay = dayjs(`${thisMonth}-01`).format('YYYY-MM-DD');

describe('ensureBudgetCurrentPeriod：预算滚动收口', () => {
  it('无异常行（正常数据）时不产生任何写操作', async () => {
    selectMock.mockResolvedValue([]);
    await ensureBudgetCurrentPeriod(1);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('存在未来起点的月度预算行时，将 start_date 收口到当前月首日', async () => {
    selectMock.mockResolvedValue([
      { id: 11, start_date: '2099-12-01' },
      { id: 22, start_date: '2100-06-15' },
    ]);
    await ensureBudgetCurrentPeriod(1);
    expect(execMock).toHaveBeenCalledTimes(2);
    const [sql0, params0] = execMock.mock.calls[0] as [string, unknown[]];
    expect(sql0).toContain('UPDATE budgets SET start_date');
    expect(params0[0]).toBe(firstDay);
    expect(params0[1]).toBe(11);
    const params1 = execMock.mock.calls[1][1] as unknown[];
    expect(params1[0]).toBe(firstDay);
    expect(params1[1]).toBe(22);
  });

  it('同一个月内的未来日期（如当月 15 号）视为已收口，不再写入', async () => {
    const withinMonth = dayjs(`${thisMonth}-15`).format('YYYY-MM-DD');
    selectMock.mockResolvedValue([{ id: 5, start_date: withinMonth }]);
    await ensureBudgetCurrentPeriod(1);
    // start_date 所在月 == 当前月 → 跳过
    expect(execMock).not.toHaveBeenCalled();
  });

  it('SELECT 仅筛选 period=monthly、未停用、start_date 大于当前月', async () => {
    await ensureBudgetCurrentPeriod(1);
    const [sql, params] = selectMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("period = 'monthly'");
    expect(sql).toContain('end_date IS NULL');
    expect(sql).toContain('start_date > $2');
    expect(params[0]).toBe(1); // ledger_id
  });
});