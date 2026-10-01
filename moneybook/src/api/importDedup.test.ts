/**
 * 批量导入去重（bulkImportTransactions）单元测试。
 * mock db 层的 orders：已存在订单号 ORDER1，验证同单号/批内同单号会被拦截跳过并计入 duplicates。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeMock, selectMock } = vi.hoisted(() => ({
  executeMock: vi.fn(async (_sql: unknown, _params: unknown[] = []) => ({ rowsAffected: 1, lastInsertId: 100 }),
  ),
  selectMock: vi.fn(async (sql: unknown, _params: unknown[] = []) => {
    const s = String(sql);
    if (s.includes('FROM accounts')) return [];
    if (s.includes('FROM categories')) return [{ id: 1, name: '餐饮', type: 'expense' }];
    if (s.includes('FROM transactions')) return [{ order_no: 'ORDER1' }]; // 库里已存在该订单
    return [];
  }),
}));

vi.mock('./db', () => ({
  execute: (sql: unknown, params: unknown[]) => executeMock(sql, params),
  select: (sql: unknown, params: unknown[]) => selectMock(sql, params),
  runInTransaction: (fn: () => unknown) => fn(),
}));
vi.mock('./accounts', () => ({ listAccounts: async () => [] }));
vi.mock('./categories', () => ({ listCategories: async () => [] }));

import { bulkImportTransactions, type ImportRow } from './import';

beforeEach(() => {
  executeMock.mockClear();
  selectMock.mockClear();
});

const base = (line: number, orderNo?: string): ImportRow => ({
  line, date: '2026-09-01', type: 'expense', amount: 35.5, account: '微信', note: '午餐', orderNo,
});

describe('bulkImportTransactions：重复导入去重', () => {
  it('订单号已在库中的行被跳过并计入 duplicates', async () => {
    const rows = [base(1, 'ORDER1'), base(2, 'ORDER2')]; // ORDER1 在库
    const res = await bulkImportTransactions(rows, { autoCreate: true });
    expect(res.imported).toBe(1);
    expect(res.duplicates).toBe(1);
    expect(res.skipped[0].reason).toContain('疑似重复');
  });

  it('批内出现重复订单号仅落库一次', async () => {
    const rows = [base(1, 'N1'), base(2, 'N1')]; // 批内同单号
    const res = await bulkImportTransactions(rows, { autoCreate: true });
    expect(res.imported).toBe(1);
    expect(res.duplicates).toBe(1);
  });

  it('无订单号且批内同指纹（日期/类型/金额/账户/备注）视为重复', async () => {
    const rows = [base(1), base(2)]; // 无单号、字段完全一致
    const res = await bulkImportTransactions(rows, { autoCreate: true });
    expect(res.imported).toBe(1);
    expect(res.duplicates).toBe(1);
  });

  it('P0 去重：同日同商户同金额但备注不同（如两杯咖啡）不误并', async () => {
    // 指纹包含备注：备注不同则指纹不同 → 各自正常导入，不判重复
    const rows = [
      base(1), // 午餐
      { ...base(2), note: '咖啡' }, // 同天同额同账户，备注不同
    ];
    const res = await bulkImportTransactions(rows, { autoCreate: true });
    expect(res.imported).toBe(2);
    expect(res.duplicates).toBe(0);
  });

  it('P0 去重：同日同商户同金额同备注（确实重复导入）仍判重复并跳过', async () => {
    // 防止把去重改得过保守：完全相同的两行（真重复）应仍被拦截去重
    const rows = [base(1, 'DUP-1'), { ...base(2), date: '2026-09-01', orderNo: 'DUP-1' }];
    const res = await bulkImportTransactions(rows, { autoCreate: true });
    expect(res.imported).toBe(1);
    expect(res.duplicates).toBe(1);
  });
});