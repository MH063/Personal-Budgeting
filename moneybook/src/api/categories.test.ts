/**
 * 分类模块单元测试。
 * 覆盖 createCategory 幂等防重：同名同类型且未删除（is_active=1）时直接复用已有 id，
 * 不再新建一行（历史缺陷：手动/导入自动创建无查重导致分类成对重复/多余分类膨胀）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCategory } from './categories';

// 数据库层 mock：select 捕获 SQL 用于断言查重；execute 返回可控 lastInsertId
vi.mock('./db', () => ({
  execute: vi.fn(async (_sql: string, _params: unknown[] = []) => ({ rowsAffected: 1, lastInsertId: 99 })),
  select: vi.fn(async (_sql: string) => []),
  runInTransaction: vi.fn((fn: () => unknown) => fn()),
}));

import { execute, select } from './db';

const execMock = vi.mocked(execute);
const selectMock = vi.mocked(select);

beforeEach(() => {
  execMock.mockClear();
  // 默认查重结果为空（无同名分类）；个别用例用 mockImplementation 覆盖
  selectMock.mockImplementation(async () => []);
});

describe('createCategory：幂等防重创建', () => {
  it('库中已存在同名同类型且未删除的分类 → 直接复用其 id，不执行 INSERT', async () => {
    // 预置：库中有 is_active=1 的「餐饮/expense」
    selectMock.mockImplementation(async (sql: string) =>
      String(sql).includes('is_active = 1') ? [{ id: 7 }] : []
    );
    const id = await createCategory({ name: '餐饮', type: 'expense', icon: '🍜', color: '#EF4444' });
    expect(id).toBe(7);
    // 只发生一次查重 SELECT，没有任何 INSERT
    expect(execMock).not.toHaveBeenCalled();
  });

  it('库中无同名分类 → 正常 INSERT 并返回新建 id', async () => {
    const id = await createCategory({ name: '旅行', type: 'expense' });
    expect(id).toBe(99);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(String(execMock.mock.calls[0][0])).toContain('INSERT INTO categories');
    // 新建前仍先执行查重 SELECT
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('同名分类已被软删除（is_active=0）→ 视为可重建，允许创建新行', async () => {
    // 库里只有软删除行：查重（is_active=1）查不到 → 走 INSERT
    const id = await createCategory({ name: '通讯', type: 'expense' });
    expect(id).toBe(99);
    expect(execMock).toHaveBeenCalledTimes(1);
  });
});
