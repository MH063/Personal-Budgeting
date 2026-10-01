/**
 * 常用交易模板（txnTemplate）单元测试。
 * 覆盖：validateTemplatePayload 入参校验、parseTemplateRow JSON 反序列化容错、
 * templateToForm 表单回填、applyTemplateToTx 生成可写交易 payload。
 */
import { describe, it, expect } from 'vitest';
import {
  validateTemplatePayload,
  parseTemplateRow,
  templateToForm,
  applyTemplateToTx,
  type TxnTemplate,
} from './txnTemplate';

const tpl: TxnTemplate = {
  id: 1,
  name: '每月房租',
  type: 'expense',
  amount: 3500,
  category_id: 4,
  account_id: 1,
  to_account_id: null,
  note: '房租月付',
  payee: '房东小明',
  pay_method: '微信支付',
  tag_ids: [2, 9],
  ledger_id: 1,
  created_at: '2026-09-29 10:00:00',
};

describe('validateTemplatePayload：模板入参校验', () => {
  it('合法入参返回 null', () => {
    expect(validateTemplatePayload({ name: '房租', type: 'expense', amount: 3500 })).toBeNull();
  });

  it('名称必填，空名/纯空格拒绝', () => {
    expect(validateTemplatePayload({ name: '', type: 'expense' })).toContain('名称');
    expect(validateTemplatePayload({ name: '   ', type: 'expense' })).toContain('名称');
  });

  it('类型必须合法（income/expense/transfer/lend/borrow）', () => {
    expect(validateTemplatePayload({ name: 'x', type: 'repay_in' as never })).toContain('类型');
  });

  it('金额为空（手填）允许；非法金额拒绝', () => {
    expect(validateTemplatePayload({ name: 'x', type: 'expense', amount: null })).toBeNull();
    expect(validateTemplatePayload({ name: 'x', type: 'expense', amount: undefined })).toBeNull();
    expect(validateTemplatePayload({ name: 'x', type: 'expense', amount: 0 })).toContain('金额');
    expect(validateTemplatePayload({ name: 'x', type: 'expense', amount: -1 })).toContain('金额');
    expect(validateTemplatePayload({ name: 'x', type: 'expense', amount: NaN })).toContain('金额');
  });
});

describe('parseTemplateRow：数据库行反序列化', () => {
  it('解析基础字段与 tag_ids JSON', () => {
    const r = parseTemplateRow({ id: 1, name: '房租', type: 'expense', amount: 3500, category_id: 4, account_id: 1, to_account_id: null, note: 'n', payee: '', pay_method: '', tag_ids: '[2,9]', ledger_id: 1, created_at: '2026-09-29' });
    expect(r.tag_ids).toEqual([2, 9]);
    expect(r.amount).toBe(3500);
    expect(r.category_id).toBe(4);
  });

  it('tag_ids 非法 JSON 容错为空数组', () => {
    expect(parseTemplateRow({ tag_ids: 'not-json' } as Record<string, unknown>).tag_ids).toEqual([]);
    expect(parseTemplateRow({ tag_ids: 'null' } as Record<string, unknown>).tag_ids).toEqual([]);
  });

  it('amount 为 null（手填模板）保留 null', () => {
    expect(parseTemplateRow({ amount: null } as Record<string, unknown>).amount).toBeNull();
  });
});

describe('templateToForm：模板 → 表单回填（纯函数）', () => {
  it('映射表单字段，空引用转为 undefined，标签透传', () => {
    const f = templateToForm(tpl);
    expect(f.type).toBe('expense');
    expect(f.amount).toBe(3500);
    expect(f.categoryId).toBe(4);
    expect(f.accountId).toBe(1);
    expect(f.note).toBe('房租月付');
    expect(f.payee).toBe('房东小明');
    expect(f.payMethod).toBe('微信支付');
    expect(f.tagIds).toEqual([2, 9]);
  });

  it('空账户/转入/分类映射为 undefined', () => {
    const f = templateToForm({ ...tpl, category_id: null, account_id: null, to_account_id: null });
    expect(f.categoryId).toBeUndefined();
    expect(f.accountId).toBeUndefined();
    expect(f.toAccountId).toBeUndefined();
  });
});

describe('applyTemplateToTx：模板 → 可写交易 payload（纯函数）', () => {
  it('用指定金额与日期生成交易 payload', () => {
    const tx = applyTemplateToTx(tpl, { amount: 3500, today: '2026-10-01' });
    expect(tx.type).toBe('expense');
    expect(tx.amount).toBe(3500);
    expect(tx.accountId).toBe(1);
    expect(tx.categoryId).toBe(4);
    expect(tx.date).toBe('2026-10-01');
    expect(tx.payee).toBe('房东小明');
    expect(tx.payMethod).toBe('微信支付');
    expect(tx.tagIds).toEqual([2, 9]);
  });

  it('空收款方/付款方式映射为 undefined；默认日期取当天', () => {
    const tx = applyTemplateToTx({ ...tpl, payee: '', pay_method: '' }, { amount: 100 });
    expect(tx.payee).toBeUndefined();
    expect(tx.payMethod).toBeUndefined();
    expect(tx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});