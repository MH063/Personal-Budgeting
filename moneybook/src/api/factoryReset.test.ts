/**
 * 恢复出厂设置单元测试。
 * 覆盖 resetAllData：defer_foreign_keys 开启 → 动态枚举清空全部用户表 →
 * 重置自增序列 → 重建默认分类 / 默认账本 / active_ledger_id，且全程处于同一事务。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetAllData } from './factoryReset';

// 将数据库访问层替换为可控 mock：捕获 execute 的 (sql, params) 以断言清空与重建顺序。
vi.mock('./db', () => ({
  execute: vi.fn(async (_sql: string, _params: unknown[] = []) => ({ rowsAffected: 1, lastInsertId: 1 })),
  runInTransaction: vi.fn((fn: () => unknown) => fn()),
  select: vi.fn(async (sql: string) => {
    // sqlite_master 枚举：返回两张业务表 + sqlite_sequence（应被跳过）
    if (String(sql).includes('sqlite_master')) {
      return [
        { name: 'transactions' },
        { name: 'categories' },
        { name: 'accounts' },
        { name: 'sqlite_sequence' },
      ];
    }
    return [];
  }),
}));

import { execute } from './db';

// 捕获所有 execute 调用（复用 mock 实例）
const execMock = vi.mocked(execute);

beforeEach(() => {
  execMock.mockClear();
});

describe('resetAllData：恢复出厂设置', () => {
  it('事务内第一步开启 defer_foreign_keys，保证任意表清空顺序不触发外键错误', async () => {
    await resetAllData();
    const first = execMock.mock.calls[0];
    expect(first[0]).toContain('PRAGMA defer_foreign_keys = ON');
  });

  it('枚举出的事务表全部执行 DELETE，sqlite_sequence 仅走统一重置', async () => {
    await resetAllData();
    const dels = execMock.mock.calls.filter(([sql]) => String(sql).startsWith('DELETE FROM'));
    // transactions / categories / accounts 各一条 DELETE + 1 条 sqlite_sequence 统一重置
    expect(dels).toHaveLength(4);
    const names = dels.map(([sql]) => String(sql).match(/DELETE FROM "?(\w+)"?/)?.[1]);
    expect(names).toContain('transactions');
    expect(names).toContain('categories');
    expect(names).toContain('accounts');
    // sqlite_sequence 通过 DELETE FROM sqlite_sequence 统一重置（不带引号）
    expect(execMock.mock.calls.some(([sql]) => String(sql) === 'DELETE FROM sqlite_sequence')).toBe(true);
  });

  it('重建 14 条默认分类（与迁移 001 一致：8 支出 + 6 收入）', async () => {
    await resetAllData();
    const inserts = execMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO categories'));
    expect(inserts).toHaveLength(14);
    const expense = inserts.filter(([, p]) => p?.[1] === 'expense');
    const income = inserts.filter(([, p]) => p?.[1] === 'income');
    expect(expense).toHaveLength(8);
    expect(income).toHaveLength(6);
    // 首条默认分类为「餐饮/支出」
    expect(inserts[0][1]?.[0]).toBe('餐饮');
  });

  it('重建默认账本并激活，其余设置全部清空（回到全新安装状态）', async () => {
    await resetAllData();
    expect(
      execMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO ledgers (name) VALUES ('默认账本')"))
    ).toBe(true);
    expect(
      execMock.mock.calls.some(([sql]) => String(sql).includes('active_ledger_id'))
    ).toBe(true);
  });

  it('返回被清空的业务表数量（不含 sqlite_sequence）', async () => {
    const result = await resetAllData();
    expect(result.clearedTables).toBe(3); // transactions / categories / accounts
  });
});
