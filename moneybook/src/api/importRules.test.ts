/**
 * 导入规则自动学习单元测试。
 * 覆盖：关键词提取（商户优先/通用词拒绝/流水标识清理）、修正判定（diff）、
 * 幂等合并（同关键词更新/停用不复活/非转账清转入账户）、自定义模板路径规则生效。
 */
import { describe, it, expect } from 'vitest';
import { pickRuleKeyword, shouldLearnCorrection, learnRuleFromCorrection } from './importRules';
import { parseAoaWithMap, buildColumnMap, type ImportRow } from './import';

const baseRow: ImportRow = {
  line: 1, date: '2026-09-01', type: 'expense', amount: 35.5, account: '微信',
};

describe('pickRuleKeyword：从导入行提取规则关键词', () => {
  it('优先用收款方/商户名，不理会备注', () => {
    expect(pickRuleKeyword({ ...baseRow, payee: '瑞幸咖啡', note: '咖啡大杯' })).toBe('瑞幸咖啡');
  });

  it('商户名带门店括注/尾号时取其主体', () => {
    expect(pickRuleKeyword({ ...baseRow, payee: '瑞幸咖啡(北京店)' })).toBe('瑞幸咖啡');
  });

  it('英文商户名保留完整（不按空格截断）', () => {
    expect(pickRuleKeyword({ ...baseRow, payee: 'Four Directions' })).toBe('Four Directions');
  });

  it('无收款方时退回备注，并清理尾部的订单号/数字尾巴', () => {
    expect(pickRuleKeyword({ ...baseRow, note: '美团外卖订单20260901001' })).toBe('美团外卖');
    expect(pickRuleKeyword({ ...baseRow, note: '话费自动充值' })).toBe('话费自动充值');
  });

  it('备注含分隔符时取首个分段（商户主体）', () => {
    expect(pickRuleKeyword({ ...baseRow, note: '星巴克-咖啡消费' })).toBe('星巴克');
    expect(pickRuleKeyword({ ...baseRow, note: '退款-高德顺风车订单' })).toBeNull(); // 退款属内置识别分支，不学
  });

  it('通用词/过短/纯数字/空文本不学', () => {
    expect(pickRuleKeyword({ ...baseRow, note: '微信转账' })).toBeNull();
    expect(pickRuleKeyword({ ...baseRow, note: '花呗还款' })).toBeNull();
    expect(pickRuleKeyword({ ...baseRow, note: '支付' })).toBeNull();
    expect(pickRuleKeyword({ ...baseRow, payee: 'A' })).toBeNull();
    expect(pickRuleKeyword({ ...baseRow, note: '123456' })).toBeNull();
    expect(pickRuleKeyword({ ...baseRow, payee: '', note: '' })).toBeNull();
  });
});

describe('shouldLearnCorrection：判断修正是否值得沉淀为规则', () => {
  it('类型/账户/分类任一变化即视为有效修正', () => {
    expect(shouldLearnCorrection(baseRow, { ...baseRow, type: 'income' })).toBe(true);
    expect(shouldLearnCorrection(baseRow, { ...baseRow, account: '银行卡' })).toBe(true);
    expect(shouldLearnCorrection(baseRow, { ...baseRow, category: '餐饮' })).toBe(true);
    expect(shouldLearnCorrection(baseRow, { ...baseRow, toAccount: '花呗' })).toBe(true);
  });

  it('与解析原值一致时不学（用户未改动）', () => {
    expect(shouldLearnCorrection(baseRow, { ...baseRow })).toBe(false);
    expect(shouldLearnCorrection(baseRow, { ...baseRow, note: '改了备注' })).toBe(false); // 备注非归类字段
  });

  it('整批归入账户时忽略账户差异（批量覆盖不算逐商户修正）', () => {
    const changed = { ...baseRow, account: '银行卡' };
    expect(shouldLearnCorrection(baseRow, changed, { ignoreAccount: true })).toBe(false);
    expect(shouldLearnCorrection(baseRow, { ...changed, type: 'income' }, { ignoreAccount: true })).toBe(true); // 类型仍学
  });

  it('手动恢复被跳过的中性行为有效修正', () => {
    const skipped = { ...baseRow, _skippedReason: '收支方向为「/」' };
    expect(shouldLearnCorrection(skipped, { ...baseRow, _skippedReason: undefined })).toBe(true);
  });
});

describe('learnRuleFromCorrection：幂等合并', () => {
  it('新增规则：只写入本次改动过的字段', () => {
    const r = learnRuleFromCorrection([], { match: '瑞幸咖啡', type: 'income', account: '银行卡' });
    expect(r.changed).toBe(true);
    expect(r.rules).toEqual([{ match: '瑞幸咖啡', type: 'income', account: '银行卡', toAccount: undefined, category: undefined, enabled: true }]);
  });

  it('同关键词已存在 → 就地更新，保留未改动字段；重复学习不产生重复项', () => {
    const existing = [{ match: '瑞幸咖啡', type: 'expense' as const, category: '餐饮', enabled: true }];
    const first = learnRuleFromCorrection(existing, { match: '瑞幸咖啡', type: 'income' });
    expect(first.changed).toBe(true);
    expect(first.rules).toHaveLength(1);
    expect(first.rules[0]).toMatchObject({ match: '瑞幸咖啡', type: 'income', category: '餐饮', enabled: true });
    // 幂等：同样的修正再来一次 → 无变更
    const again = learnRuleFromCorrection(first.rules, { match: '瑞幸咖啡', type: 'income' });
    expect(again.changed).toBe(false);
    expect(again.rules).toBe(first.rules);
  });

  it('修正后非转账时清掉陈旧的转入账户', () => {
    const existing = [{ match: '星巴克', type: 'transfer' as const, account: '银行卡', toAccount: '花呗', enabled: true }];
    const r = learnRuleFromCorrection(existing, { match: '星巴克', type: 'expense' });
    expect(r.rules[0]).toMatchObject({ type: 'expense', account: '银行卡', toAccount: undefined });
  });

  it('已停用的规则视为用户显式关闭：不更新、不复活', () => {
    const existing = [{ match: '停车费', type: 'expense' as const, category: '交通', enabled: false }];
    const r = learnRuleFromCorrection(existing, { match: '停车费', type: 'expense', category: '餐饮' });
    expect(r.changed).toBe(false);
    expect(r.rules[0].enabled).toBe(false);
    expect(r.rules[0].category).toBe('交通');
  });

  it('空关键词忽略；转账修正写入转入账户', () => {
    expect(learnRuleFromCorrection([], { match: '  ', type: 'expense' }).changed).toBe(false);
    const r = learnRuleFromCorrection([], { match: '工资', type: 'transfer', account: '银行卡', toAccount: '微信' });
    expect(r.rules[0]).toMatchObject({ match: '工资', type: 'transfer', toAccount: '微信' });
  });
});

describe('parseAoaWithMap：自定义模板路径同样生效于资金流向规则', () => {
  it('命中规则时按规则判定类型/账户/分类并标注依据', () => {
    const aoa: unknown[][] = [
      ['日期', '类型', '金额', '账户', '收款方', '备注'],
      ['2026-09-01', '支出', '15', '微信', '停车公司', '停车费'],
    ];
    const map = buildColumnMap(['日期', '类型', '金额', '账户', '收款方', '备注']);
    const rules = [{ match: '停车费', type: 'expense' as const, category: '交通', account: '银行卡', enabled: true }];
    const res = parseAoaWithMap(aoa, map, 0, rules);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ type: 'expense', account: '银行卡', category: '交通' });
    expect(res.rows[0].basis).toContain('自定义规则「停车费」');
  });

  it('不传规则时行为保持与历史一致（无规则覆盖）', () => {
    const aoa: unknown[][] = [
      ['日期', '类型', '金额', '账户', '收款方', '备注'],
      ['2026-09-01', '支出', '15', '微信', '停车公司', '停车费'],
    ];
    const map = buildColumnMap(['日期', '类型', '金额', '账户', '收款方', '备注']);
    const res = parseAoaWithMap(aoa, map);
    expect(res.rows[0]).toMatchObject({ type: 'expense', account: '微信' });
    expect(res.rows[0].basis).toBeUndefined();
  });
});
