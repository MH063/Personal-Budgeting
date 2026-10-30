/**
 * 银行对账模块单元测试。
 * 覆盖：buildLocalUnmatchedQuery「本地有·银行无」查询构造（期间过滤/排除本批次已匹配/
 * 排除归属其他批次/取前 200 条）、对账单解析（表头别名/dimension/异常容错）。
 */
import { describe, it, expect } from 'vitest';
import {
  buildLocalUnmatchedQuery, buildLocalUnmatchedCount, buildReconDiffRows, excelDateToStr,
  buildBalanceAdjustment, bankDirection, txDirectionForAccount, chunkArray,
  type Reconciliation, type ReconItem, type LocalUnmatchedTx,
} from '@/api/reconciliation';

const rec = (partial: Partial<Reconciliation>): Reconciliation => ({
  id: 1,
  account_id: 2,
  period_start: '2026-09-01',
  period_end: '2026-09-30',
  opening_balance: 100,
  bank_balance: null,
  calc_balance: null,
  diff_total: 0,
  status: 'draft',
  created_at: '',
  ledger_id: 1,
  ...partial,
});

describe('buildLocalUnmatchedQuery：本地有·银行无（双向核对）', () => {
  it('排除已匹配本批次的交易（NOT EXISTS reconciliation_items）', () => {
    const { sql } = buildLocalUnmatchedQuery(rec({}));
    // 三处关键条件缺一不可
    expect(sql).toContain('t.reconciliation_id IS NULL');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('ri.reconciliation_id = $3');
    expect(sql).toContain('ri.transaction_id = t.id');
  });

  it('账户维度同时匹配 account_id 与 to_account_id（转账方向）', () => {
    const { sql } = buildLocalUnmatchedQuery(rec({}));
    expect(sql).toContain('(t.account_id = $2 OR t.to_account_id = $2)');
  });

  it('期间范围约束：起始/结束日期作为第 4、5 个参数', () => {
    const { sql, params } = buildLocalUnmatchedQuery(rec({}));
    expect(sql).toContain('t.date >= $4');
    expect(sql).toContain('t.date <= $5');
    expect(params).toEqual([1, 2, 1, '2026-09-01', '2026-09-30']); // 账本/账户/批次/起/止
  });

  it('无起始/结束日期时不加期间约束', () => {
    const { sql, params } = buildLocalUnmatchedQuery(rec({ period_start: null, period_end: null }));
    expect(sql).not.toContain('t.date >=');
    expect(sql).not.toContain('t.date <=');
    expect(params).toEqual([1, 2, 1]);
  });

  it('仅缺一个期间端点时只加对应约束', () => {
    const { sql, params } = buildLocalUnmatchedQuery(rec({ period_start: null, period_end: '2026-09-30' }));
    expect(sql).not.toContain('t.date >=');
    expect(sql).toContain('t.date <= $4');
    expect(params).toEqual([1, 2, 1, '2026-09-30']);
  });

  it('取前 200 条且按日期倒序', () => {
    const { sql } = buildLocalUnmatchedQuery(rec({}));
    expect(sql).toContain('ORDER BY t.date DESC, t.id DESC');
    expect(sql).toContain('LIMIT 200');
  });

  it('支持分页：limit/offset 写入 SQL', () => {
    const { sql } = buildLocalUnmatchedQuery(rec({}), { limit: 20, offset: 40 });
    expect(sql).toContain('LIMIT 20 OFFSET 40');
  });

  it('分页使用默认值 limit=200 / offset=0', () => {
    const { sql } = buildLocalUnmatchedQuery(rec({}));
    expect(sql).toContain('LIMIT 200 OFFSET 0');
  });
});

describe('buildLocalUnmatchedCount：本地有·银行无 计数', () => {
  it('生成 COUNT(*) 且与查询共用同一过滤条件（不包括 LIMIT）', () => {
    const { sql, params } = buildLocalUnmatchedCount(rec({}));
    expect(sql).toContain('COUNT(*)');
    expect(sql).not.toContain('LIMIT');
    expect(sql).toContain('t.reconciliation_id IS NULL');
    expect(params).toEqual([1, 2, 1, '2026-09-01', '2026-09-30']);
  });

  it('计数不带期间条件时不加日期约束', () => {
    const { sql } = buildLocalUnmatchedCount(rec({ period_start: null, period_end: null }));
    expect(sql).not.toContain('t.date >=');
    expect(sql).not.toContain('t.date <=');
  });
});

describe('buildReconDiffRows：把差异拼成可导出的扁平行', () => {
  const bankItem = (over: Partial<ReconItem>): ReconItem => ({
    id: 1, reconciliation_id: 1, bank_row: JSON.stringify({ date: '2026-09-01', summary: '工资', income: 5000, expense: 0 }), transaction_id: null, match_kind: 'unmatched_bank', matched_at: null!, ...over,
  });
  const mismatchItem = (over: Partial<ReconItem>): ReconItem => ({
    id: 2, reconciliation_id: 1, bank_row: JSON.stringify({ date: '2026-09-02', summary: '消费', income: 0, expense: 100 }), transaction_id: null, match_kind: 'amount_mismatch', matched_at: null!, ...over,
  });
  const localTx = (over: Partial<LocalUnmatchedTx>): LocalUnmatchedTx => ({
    transaction_id: 3, tx_date: '2026-09-03', tx_amount: -50, tx_note: '午餐', account_name: '现金', ...over,
  });

  it('三类差异合并为统一行；坏 bank_row 被跳过', () => {
    const rows = buildReconDiffRows({
      bankUnmatched: [bankItem({}), bankItem({ id: 9, bank_row: 'not-json' })],
      amountMismatch: [mismatchItem({})],
      localUnmatched: [localTx({})],
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: 'bank_unmatched', date: '2026-09-01', income: 5000, expense: 0 });
    expect(rows[1]).toMatchObject({ kind: 'amount_mismatch', date: '2026-09-02', income: 0, expense: 100 });
  });

  it('本地交易按正负映射到收入/支出', () => {
    const rows = buildReconDiffRows({ bankUnmatched: [], amountMismatch: [], localUnmatched: [localTx({ tx_amount: 88 }), localTx({ transaction_id: 4, tx_amount: -66 })] });
    expect(rows[0]).toMatchObject({ kind: 'local_unmatched', income: 88, expense: 0 });
    expect(rows[1]).toMatchObject({ kind: 'local_unmatched', income: 0, expense: 66 });
  });

  it('空输入返回空数组且不抛错', () => {
    expect(buildReconDiffRows({ bankUnmatched: [], amountMismatch: [], localUnmatched: [] })).toEqual([]);
  });
});

describe('excelDateToStr：Excel 日期 → YYYY-MM-DD（不涉时区）', () => {
  it('字符串日期直接透传', () => {
    expect(excelDateToStr('2026-09-01')).toBe('2026-09-01');
  });

  it('Excel 序列号日期按 UTC 换算（45601 ≈ 2024-11-05）', () => {
    // 序列号 45601 对应 2024-11-05；用 getUTC 取日期，与运行环境时区无关
    expect(excelDateToStr(45601)).toBe('2024-11-05');
  });

  it('序列号小数（当天部分时间）仍归当天的 YYYY-MM-DD', () => {
    const s = excelDateToStr(45601.5);
    expect(s).toBe('2024-11-05');
  });

  it('空串/非日期输入返回空串', () => {
    expect(excelDateToStr('')).toBe('');
    expect(excelDateToStr('not-a-date')).toBe('');
  });
});

describe('buildBalanceAdjustment：余额调节表', () => {
  const bankItem = (income: number, expense: number): ReconItem => ({
    id: 1,
    reconciliation_id: 1,
    bank_row: JSON.stringify({ date: '2026-09-10', summary: '测试', income, expense, balance: 0, line: 2 }),
    transaction_id: null,
    match_kind: 'unmatched_bank',
    matched_at: '',
  });

  it('两侧调整后相等时 balanced=true', () => {
    const r = buildBalanceAdjustment({
      bankEndBalance: 1000,
      calcBalance: 1000,
      localNotBankNet: 0,
      localNotBankCount: 0,
      bankUnmatched: [],
      amountMismatch: [],
    });
    expect(r.adjustedBank).toBe(1000);
    expect(r.adjustedLocal).toBe(1000);
    expect(r.difference).toBe(0);
    expect(r.balanced).toBe(true);
  });

  it('本地已记·银行未记收入 → 银行侧加回该净额', () => {
    const r = buildBalanceAdjustment({
      bankEndBalance: 900,
      calcBalance: 1000,
      localNotBankNet: 100,
      localNotBankCount: 1,
      bankUnmatched: [],
      amountMismatch: [],
    });
    expect(r.adjustedBank).toBe(1000);
    expect(r.adjustedLocal).toBe(1000);
    expect(r.balanced).toBe(true);
  });

  it('银行已记·本地未记支出 → 本地侧扣减后与银行侧相等', () => {
    const r = buildBalanceAdjustment({
      bankEndBalance: 1000,
      calcBalance: 1050,
      localNotBankNet: 0,
      localNotBankCount: 0,
      bankUnmatched: [bankItem(0, 50)],
      amountMismatch: [],
    });
    expect(r.bankNotLocalNet).toBe(-50);
    expect(r.adjustedLocal).toBe(1000);
    expect(r.balanced).toBe(true);
  });

  it('未填银行余额时无法计算差额', () => {
    const r = buildBalanceAdjustment({
      bankEndBalance: null,
      calcBalance: 1000,
      localNotBankNet: 0,
      localNotBankCount: 0,
      bankUnmatched: [],
      amountMismatch: [],
    });
    expect(r.adjustedBank).toBeNull();
    expect(r.difference).toBeNull();
    expect(r.balanced).toBe(false);
  });
});

describe('bankDirection：银行流水方向', () => {
  it('净额为正 → in（钱进入对账账户）', () => {
    expect(bankDirection({ income: 100, expense: 0 })).toBe('in');
  });

  it('净额为负 → out（钱转出对账账户）', () => {
    expect(bankDirection({ income: 0, expense: 50 })).toBe('out');
  });

  it('收支配平或仅浮点尾差 → none', () => {
    expect(bankDirection({ income: 100, expense: 100 })).toBe('none');
    expect(bankDirection({ income: 100.001, expense: 100 })).toBe('none');
  });
});

describe('txDirectionForAccount：本地交易相对对账账户的方向', () => {
  const tx = (type: string, account_id: number, to_account_id: number | null = null) => ({ type, account_id, to_account_id });

  it('收入/借入/收回借款 → in', () => {
    expect(txDirectionForAccount(tx('income', 2), 2)).toBe('in');
    expect(txDirectionForAccount(tx('borrow', 2), 2)).toBe('in');
    expect(txDirectionForAccount(tx('repay_in', 2), 2)).toBe('in');
  });

  it('支出/借出/还款 → out', () => {
    expect(txDirectionForAccount(tx('expense', 2), 2)).toBe('out');
    expect(txDirectionForAccount(tx('lend', 2), 2)).toBe('out');
    expect(txDirectionForAccount(tx('repay_out', 2), 2)).toBe('out');
  });

  it('转账：钱转入对账账户 → in（回归：此前恒为 transfer 导致永不匹配）', () => {
    expect(txDirectionForAccount(tx('transfer', 5, 2), 2)).toBe('in');
  });

  it('转账：钱转出对账账户 → out', () => {
    expect(txDirectionForAccount(tx('transfer', 2, 5), 2)).toBe('out');
  });

  it('转账两端都不涉及对账账户 → none', () => {
    expect(txDirectionForAccount(tx('transfer', 5, 6), 2)).toBe('none');
  });
});

describe('chunkArray：金额分批预筛', () => {
  it('按固定大小切分，最后一片不足也保留', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('空数组返回空列表；非法分块大小返回原数组单片', () => {
    expect(chunkArray([], 2)).toEqual([]);
    expect(chunkArray([1, 2], 0)).toEqual([[1, 2]]);
  });
});