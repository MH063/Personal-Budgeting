/**
 * 智能补全（autocomplete）单元测试。
 * 覆盖：tokenize 词元切分、normMerchant 商户归一、recommendTags 标签共现推荐、
 * recommendMerchant 商户频次推荐。
 */
import { describe, it, expect } from 'vitest';
import { tokenize, normMerchant, recommendTags, recommendMerchant } from './autocomplete';

const history = [
  { note: '星巴克拿铁', payee: 'Starbucks', tagIds: [1, 2] },
  { note: '星巴克蛋糕', payee: '星巴克', tagIds: [1, 3] },
  { note: '早餐螺蛳粉', payee: '螺蛳粉店', tagIds: [5] },
  { note: '地铁通勤', payee: '地铁', tagIds: [6] },
];

describe('tokenize：文本词元切分', () => {
  it('按空白/分隔符切分并过滤过短词', () => {
    expect(tokenize('星巴克 拿铁')).toEqual(['星巴克', '拿铁']);
    expect(tokenize('星巴克、拿铁')).toEqual(['星巴克', '拿铁']);
    expect(tokenize('a')).toEqual([]); // 单字符过滤
    expect(tokenize('')).toEqual([]);
  });
});

describe('normMerchant：商户名归一', () => {
  it('去除括号/空格/星号判断同商户', () => {
    expect(normMerchant('Starbucks')).toBe('Starbucks');
    expect(normMerchant('星巴克 (北京)')).toBe('星巴克北京');
    expect(normMerchant('麦当劳*')).toBe('麦当劳');
  });
});

describe('recommendTags：历史共现标签推荐', () => {
  it('输入命中历史商户时按频次返回 Top 标签', () => {
    // 「星巴克」在两条历史中 → 标签 1 出现 2 次、标签 2/3 各 1 次
    expect(recommendTags('星巴克', history)).toEqual([1, 2, 3]);
  });

  it('输入无命中返回空数组', () => {
    expect(recommendTags('不存在的商户xyz', history)).toEqual([]);
  });

  it('limit 截断生效', () => {
    expect(recommendTags('星巴克', history, 1)).toEqual([1]);
  });
});

describe('recommendMerchant：历史商户频次推荐', () => {
  it('高频商户靠前，返回其展示名（同商户名两家店合并计数）', () => {
    // 两条历史均收款方「星巴克」且与关键字共现 → 归一同户计 2 次，排最前
    const r = recommendMerchant(
      '星巴克',
      [
        { note: '星巴克拿铁', payee: '星巴克', tagIds: [1] },
        { note: '星巴克蛋糕', payee: '星巴克', tagIds: [1] },
        { note: '地铁通勤', payee: '地铁', tagIds: [6] },
      ]
    );
    expect(r[0]).toBe('星巴克');
  });

  it('空关键字 / 无命中返回空数组', () => {
    expect(recommendMerchant('', history)).toEqual([]);
    expect(recommendMerchant('xyz未知', history)).toEqual([]);
  });
});