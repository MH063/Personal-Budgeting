/**
 * 导入账户解析的「创建失败 ─ lastInsertId 兜底」回归测试。
 *
 * 目标 bug：批量导入时账户已存在却仍尝试创建，且装库驱动偶发取不到 lastInsertId 时，
 * 旧实现直接抛「账户「X」创建失败」，导致整批行被跳过。
 * 修复后：创建 INSERT 即使拿不到 lastInsertId，也会按 (账本, 名称) 回查库复用该账户，
 * 既不重复创建也不误报失败。
 *
 * 本用例通过 mock ./db 让「accMap 查询返回空 + 创建前回查返回空 + INSERT 不返回 lastInsertId」，
 * 但 INSERT 后兜底回查能查到已插入账户 → 断言整批导入成功且不再报「创建失败」。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bulkImportTransactions, type ImportRow } from './import';
import { setCurrentLedger } from '@/lib/ledger';

// 控制 mock 状态的 hoisted 句柄（供 select/execute 与断言共用）
const ctl = vi.hoisted(() => {
  const state = {
    /** 「创建前回查」是否命中（false=库里当前没有该账户，走创建） */
    dupOnPreLookup: false,
    /** 插入后兜底回查能否查到（true=写库成功但拿不到 lastInsertId，靠回查兜底） */
    backOnPostLookup: true,
  };
  return { state };
});

vi.mock('./db', () => {
  // 记录 account 查询次数：0=accMap构建 → 1=创建前回查() → 2=插入后兜底回查(命中)
  let accountNameLookup = 0;
  const HISTORY = { insertedAccounts: 0 } as { insertedAccounts: number };
  return {
    select: async (sql: string, _params: unknown[] = []) => {
      const s = String(sql);
      // 账户相关查询：accMap 构建 / 创建前回查 / 插入后兜底回查
      if (s.includes('FROM accounts') && !s.includes('AND name')) {
        return []; // accMap 完全未命中，逼出创建路径
      }
      if (s.includes('AND name')) {
        accountNameLookup++;
        // 第 1 次为「创建前回查」；第 2 次为「插入后兜底回查」
        if (accountNameLookup === 1 && !ctl.state.dupOnPreLookup) return [];
        if (accountNameLookup >= 2 && !ctl.state.backOnPostLookup) return [];
        return [{ id: 42 }];
      }
      if (s.includes('FROM categories')) return [];
      if (s.includes('FROM transactions')) return [];
      return [];
    },
    execute: async (sql: string, _params: unknown[] = []) => {
      const s = String(sql);
      if (s.includes('INSERT INTO accounts')) {
        HISTORY.insertedAccounts++;
        return { rowsAffected: 1 }; // 故意不返回 lastInsertId（模拟驱动取不到）
      }
      if (s.includes('INSERT INTO transactions')) {
        return { rowsAffected: 1, lastInsertId: HISTORY.insertedAccounts };
      }
      return { rowsAffected: 1 };
    },
    runInTransaction: async (fn: () => unknown) => fn(),
  };
});

function expenseRow(partial?: Partial<ImportRow>): ImportRow {
  return { date: '2026-09-12', type: 'expense', amount: 900, account: '湖北农信储蓄卡(2440)', note: '转账', line: 1, ...partial };
}

describe('bulkImportTransactions：账户创建失败兜底（lastInsertId 缺失回查复用）', () => {
  beforeEach(() => {
    setCurrentLedger(1);
    ctl.state.dupOnPreLookup = false;
    ctl.state.backOnPostLookup = true;
  });

  it('INSERT 拿不到 lastInsertId 时，按 (账本,名称) 回查账户并正常导入，不再误报「创建失败」', async () => {
    ctl.state.backOnPostLookup = true; // 兜底回查能查到已写入账户
    const res = await bulkImportTransactions([expenseRow()], { autoCreate: true });
    expect(res.imported).toBe(1);
    expect(res.skipped).toHaveLength(0);
    expect(res.createdAccounts).toEqual(['湖北农信储蓄卡(2440)']);
  });

  it('insert 拿不到 id 且回查也查不到时，才报「写入失败」（明确提示而非「创建失败」）', async () => {
    ctl.state.backOnPostLookup = false;
    const res = await bulkImportTransactions([expenseRow()], { autoCreate: true });
    expect(res.imported).toBe(0);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toContain('写入失败');
    expect(res.skipped[0].reason).not.toContain('创建失败');
  });
});