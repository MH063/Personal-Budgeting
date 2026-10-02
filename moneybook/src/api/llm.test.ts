// llm.ts 纯函数单测：只测不依赖数据库/网络的确定性函数
import { describe, it, expect } from 'vitest';
import { buildReconDiffLocalText, capMaxTokens } from './llm';

describe('buildReconDiffLocalText（对账差异本地兜底文案）', () => {
  it('三类差异齐全时逐类说明', () => {
    const t = buildReconDiffLocalText({ bankUnmatchedN: 2, localUnmatchedN: 1, amountMismatchN: 3 });
    expect(t).toContain('银行有·本地无 2 条');
    expect(t).toContain('本地有·银行无 1 条');
    expect(t).toContain('金额不符 3 条');
  });

  it('全部为 0 时给出「无差异」提示', () => {
    const t = buildReconDiffLocalText({ bankUnmatchedN: 0, localUnmatchedN: 0, amountMismatchN: 0 });
    expect(t).toContain('没有未配对或金额不符的差异');
  });

  it('只统计非零类别（排查建议仍给出通用步骤）', () => {
    const t = buildReconDiffLocalText({ bankUnmatchedN: 5, localUnmatchedN: 0, amountMismatchN: 0 });
    expect(t).toContain('银行有·本地无 5 条');
    // 「差异构成」首行只列出非零类别
    expect(t.startsWith('本次对账差异构成：银行有·本地无 5 条（可能漏记本地交易）。')).toBe(true);
  });
});

describe('capMaxTokens（max_tokens 上下限保护）', () => {
  it('非法值回退 undefined', () => {
    expect(capMaxTokens(null)).toBeUndefined();
    expect(capMaxTokens(undefined)).toBeUndefined();
    expect(capMaxTokens(Number.NaN)).toBeUndefined();
  });

  it('越界值被夹紧到上下限', () => {
    expect(capMaxTokens(0)).toBe(1);
    expect(capMaxTokens(999999)).toBe(32768);
  });

  it('合法值原样保留', () => {
    expect(capMaxTokens(2048)).toBe(2048);
    expect(capMaxTokens(3.7)).toBe(3);
  });
});
