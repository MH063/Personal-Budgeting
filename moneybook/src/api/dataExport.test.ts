/**
 * 一键导出全部数据（dataExport）纯逻辑单元测试。
 * 覆盖：maskExportBundle 默认脱敏交易文本列、inclSensitive 保留原文。
 */
import { describe, it, expect } from 'vitest';
import { maskExportBundle, validateExportBundle, type ExportBundle } from './dataExport';

const bundle: ExportBundle = {
  version: 1,
  exportedAt: '2026-09-29T00:00:00Z',
  data: {
    transactions: [
      { id: 1, note: '联系 13812345678 报销', payee: '银行尾号 6222021234567890', pay_method: '微信支付', order_no: '订单号 20260928123457', merchant_order_no: '' },
      { id: 2, note: '普通午餐', payee: '星巴克', pay_method: '支付宝', order_no: '', merchant_order_no: '' },
    ],
    accounts: [{ id: 1, name: '微信' }],
  },
};

describe('maskExportBundle：导出脱敏', () => {
  it('默认对交易文本列脱敏：手机/卡号打码，订单号语境不误伤', () => {
    const masked = maskExportBundle(bundle);
    const rows = masked.data.transactions as Record<string, unknown>[];
    expect(rows[0].note).toContain('138****5678');
    // 银行卡 6222021234567890 → 掩码
    expect(rows[0].payee).not.toContain('6222021234567890');
    // 订单号在"订单号"语境下被保护，不被卡号规则误伤
    expect(rows[0].order_no).toContain('20260928123457');
  });

  it('inclSensitive=true 时保留原文', () => {
    const out = maskExportBundle(bundle, true);
    const rows = out.data.transactions as Record<string, unknown>[];
    expect(rows[0].note).toContain('13812345678');
    expect(out).toBe(bundle); // 直接返回原引用
  });
});

describe('validateExportBundle：导入前 schema/版本校验（导出的孪生守卫）', () => {
  it('合法导出包通过校验并读取版本', () => {
    const r = validateExportBundle(bundle);
    expect(r.ok).toBe(true);
    expect(r.version).toBe(1);
  });

  it('被篡改：data 不是对象 / 某表非数组 / 版本非数字 → 拒绝', () => {
    expect(validateExportBundle({ version: 1, exportedAt: 'x', data: null }).ok).toBe(false);
    expect(validateExportBundle({ version: 1, exportedAt: 'x', data: { transactions: 'oops' } }).ok).toBe(false);
    expect(validateExportBundle({ version: '1', exportedAt: 'x', data: {} }).ok).toBe(false);
    expect(validateExportBundle('garbage').ok).toBe(false);
    expect(validateExportBundle(null).ok).toBe(false);
  });
});