/**
 * AI 异常 / 重复检测（dupDetect）单元测试。
 * 覆盖：候选筛选（同商户/同金额/订单号不同/窗口与比例/同订单号排除/商户归一化）、
 * 本地判定映射、AI 判定解析与门控回退。
 */
import { describe, it, expect } from 'vitest';
import { detectDuplicateCandidates, toLocalSuspect, parseDupVerdicts, aiVerifyDuplicates, type DupEntry } from './dupDetect';

/** 构造一笔支出明细 */
function mk(over: Partial<DupEntry>): DupEntry {
  return { id: 0, payee: '', amount: 0, date: '2026-09-01', ...over };
}

describe('detectDuplicateCandidates：确定性筛出疑似重复候选对', () => {
  it('同商户、同金额、订单号不同、窗口期内 → 命中，且标记 sameAmount+orderDiff', () => {
    const a = mk({ id: 1, payee: '瑞幸咖啡', amount: 16, date: '2026-09-01', orderNo: 'A1' });
    const b = mk({ id: 2, payee: '瑞幸咖啡', amount: 16, date: '2026-09-02', orderNo: 'A2' });
    const hits = detectDuplicateCandidates([a, b]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ sameAmount: true, orderDiff: true, key: '1:2' });
  });

  it('金额相差超过 5% 不算候选（可能是两笔不同消费）', () => {
    const a = mk({ id: 1, payee: '某超市', amount: 30, date: '2026-09-01' });
    const b = mk({ id: 2, payee: '某超市', amount: 100, date: '2026-09-02' });
    expect(detectDuplicateCandidates([a, b])).toHaveLength(0);
  });

  it('超出窗口期（>3 天）不命中', () => {
    const a = mk({ id: 1, payee: '星巴克', amount: 35, date: '2026-09-01' });
    const b = mk({ id: 2, payee: '星巴克', amount: 35, date: '2026-09-08' });
    expect(detectDuplicateCandidates([a, b])).toHaveLength(0);
  });

  it('两笔订单号一致 → 已由订单号去重覆盖，跳过', () => {
    const a = mk({ id: 1, payee: '美团', amount: 25, date: '2026-09-01', orderNo: 'O1' });
    const b = mk({ id: 2, payee: '美团', amount: 25, date: '2026-09-02', orderNo: 'O1' });
    expect(detectDuplicateCandidates([a, b])).toHaveLength(0);
  });

  it('商户名归一化后同组（括注/别名视为同一商户）', () => {
    const a = mk({ id: 1, payee: '瑞幸咖啡(北京店)', amount: 16, date: '2026-09-01' });
    const b = mk({ id: 2, payee: '瑞幸咖啡', amount: 16, date: '2026-09-02' });
    expect(detectDuplicateCandidates([a, b])).toHaveLength(1);
  });

  it('无商户名/金额无效的行不参与', () => {
    const a = mk({ id: 1, payee: '', amount: 0, date: '2026-09-01' });
    const b = mk({ id: 2, payee: '某商户', amount: 0, date: '2026-09-02' });
    expect(detectDuplicateCandidates([a, b])).toHaveLength(0);
  });
});

describe('toLocalSuspect：本地启发式判定', () => {
  it('同金额+订单号不同 → 疑似重复（可靠 0.75）', () => {
    const p = detectDuplicateCandidates([
      mk({ id: 1, payee: '某商户', amount: 16, date: '2026-09-01', orderNo: 'A' }),
      mk({ id: 2, payee: '某商户', amount: 16, date: '2026-09-02', orderNo: 'B' }),
    ])[0];
    const s = toLocalSuspect(p);
    expect(s.verdict).toBe('dup');
    expect(s.reliability).toBe(0.75);
    expect(s.source).toBe('local');
  });

  it('同金额但订单号一致/缺省 → 疑似重复（可靠 0.6）', () => {
    const p = detectDuplicateCandidates([
      mk({ id: 1, payee: '某商户', amount: 16, date: '2026-09-01' }),
      mk({ id: 2, payee: '某商户', amount: 16, date: '2026-09-02' }),
    ])[0];
    expect(toLocalSuspect(p)).toMatchObject({ verdict: 'dup', reliability: 0.6 });
  });

  it('金额相近但不同 → 待核查（uncertain）', () => {
    const p = detectDuplicateCandidates([
      mk({ id: 1, payee: '某商户', amount: 16, date: '2026-09-01' }),
      mk({ id: 2, payee: '某商户', amount: 16.8, date: '2026-09-02' }),
    ])[0];
    expect(toLocalSuspect(p)).toMatchObject({ verdict: 'uncertain', reliability: 0.5 });
  });
});

describe('aiVerifyDuplicates：门控与解析', () => {
  it('AI 未启用（gate.enabled=false）→ 仅本地判定，不发请求', async () => {
    const pairs = detectDuplicateCandidates([
      mk({ id: 1, payee: '某商户', amount: 16, date: '2026-09-01', orderNo: 'A' }),
      mk({ id: 2, payee: '某商户', amount: 16, date: '2026-09-02', orderNo: 'B' }),
    ]);
    const out = await aiVerifyDuplicates(pairs, { enabled: false, allowDetail: true });
    expect(out[0].source).toBe('local');
    expect(out[0].verdict).toBe('dup');
  });

  it('parseDupVerdicts：剥离围栏取数组，非法输入回退空数组', () => {
    expect(parseDupVerdicts('```json\n[{"pair":0,"verdict":"dup","reason":"重复"}]\n```')).toEqual([
      { pair: 0, verdict: 'dup', reason: '重复' },
    ]);
    expect(parseDupVerdicts('不是 JSON')).toEqual([]);
    expect(parseDupVerdicts('[{"pair":"x"}]')).toEqual([{ pair: 'x' }]); // 结构容错，交由上层过滤
  });
});
