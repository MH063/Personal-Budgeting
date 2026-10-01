/**
 * 性能回归基线（轻量 smoke）
 * ---------------------------------------------------------------
 * 目的：为几个核心热点建立耗时基线，防止发版引入明显性能回归。
 * 采用宽松上限（避免 CI 抖动误报），只抓"S级变慢"的粗回归；精确对比请用专门脚本。
 */
import { describe, it, expect } from 'vitest';
import { maskExportBundle, type ExportBundle } from '@/api/dataExport';
import { predictNext } from '@/api/predict';
import { detectMonthlyRecurring, detectRecurringChange } from '@/api/subscription';

const ms = () => performance.now();

describe('性能基线（宽松上限，粗回归检测）', () => {
  it('预测：12 个月序列 × 20 次应远低于 500ms', () => {
    const t0 = ms();
    for (let i = 0; i < 20; i++) {
      predictNext([100, 120, 90, 110, 130, 95, 105, 125, 85, 115, 140, 150]);
    }
    expect(ms() - t0).toBeLessThan(500);
  });

  it('订阅识别：1000 条明细 × 2 次应远低于 1000ms', () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      payee: `商户${i % 20}`, note: '', amount: 10 + (i % 50), date: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`,
    }));
    const t0 = ms();
    detectMonthlyRecurring(entries);
    detectRecurringChange(entries);
    expect(ms() - t0).toBeLessThan(1000);
  });

  it('导出：1 万条交易脱敏序列化应远低于 1000ms', () => {
    const tx = Array.from({ length: 10000 }, (_, i) => ({
      id: i, note: `备注含手机 13812345678`, payee: '某商户', pay_method: '微信支付',
      order_no: `订单${i}`, merchant_order_no: '',
    }));
    const bundle: ExportBundle = { version: 1, exportedAt: 'x', data: { transactions: tx } };
    const t0 = ms();
    JSON.stringify(maskExportBundle(bundle));
    expect(ms() - t0).toBeLessThan(1000);
  });
});