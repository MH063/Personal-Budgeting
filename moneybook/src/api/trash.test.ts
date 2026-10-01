/**
 * 回收站/撤销模块单元测试。
 * 采用 mock db 层验证：删除前快照写入、硬删除（彻底删除/清空）、
 * 恢复依赖预检（账户/分类缺失时抛出可读错误）、预算删除、分类软启用恢复。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— mock 数据访问层与账本（trash.ts 仅依赖 db 与 ledger）——
const execMock = vi.fn();
const selectMock = vi.fn();

vi.mock('@/api/db', () => ({
  execute: (...args: unknown[]) => execMock(...args),
  select: (...args: unknown[]) => selectMock(...args),
  runInTransaction: async (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@/lib/ledger', () => ({
  currentLedgerId: () => 1,
}));

import {
  recordToTrash,
  listTrash,
  purgeTrash,
  clearTrash,
  restoreTrash,
  deleteBudgetSafe,
  TRASH_LABEL,
} from '@/api/trash';

beforeEach(() => {
  execMock.mockReset();
  selectMock.mockReset();
  // 默认 select 返回空数组（无害）
  selectMock.mockResolvedValue([]);
  execMock.mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
});

describe('TRASH_LABEL：实体类型覆盖完整性', () => {
  it('包含全部 8 类实体', () => {
    expect(Object.keys(TRASH_LABEL)).toEqual(
      expect.arrayContaining([
        'transaction', 'account', 'category', 'tag', 'budget', 'savings_goal', 'loan', 'recurring',
      ])
    );
  });

  it('标签均为中文且非空', () => {
    for (const label of Object.values(TRASH_LABEL)) {
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('recordToTrash：删除前快照写入', () => {
  it('写入实体类型/原主键/行快照 JSON（含账本过滤）', async () => {
    await recordToTrash('transaction', 10, { id: 10, amount: 88 }, { tags: [1, 2] });
    expect(execMock).toHaveBeenCalledTimes(1);
    const [sql, params] = execMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO trash');
    expect(params[0]).toBe('transaction');
    expect(params[1]).toBe(10);
    expect(params[2]).toContain('"amount":88'); // ref_object JSON 序列化
    expect(params[3]).toContain('"tags"'); // assoc JSON 序列化
    expect(params[4]).toBe(1); // ledger_id
  });

  it('无关联子记录时 assoc 传 null', async () => {
    await recordToTrash('category', 3, { id: 3, name: '餐饮' });
    const params = execMock.mock.calls[0][1] as unknown[];
    expect(params[3]).toBeNull();
  });
});

describe('listTrash：回收站查询', () => {
  it('listTrash 走 select 且 SQL 含账本过滤', async () => {
    await listTrash();
    expect(selectMock).toHaveBeenCalledTimes(1);
    const sql = String(selectMock.mock.calls[0][0]);
    expect(sql).toContain('SELECT * FROM trash WHERE ledger_id = $1');
    expect(sql).toContain('ORDER BY deleted_at DESC');
    // 参数含当前账本 id
    expect(selectMock.mock.calls[0][1]).toEqual([1]);
  });

  it('listTrash 按实体筛选追加 entity 条件', async () => {
    await listTrash('loan');
    const sql = String(selectMock.mock.calls[0][0]);
    expect(sql).toContain('entity = $2');
    expect(selectMock.mock.calls[0][1]).toEqual([1, 'loan']);
  });
});

describe('purgeTrash / clearTrash：硬删除语义', () => {
  it('purgeTrash 物理删除单条快照（彻底删除，不可恢复）', async () => {
    await purgeTrash(5);
    const [sql, params] = execMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM trash WHERE id = \$\d+/);
    expect(sql).toContain('ledger_id');
    expect(params).toContain(5);
    expect(params).toContain(1); // 当前账本
  });

  it('clearTrash 清空回收站返回删除条数（批量硬删除）', async () => {
    execMock.mockResolvedValueOnce({ rowsAffected: 3 });
    const n = await clearTrash();
    expect(n).toBe(3);
    expect(String(execMock.mock.calls[0][0])).toContain('DELETE FROM trash');
  });

  it('clearTrash 按实体清空时追加 entity 条件', async () => {
    await clearTrash('loan');
    expect(String(execMock.mock.calls[0][0])).toContain('entity = $');
  });
});

describe('deleteBudgetSafe：预算删除进回收站', () => {
  it('先快照后物理删除（同一事务）', async () => {
    selectMock.mockResolvedValueOnce([{ id: 7, category_id: 1, amount: 300, period: 'monthly' }]);
    await deleteBudgetSafe(7);
    expect(execMock.mock.calls.length).toBe(2);
    // 第一步：写快照
    expect(String(execMock.mock.calls[0][0])).toContain('INSERT INTO trash');
    expect((execMock.mock.calls[0][1] as unknown[])[1]).toBe(7);
    // 第二步：物理删除原行
    expect(String(execMock.mock.calls[1][0])).toContain('DELETE FROM budgets');
  });

  it('预算不存在时静默返回不写快照', async () => {
    selectMock.mockResolvedValueOnce([]);
    await deleteBudgetSafe(999);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe('restoreTrash：恢复依赖预检与回插', () => {
  // 模拟回收站记录
  const itemRow = (entity: string, ref: Record<string, unknown>, assoc: unknown = null) => ({
    id: 1,
    entity,
    entity_id: Number(ref.id),
    ref_object: JSON.stringify(ref),
    assoc: assoc != null ? JSON.stringify(assoc) : null,
    deleted_at: '2026-01-01',
    ledger_id: 1,
  });

  it('交易恢复前账户不存在时抛出可读错误（依赖预检）', async () => {
    selectMock.mockResolvedValueOnce([itemRow('transaction', { id: 10, type: 'expense', amount: 88, account_id: 3, category_id: 1 })]);
    // accounts 查询返回空 → 账户缺失
    await expect(restoreTrash(1)).rejects.toThrow(/已不存在/);
    expect(selectMock).toHaveBeenCalled();
  });

  it('交易恢复：依赖存在且回插成功（含余额补偿/虚拟账户）', async () => {
    const item = itemRow('transaction', { id: 10, type: 'expense', amount: 88, account_id: 3, to_account_id: null, category_id: 1, date: '2026-01-05', note: 'x' });
    selectMock
      .mockResolvedValueOnce([item])               // 查 trash 行
      .mockResolvedValue([{ n: 1 }]);              // 依赖存在（accounts/categories COUNT）
    await restoreTrash(1);
    // 依次执行：INSERT transactions → DELETE trash
    const sqls = execMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('INSERT INTO transactions'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM trash'))).toBe(true);
  });

  it('分类恢复为软启用（UPDATE is_active=1）而非重插', async () => {
    selectMock.mockResolvedValueOnce([itemRow('category', { id: 2, name: '餐饮', type: 'expense' })]);
    await restoreTrash(1);
    const sql = String(execMock.mock.calls[0][0]);
    expect(sql).toContain('UPDATE categories');
    expect(sql).toContain('is_active = 1');
  });

  it('账户恢复为回插（INSERT accounts）且无独立依赖预检', async () => {
    selectMock.mockResolvedValueOnce([itemRow('account', { id: 4, name: '现金', balance: 0 })]);
    await restoreTrash(1);
    const sql = String(execMock.mock.calls[0][0]);
    expect(sql).toContain('INSERT INTO accounts');
  });

  it('回收站记录不存在时抛出明确错误', async () => {
    await expect(restoreTrash(404)).rejects.toThrow(/不存在|不属于当前账本/);
  });
});

describe('恢复依赖预检：跨实体覆盖', () => {
  const loanItem = (id: number, ref: Record<string, unknown>) => ({
    id, entity: 'loan', entity_id: Number(ref.id), ref_object: JSON.stringify(ref), assoc: null, deleted_at: '', ledger_id: 1,
  });

  it('借贷恢复：关联账户缺失时阻止', async () => {
    selectMock
      .mockResolvedValueOnce([loanItem(2, { id: 9, account_id: 55 })])
      .mockResolvedValue([]); // accounts COUNT = 0
    await expect(restoreTrash(2)).rejects.toThrow(/关联账户（#55）已不存在/);
  });

  it('储蓄目标恢复：归集账户缺失时阻止', async () => {
    selectMock
      .mockResolvedValueOnce([{
        id: 3, entity: 'savings_goal', entity_id: 6,
        ref_object: JSON.stringify({ id: 6, name: '目标', account_id: 1 }),
        assoc: JSON.stringify({ accounts: [2, 3] }),
        deleted_at: '', ledger_id: 1,
      }])
      .mockResolvedValue([]); // 全部账户查询为空
    // 预检按序：先查 account_id=1（关联账户），为空即报该错误
    await expect(restoreTrash(3)).rejects.toThrow(/关联账户（#1）已不存在/);
  });

  it('周期记账恢复：转入账户缺失时阻止', async () => {
    // 主账户存在（第 1 次 COUNT 返回 1），转入账户缺失
    selectMock
      .mockResolvedValueOnce([{
        id: 4, entity: 'recurring', entity_id: 5,
        ref_object: JSON.stringify({ id: 5, account_id: 1, to_account_id: 2 }),
        assoc: null, deleted_at: '', ledger_id: 1,
      }])
      .mockResolvedValueOnce([{ n: 1 }]) // account_id=1 存在
      .mockResolvedValue([]);           // to_account_id=2 缺失
    await expect(restoreTrash(4)).rejects.toThrow(/转入账户（#2）已不存在/);
  });
});