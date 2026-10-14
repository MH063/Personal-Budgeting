/**
 * tokenBudget（LLM 上下文体积估算与裁剪）单元测试。
 * 覆盖：token 粗略估算、单条文本截断、对话历史「成对 + 预算」裁剪、多行内容按预算裁剪。
 */
import { describe, it, expect } from 'vitest';
import { estimateTokens, truncateToTokens, clipChatHistory, clipLinesToBudget } from './tokenBudget';

describe('estimateTokens：粗略 token 估算（保守高估）', () => {
  it('空文本为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('ASCII 约 4 字符记 1 token（向上取整）', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('非 ASCII（中文）按 1 token/字符高估', () => {
    expect(estimateTokens('中文')).toBe(2);
    expect(estimateTokens('a中')).toBe(2);
  });
});

describe('truncateToTokens：单条文本裁剪', () => {
  it('未超预算时原样返回', () => {
    expect(truncateToTokens('短文本', 100)).toBe('短文本');
  });

  it('超预算时截断并追加省略号', () => {
    const s = 'a'.repeat(100); // ≈25 token
    const out = truncateToTokens(s, 5);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan(s.length);
  });

  it('预算 <= 0 时返回空串', () => {
    expect(truncateToTokens('abc', 0)).toBe('');
  });
});

describe('clipChatHistory：对话历史成对裁剪', () => {
  const msg = (role: 'user' | 'assistant', content: string) => ({ role, content });

  it('未超预算时全部保留', () => {
    const h = [msg('user', '你好'), msg('assistant', '在的')];
    expect(clipChatHistory(h, 1000)).toEqual(h);
  });

  it('超预算时保留最近若干条，且不出现开头的孤立 assistant（成对裁剪）', () => {
    const h = [
      msg('user', 'u1'), msg('assistant', 'a1'),
      msg('user', 'u2'), msg('assistant', 'a2'),
      msg('user', 'u3'), msg('assistant', 'a3'),
    ];
    // 每条约 1 token + 4 结构开销 = 5；预算 16 时从末尾累计到 a2 会超限，
    // 故保留 [u3, a3] 一对（避免了「只剩半条对话」）。
    expect(clipChatHistory(h, 16)).toEqual([msg('user', 'u3'), msg('assistant', 'a3')]);
  });

  it('单条即使超预算也至少保留该条（不返回空）', () => {
    const h = [msg('user', 'x'.repeat(400))]; // ≈100 token
    expect(clipChatHistory(h, 10).length).toBe(1);
  });
});

describe('clipLinesToBudget：多行内容按预算裁剪', () => {
  it('全部放得下时不省略', () => {
    const { text, omitted } = clipLinesToBudget(['甲', '乙'], 100);
    expect(omitted).toBe(0);
    expect(text).toBe('甲\n乙');
  });

  it('超预算时保留前面若干行并统计省略行数', () => {
    const lines = Array.from({ length: 5 }, () => 'x'.repeat(40)); // 每行 ≈10 token + 1
    const { text, omitted } = clipLinesToBudget(lines, 22);
    expect(text.split('\n').length).toBe(2);
    expect(omitted).toBe(3);
  });

  it('headerTokens 会一并计入预算', () => {
    const lines = ['x'.repeat(40), 'x'.repeat(40)];
    const { omitted } = clipLinesToBudget(lines, 20, { headerTokens: 10 });
    expect(omitted).toBe(1);
  });

  it('支持自定义分隔符', () => {
    const { text } = clipLinesToBudget(['甲', '乙'], 100, { separator: '；' });
    expect(text).toBe('甲；乙');
  });
});
