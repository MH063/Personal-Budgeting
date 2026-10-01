/**
 * AI 请求 token 上限保护单元测试。
 * 覆盖 capMaxTokens 的上下限截断、非法/空值回退与整数化，防止误配置导致服务端拒绝或超长计费。
 */
import { describe, it, expect } from 'vitest';
import { capMaxTokens, MAX_TOKENS_CAP } from '@/api/llm';

describe('capMaxTokens：AI 请求 token 上限保护', () => {
  it('正常范围内的配置值原样保留（向下取整）', () => {
    expect(capMaxTokens(1000)).toBe(1000);
    expect(capMaxTokens(512.9)).toBe(512);
    expect(capMaxTokens(1)).toBe(1);
  });

  it('超过上限被截断到 MAX_TOKENS_CAP', () => {
    expect(capMaxTokens(MAX_TOKENS_CAP + 1)).toBe(MAX_TOKENS_CAP);
    expect(capMaxTokens(999999)).toBe(MAX_TOKENS_CAP);
  });

  it('低于下限被抬高到 1', () => {
    expect(capMaxTokens(0)).toBe(1);
    expect(capMaxTokens(-5)).toBe(1);
  });

  it('空值或非有限数（null/undefined/NaN/Infinity）回退为 undefined（不传该字段）', () => {
    expect(capMaxTokens(null)).toBeUndefined();
    expect(capMaxTokens(undefined)).toBeUndefined();
    expect(capMaxTokens(NaN)).toBeUndefined();
    expect(capMaxTokens(Infinity)).toBeUndefined();
    expect(capMaxTokens(-Infinity)).toBeUndefined();
  });
});