/**
 * 反欺诈 / 异常交易检测（anomaly）单元测试。
 * 覆盖：金额离群（剔除自身基线）、同收款方短时重复扣费、小额探路+大额组合。
 */
import { describe, it, expect } from 'vitest';
import { detectAnomalies, type TxLike } from './anomaly';

const mk = (date: string, amount: number, payee = '某店', note = ''): TxLike => ({ payee, note, amount, date });

describe('detectAnomalies：异常与疑似盗刷检测', () => {
  it('金额离群：剔除自身基线后能检测出最大那笔', () => {
    // 6 笔 50~60 + 一笔 1200 → 1200 应为离群
    const entries = [
      mk('2026-09-01', 55), mk('2026-09-02', 60), mk('2026-09-03', 52),
      mk('2026-09-04', 58), mk('2026-09-05', 50), mk('2026-09-06', 54),
      mk('2026-09-07', 1200, '奢侈品店'),
    ];
    const hits = detectAnomalies(entries);
    expect(hits.some((h) => h.kind === 'amount' && h.payee === '奢侈品店' && h.amount === 1200)).toBe(true);
  });

  it('同收款方 7 天内 ≥3 次 → 重复扣费', () => {
    const entries = [
      mk('2026-09-01', 30, '某视频会员'), mk('2026-09-02', 30, '某视频会员'), mk('2026-09-03', 30, '某视频会员'),
    ];
    const hits = detectAnomalies(entries);
    expect(hits.some((h) => h.kind === 'repeat' && h.payee === '某视频会员')).toBe(true);
  });

  it('每条异常均携带可解释的可靠度（启发式，非准确率）', () => {
    const entries = [
      mk('2026-09-01', 55), mk('2026-09-02', 60), mk('2026-09-03', 52),
      mk('2026-09-04', 58), mk('2026-09-05', 50), mk('2026-09-06', 54),
      mk('2026-09-07', 1200, '奢侈品店'), // 金额离群
    ];
    const amountHit = detectAnomalies(entries).find((h) => h.kind === 'amount');
    expect(amountHit).toBeDefined();
    expect(amountHit!.reliability).toBeGreaterThan(0);
    expect(amountHit!.reliability).toBeLessThanOrEqual(1);

    const repeatHit = detectAnomalies([
      mk('2026-09-01', 30, '某视频会员'), mk('2026-09-02', 30, '某视频会员'), mk('2026-09-03', 30, '某视频会员'),
    ]).find((h) => h.kind === 'repeat');
    expect(repeatHit!.reliability).toBe(0.8);

    const probeHit = detectAnomalies([mk('2026-09-08', 2, '某外挂商店'), mk('2026-09-09', 500, '某外挂商店')])
      .find((h) => h.kind === 'probe');
    expect(probeHit!.reliability).toBe(0.7);
  });

  it('小额探路 + 大额 → 疑似盗刷', () => {
    const entries = [mk('2026-09-08', 2, '某外挂商店'), mk('2026-09-09', 500, '某外挂商店')];
    const hits = detectAnomalies(entries);
    expect(hits.some((h) => h.kind === 'probe' && h.payee === '某外挂商店')).toBe(true);
  });

  it('正常消费不误报', () => {
    const entries = [
      mk('2026-09-01', 20, '便利店'), mk('2026-09-02', 500, '房租'), mk('2026-09-03', 30, '咖啡'), mk('2026-09-04', 25, '书店'),
    ];
    const hits = detectAnomalies(entries);
    // 不同收款方、无小额探路 → 不应有 repeat / probe
    expect(hits.some((h) => h.kind === 'repeat' || h.kind === 'probe')).toBe(false);
  });
});