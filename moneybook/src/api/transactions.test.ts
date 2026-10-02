/**
 * 交易入参统一校验单元测试。
 * 覆盖 validateTxPayload：类型/金额/账户/日期/转账转入账户的合法性与错误提示。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateTxPayload, resolveBookDate, createTransaction, updateTransaction, recalcAccountBalances, type TxPayload } from './transactions';
import { execute, select } from './db';
import { setCurrentLedger } from '@/lib/ledger';

// 将数据库访问层替换为可控 mock：捕获 execute 的 (sql, params) 以断言 SQL 拼写，
// 并让 create/update 走完整链路（余额补偿/虚拟账户/标签）而不真实写库。
vi.mock('./db', () => ({
  execute: vi.fn(async (_sql: string, _params: unknown[] = []) => ({ rowsAffected: 1, lastInsertId: 7 })),
  runInTransaction: vi.fn((fn: () => unknown) => fn()),
  select: vi.fn(async (sql: string) => {
    if (String(sql).includes('FROM accounts WHERE id')) {
      return [{ name: '测试现金', type: 'cash', balance: 1000 }];
    }
    if (String(sql).includes('SUM(remaining)')) {
      return [{ total: 0 }];
    }
    if (String(sql).includes('FROM transactions WHERE id')) {
      return [{ id: 5, type: 'expense', amount: 50, category_id: null, account_id: 1, to_account_id: null, loan_id: null, date: '2026-09-27', note: '午餐', pay_time: null, pay_method: null, payee: null, order_no: null, merchant_order_no: null, created_at: '', updated_at: '' }];
    }
    return [];
  }),
}));

const valid: TxPayload = {
  type: 'expense',
  amount: 50,
  accountId: 1,
  date: '2026-09-27',
  note: '午餐',
};

describe('validateTxPayload：交易入参统一校验', () => {
  it('合法入参返回 null', () => {
    expect(validateTxPayload(valid)).toBeNull();
  });

  it('金额为 0 / 负数 / NaN / 非数 均拒绝', () => {
    expect(validateTxPayload({ ...valid, amount: 0 })).toContain('金额');
    expect(validateTxPayload({ ...valid, amount: -5 })).toContain('金额');
    expect(validateTxPayload({ ...valid, amount: NaN })).toContain('金额');
    expect(validateTxPayload({ ...valid, amount: Infinity })).toContain('金额');
  });

  it('账户为空 / 非正整数 拒绝', () => {
    expect(validateTxPayload({ ...valid, accountId: 0 })).toContain('账户');
    expect(validateTxPayload({ ...valid, accountId: -1 })).toContain('账户');
  });

  it('日期缺失 / 格式非法 / 不可解析 拒绝', () => {
    expect(validateTxPayload({ ...valid, date: '' })).toContain('日期');
    expect(validateTxPayload({ ...valid, date: '2026/09/27' })).toContain('日期');
    expect(validateTxPayload({ ...valid, date: 'hello' })).toContain('日期');
  });

  it('未知类型拒绝', () => {
    expect(validateTxPayload({ ...valid, type: 'unknown' as TxPayload['type'] })).toContain('类型');
  });

  it('转账必须指定转入账户', () => {
    expect(validateTxPayload({ ...valid, type: 'transfer', toAccountId: undefined })).toContain('转账');
    expect(validateTxPayload({ ...valid, type: 'transfer', toAccountId: 0 })).toContain('转账');
    expect(validateTxPayload({ ...valid, type: 'transfer', toAccountId: 2 })).toBeNull();
  });

  it('转账自环（出账=转入）被后端拦截', async () => {
    await expect(
      createTransaction({ ...valid, type: 'transfer', accountId: 1, toAccountId: 1 })
    ).rejects.toThrow('转账账户与转入账户不能相同');
  });

  it('正常转账（不同账户）走完整链路成功', async () => {
    await expect(
      createTransaction({ ...valid, type: 'transfer', accountId: 1, toAccountId: 2, amount: 100 })
    ).resolves.toBe(7);
  });

  it('非对象入参拒绝', () => {
    expect(validateTxPayload(undefined as unknown as TxPayload)).toContain('参数');
  });
});

describe('validateTxPayload：交易 5 个扩展字段（支付回填）校验', () => {
  it('携带 payTime/payMethod/payee/orderNo/merchantOrderNo 的可选字符串时校验通过', () => {
    const withExt: TxPayload = {
      ...valid,
      payTime: '2026-09-27 12:03',
      payMethod: '微信支付',
      payee: '某某餐饮店',
      orderNo: '20260927123456789012',
      merchantOrderNo: 'S123456789',
    };
    expect(validateTxPayload(withExt)).toBeNull();
  });

  it('5 个字段缺省或为空字符串时同样校验通过（全可选）', () => {
    expect(validateTxPayload(valid)).toBeNull();
    expect(validateTxPayload({ ...valid, payTime: '', payMethod: '', payee: '', orderNo: '', merchantOrderNo: '' })).toBeNull();
  });

  it('5 个字段为纯空白字符串时也通过校验（提交层再统一清除为空）', () => {
    expect(validateTxPayload({ ...valid, payee: '   ', merchantOrderNo: '  ' })).toBeNull();
  });
});

describe('resolveBookDate：日期与支付时间联动', () => {
  it('date 缺失时用 payTime 的日期部分补全（保证记账日=支付日）', () => {
    expect(resolveBookDate('', '2026-09-27 19:02:40')).toBe('2026-09-27');
    expect(resolveBookDate(undefined, '2026-09-27 18:30')).toBe('2026-09-27');
  });

  it('payTime 只含日期（无时间）也能补全', () => {
    expect(resolveBookDate('', '2026-09-27')).toBe('2026-09-27');
  });

  it('date 已有值时保持不变（payTime 不反向覆盖记账日）', () => {
    expect(resolveBookDate('2026-09-28', '2026-09-27 19:02')).toBe('2026-09-28');
  });

  it('payTime 无效/无日期时不强行补全，返回空串（由上层校验兜底）', () => {
    expect(resolveBookDate('', '19:02')).toBe('');
    expect(resolveBookDate('', '123456')).toBe('');
  });

  it('date 与 payTime 均为空时返回空串', () => {
    expect(resolveBookDate('', '')).toBe('');
    expect(resolveBookDate('', undefined)).toBe('');
  });
});

describe('createTransaction / updateTransaction：5 字段 SQL 拼写（mock 断言）', () => {
  beforeEach(() => {
    vi.mocked(execute).mockClear();
    setCurrentLedger(1);
  });

  it('createTransaction 的 INSERT 列名与参数完整包含 5 个交易明细字段', async () => {
    const p: TxPayload = {
      type: 'expense', amount: 32.2, categoryId: 1, accountId: 1,
      date: '2026-09-27', note: '午餐',
      payTime: '2026-09-27 12:03', payMethod: '微信支付', payee: '某某餐饮店',
      orderNo: '20260927123456789012', merchantOrderNo: 'S123456789',
    };
    const id = await createTransaction(p);
    expect(id).toBe(7);

    const call = vi.mocked(execute).mock.calls.find(([sql]) => String(sql).includes('INSERT INTO transactions'));
    expect(call).toBeDefined();
    const sql = String(call![0]);
    const params = call![1] as unknown[];
    // 列名完整
    expect(sql).toContain('pay_time');
    expect(sql).toContain('pay_method');
    expect(sql).toContain('payee');
    expect(sql).toContain('order_no');
    expect(sql).toContain('merchant_order_no');
    // 参数共 16 个且 5 字段取值正确（顺序=列顺序，位置 8..12）
    expect(params).toHaveLength(16);
    expect(params[8]).toBe('2026-09-27 12:03');
    expect(params[9]).toBe('微信支付');
    expect(params[10]).toBe('某某餐饮店');
    expect(params[11]).toBe('20260927123456789012');
    expect(params[12]).toBe('S123456789');
    // 基础字段不受影响
    expect(params[0]).toBe('expense');
    expect(params[1]).toBe(32.2);
    expect(params[7]).toBe('午餐');
  });

  it('createTransaction 未提供 5 字段时对应参数补为 null（占位不串列）', async () => {
    await createTransaction({ type: 'expense', amount: 10, accountId: 1, date: '2026-09-28', note: '' });
    const call = vi.mocked(execute).mock.calls.find(([sql]) => String(sql).includes('INSERT INTO transactions'));
    const params = call![1] as unknown[];
    expect(params).toHaveLength(16);
    expect(params[8]).toBeNull();
    expect(params[9]).toBeNull();
    expect(params[10]).toBeNull();
    expect(params[11]).toBeNull();
    expect(params[12]).toBeNull();
  });

  it('updateTransaction 的 UPDATE SET 与参数正确绑定 5 字段', async () => {
    const p: TxPayload = {
      type: 'expense', amount: 60, accountId: 1, date: '2026-09-28', note: '改',
      payTime: '2026-09-28 09:00', payMethod: '支付宝', payee: '某店',
      orderNo: 'O-2', merchantOrderNo: 'M-2',
    };
    await updateTransaction(5, p);

    const call = vi.mocked(execute).mock.calls.find(([sql]) => String(sql).includes('UPDATE transactions'));
    expect(call).toBeDefined();
    const sql = String(call![0]);
    // SET 段逐列对应正确的占位符
    expect(sql).toContain('pay_time=$9');
    expect(sql).toContain('pay_method=$10');
    expect(sql).toContain('payee=$11');
    expect(sql).toContain('order_no=$12');
    expect(sql).toContain('merchant_order_no=$13');
    // 参数 15 个：5 字段在位置 8..12，14 为 id
    const params = call![1] as unknown[];
    expect(params).toHaveLength(15);
    expect(params[8]).toBe('2026-09-28 09:00');
    expect(params[9]).toBe('支付宝');
    expect(params[10]).toBe('某店');
    expect(params[11]).toBe('O-2');
    expect(params[12]).toBe('M-2');
    expect(params[14]).toBe(5);
  });

  it('updateTransaction 未提供 5 字段更新时对应参数补为 null', async () => {
    await updateTransaction(5, { type: 'expense', amount: 10, accountId: 1, date: '2026-09-27', note: '' });
    const call = vi.mocked(execute).mock.calls.find(([sql]) => String(sql).includes('UPDATE transactions'));
    const params = call![1] as unknown[];
    expect(params[8]).toBeNull();
    expect(params[9]).toBeNull();
    expect(params[10]).toBeNull();
    expect(params[11]).toBeNull();
    expect(params[12]).toBeNull();
  });
});

describe('recalcAccountBalances：按流水重算真实账户余额', () => {
  beforeEach(() => {
    vi.mocked(execute).mockClear();
  });

  it('余额 = 初始余额 + 流水净额，并把改前/改后返回给前端', async () => {
    vi.mocked(select).mockImplementation(async (sql: string): Promise<any[]> => {
      // 注意：净额 SQL 内含 `t.type IN (...)`，故账户查询须用更具体的片段区分
      if (String(sql).includes('initial_balance FROM accounts')) return [{ id: 7, name: '花呗', balance: 0, initial_balance: 0 }];
      if (String(sql).includes('AS delta')) return [{ delta: -819.55 }];
      return [];
    });
    const changed = await recalcAccountBalances();
    expect(changed).toEqual([{ id: 7, name: '花呗', before: 0, after: -819.55 }]);
    expect(vi.mocked(execute)).toHaveBeenCalledWith(
      `UPDATE accounts SET balance = $1 WHERE id = $2`,
      [-819.55, 7]
    );
  });

  it('重算范围覆盖真实账户与投资账户，排除应收/应付虚拟账户', async () => {
    let capturedParams: unknown[] = [];
    vi.mocked(select).mockImplementation(async (sql: string, params: unknown[] = []): Promise<any[]> => {
      if (String(sql).includes('initial_balance FROM accounts')) { capturedParams = params; return []; }
      return [];
    });
    await recalcAccountBalances();
    // 第一个参数是账本 id，其后为参与重算的账户类型（真实账户 + 投资账户，投资走特殊公式）
    const types = capturedParams.slice(1);
    expect(types).toEqual(['cash', 'bank', 'ewallet', 'credit', 'savings', 'investment']);
    // 虚拟账户绝不在重算范围中：余额由 syncVirtualAccounts 按借贷剩余本金维护
    for (const t of ['receivable', 'payable']) {
      expect(types).not.toContain(t);
    }
  });

  it('保留初始余额：余额已与「初始余额 + 流水」一致时不写库（幂等）', async () => {
    vi.mocked(select).mockImplementation(async (sql: string): Promise<any[]> => {
      if (String(sql).includes('initial_balance FROM accounts')) return [{ id: 8, name: '白条', balance: -500, initial_balance: -100 }];
      if (String(sql).includes('AS delta')) return [{ delta: -400 }];
      return [];
    });
    expect(await recalcAccountBalances()).toEqual([]); // -100 + (-400) === -500，无需调整
    expect(vi.mocked(execute)).not.toHaveBeenCalled();
  });

  it('无可重算账户时不做任何写库', async () => {
    vi.mocked(select).mockImplementation(async (): Promise<any[]> => []);
    expect(await recalcAccountBalances()).toEqual([]);
    expect(vi.mocked(execute)).not.toHaveBeenCalled();
  });
});