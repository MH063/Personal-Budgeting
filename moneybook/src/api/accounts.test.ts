/**
 * 账户合并（mergeAccounts）单元测试。
 * 覆盖：同类型成功合并（交易/余额迁移与来源删除）、自环拒绝、类型不一致拒绝、跨账本拒绝。
 * 将 db 层与 syncVirtualAccounts 替换为可控 mock，捕获 execute 调用以断言合并 SQL 正确。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeMock, selectMock, syncMock, flowMock } = vi.hoisted(() => ({
  executeMock: vi.fn(async (_sql: unknown, _params: unknown[] = []) => ({ rowsAffected: 1, lastInsertId: 1 })),
  selectMock: vi.fn(async (_sql: unknown, params: unknown[] = []) => {
    const id = params[0] as number;
    const rows: Record<number, Record<string, unknown>> = {
      1: { id: 1, name: '招商银行卡(1055)', type: 'bank', balance: 300, ledger_id: 1 },
      2: { id: 2, name: '招商银行卡(6222)', type: 'bank', balance: 200, ledger_id: 1 },
      3: { id: 3, name: '花呗', type: 'credit', balance: -100, ledger_id: 1 },
      4: { id: 4, name: '另一账本现金', type: 'cash', balance: 0, ledger_id: 2 },
    };
    return rows[id] ? [rows[id]] : [];
  }),
  syncMock: vi.fn(async () => {}),
  // 账户「流水净影响」：由 transactions.getAccountNetFlow 提供，测试中按需给定
  flowMock: vi.fn(async () => 0),
}));

vi.mock('./db', () => ({
  execute: (sql: unknown, params: unknown[]) => executeMock(sql, params),
  select: (sql: unknown, params: unknown[]) => selectMock(sql, params),
  runInTransaction: (fn: () => unknown) => fn(),
}));
vi.mock('./transactions', () => ({
  syncVirtualAccounts: () => syncMock(),
  getAccountNetFlow: () => flowMock(),
}));

import { mergeAccounts, updateAccount, deleteAccount, zeroAccountBalance } from './accounts';

beforeEach(() => {
  executeMock.mockClear();
  selectMock.mockClear();
  syncMock.mockClear();
  flowMock.mockClear();
  flowMock.mockResolvedValue(0);
});

describe('mergeAccounts：账户合并', () => {
  it('同类型成功合并：迁移交易入/出账方、删来源、累加余额并刷新虚拟账户', async () => {
    await expect(mergeAccounts(1, 2)).resolves.toBeUndefined();
    // 交易出账方与入账方都从 1 迁到 2
    expect(executeMock).toHaveBeenCalledWith(
      'UPDATE transactions SET account_id = $1 WHERE account_id = $2', [2, 1]
    );
    expect(executeMock).toHaveBeenCalledWith(
      'UPDATE transactions SET to_account_id = $1 WHERE to_account_id = $2', [2, 1]
    );
    // 来源余额 300 并入目标 200 → 目标余额累加 +300
    expect(executeMock).toHaveBeenCalledWith(
      'UPDATE accounts SET balance = balance + $1 WHERE id = $2', [300, 2]
    );
    // 删除来源账户
    expect(executeMock).toHaveBeenCalledWith('DELETE FROM accounts WHERE id = $1', [1]);
    // 同步虚拟账户（应收/应付）
    expect(syncMock).toHaveBeenCalledTimes(1);
  });

  it('自环（fromId === toId）直接拒绝', async () => {
    await expect(mergeAccounts(1, 1)).rejects.toThrow('自身');
  });

  it('类型不一致拒绝：禁止现金/银行吞掉信用卡负债', async () => {
    await expect(mergeAccounts(1, 3)).rejects.toThrow('类型不同');
  });

  it('跨账本拒绝：防止串账', async () => {
    await expect(mergeAccounts(1, 4)).rejects.toThrow('同一账本');
  });
});

describe('updateAccount：账户金额（当前余额）可编辑', () => {
  it('修改余额时按流水净额反推初始余额，使重算保持幂等', async () => {
    // 该账户流水净影响 +50（如已记一笔收入 50）：用户把余额校正为 1200
    // → 初始余额 = 1200 − 50 = 1150，保证「初始 + Σ流水 = 当前余额」恒等式
    flowMock.mockResolvedValueOnce(50);
    await updateAccount(5, { balance: 1200 });
    expect(executeMock).toHaveBeenCalledWith(
      'UPDATE accounts SET balance = $1, initial_balance = $2 WHERE id = $3',
      [1200, 1150, 5]
    );
  });

  it('无流水账户：初始余额等于所填余额', async () => {
    flowMock.mockResolvedValueOnce(0);
    await updateAccount(7, { balance: 800 });
    expect(executeMock).toHaveBeenCalledWith(
      'UPDATE accounts SET balance = $1, initial_balance = $2 WHERE id = $3',
      [800, 800, 7]
    );
  });

  it('仅改名时不触碰余额/初始余额字段', async () => {
    await updateAccount(5, { name: '新名字' });
    const sqls = executeMock.mock.calls.map((c) => String(c[0]));
    expect(sqls).toContain('UPDATE accounts SET name = $1 WHERE id = $2');
    expect(sqls.some((s) => s.includes('initial_balance'))).toBe(false);
  });

  it('更正零：允许把余额明确改为 0（不被当作“无变更”忽略）', async () => {
    flowMock.mockResolvedValueOnce(-30);
    await updateAccount(9, { balance: 0 });
    expect(executeMock).toHaveBeenCalledWith(
      'UPDATE accounts SET balance = $1, initial_balance = $2 WHERE id = $3',
      [0, 30, 9]
    );
  });
});

describe('账户删除：余额必须先归零，避免资产凭空消失', () => {
  it('余额不为 0 时拒绝删除，并给出可操作的提示', async () => {
    // 账户 1 余额 300（见 mock），直接删除应被拒绝
    await expect(deleteAccount(1)).rejects.toThrow('不能直接删除');
    // 且不得真的执行删除
    const sqls = executeMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.startsWith('DELETE FROM accounts'))).toBe(false);
  });

  it('余额为 0 时允许删除（写入回收站快照后物理删除）', async () => {
    // 账户 4 余额 0
    await expect(deleteAccount(4)).resolves.toBeUndefined();
    const sqls = executeMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('INSERT INTO trash'))).toBe(true);
    expect(sqls).toContain('DELETE FROM accounts WHERE id = $1');
  });
});

describe('zeroAccountBalance：删除前清零并留下审计痕迹', () => {
  it('把余额置 0、初始余额反推为 −Σ流水（保证重算不回退），并写入账户调整审计', async () => {
    flowMock.mockResolvedValueOnce(250); // 该账户流水净影响 +250
    // 账户 1 当前余额 300；清零后初始余额应反推为 −Σ流水 = −250
    const before = await zeroAccountBalance(1);
    expect(before).toBe(300);
    expect(executeMock).toHaveBeenCalledWith(
      'UPDATE accounts SET balance = 0, initial_balance = $1 WHERE id = $2',
      [-250, 1]
    );
    const sqls = executeMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('ai_audit_log'))).toBe(true);
  });

  it('余额已是 0 时不做任何写入（幂等）', async () => {
    const before = await zeroAccountBalance(4); // 账户 4 余额 0
    expect(before).toBe(0);
    expect(executeMock).not.toHaveBeenCalled();
  });
});