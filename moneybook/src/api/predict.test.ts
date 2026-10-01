/**
 * 支出预测引擎（predict）单元测试。
 * 覆盖：predictNext 加权移动平均 + 趋势判定的纯逻辑。
 */
import { describe, it, expect } from 'vitest';
import { predictNext } from './predict';

describe('predictNext：下月支出预测', () => {
  it('单月数据：预测等于该月，无趋势', () => {
    const p = predictNext([100]);
    expect(p.predicted).toBe(100);
    expect(p.momPct).toBeNull();
    expect(p.trend).toBe('flat');
  });

  it('上升：预测高于均值并判 up；下降判 down', () => {
    const up = predictNext([100, 120, 140, 160]);
    expect(up.trend).toBe('up');
    expect(up.predicted).toBeGreaterThan(120); // 高于中间月
    expect(up.momPct).toBeGreaterThan(0);

    const down = predictNext([200, 180, 150, 120]);
    expect(down.trend).toBe('down');
    expect(down.predicted).toBeLessThan(200);
  });

  it('波动带载判 flat', () => {
    const p = predictNext([100, 105, 98, 103]);
    expect(p.trend).toBe('flat');
  });

  it('空/非法值返回 0 且无趋势', () => {
    const empty = predictNext([]);
    expect(empty.predicted).toBe(0);
    expect(empty.trend).toBe('flat');
    expect(predictNext([-5, NaN, 0]).predicted).toBe(0);
  });

  it('预测非负且为整数', () => {
    const p = predictNext([50, 80, 70]);
    expect(p.predicted).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(p.predicted)).toBe(true);
  });

  it('可靠度随样本量上升，样本月份数正确暴露（启发式，非准确率）', () => {
    expect(predictNext([]).reliability).toBe(0);
    expect(predictNext([]).sampleMonths).toBe(0);
    expect(predictNext([100]).reliability).toBe(0.4);
    expect(predictNext([100]).sampleMonths).toBe(1);
    // 样本越多基础可靠度越高
    expect(predictNext([100]).reliability).toBeLessThan(predictNext([100, 200]).reliability);
    expect(predictNext([100, 200]).reliability).toBeLessThan(predictNext([100, 200, 150]).reliability);
  });

  it('波动（变异系数）会下调可靠度，使数据不稳定时预测更克制', () => {
    const steady = predictNext([100, 105, 98, 103]);
    const volatile = predictNext([30, 500, 10, 900]);
    expect(volatile.sampleMonths).toBe(4);
    expect(volatile.reliability).toBeLessThanOrEqual(steady.reliability);
  });
});