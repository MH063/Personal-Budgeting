/**
 * 账单导入自定义规则单元测试。
 * 覆盖：规则解析校验（parseImportRules）、命中匹配（matchImportRule）、
 * 以及规则在 parseBillAOA 中优先级最高（可救回中性行、可覆盖内置还款判定）。
 */
import { describe, it, expect } from 'vitest';
import { parseImportRules, loadImportRules, saveImportRules } from './importRules';
import { parseBillAOA, matchImportRule, type ImportRule } from './import';

/** 构造一张最小可识别的「账单格式」表格（含交易时间/收支/金额列） */
function billAoa(rows: string[][]): unknown[][] {
  return [
    ['交易时间', '收/支', '金额', '交易对方', '商品说明', '收/付款方式', '当前状态'],
    ...rows,
  ];
}

describe('parseImportRules：规则解析与校验', () => {
  it('丢弃缺 match 或非法类型的项，并归一化其余字段', () => {
    const rules = parseImportRules([
      { match: '停车费', type: 'expense', account: '支付宝', category: '交通', enabled: true },
      { match: '', type: 'income' },                    // 缺 match → 丢弃
      { type: 'expense' },                              // 缺 match → 丢弃
      { match: '工资', type: '不是类型' },               // 非法类型 → 回退 expense
      'not-an-object',                                   // 非对象 → 丢弃
    ]);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ match: '停车费', type: 'expense', account: '支付宝', toAccount: undefined, category: '交通', enabled: true });
    expect(rules[1].match).toBe('工资');
    expect(rules[1].type).toBe('expense');
  });

  it('非数组输入返回空数组（不抛错）', () => {
    expect(parseImportRules(null)).toEqual([]);
    expect(parseImportRules('x')).toEqual([]);
    expect(parseImportRules({ match: 'a' })).toEqual([]);
  });

  it('load/save 往返一致（无桌面库时仅内存缓存）', () => {
    const rules: ImportRule[] = [{ match: '星巴克', type: 'expense', category: '餐饮', enabled: true }];
    saveImportRules(rules);
    expect(loadImportRules()).toEqual([{ match: '星巴克', type: 'expense', account: undefined, toAccount: undefined, category: '餐饮', enabled: true }]);
  });
});

describe('matchImportRule：命中匹配', () => {
  const rules: ImportRule[] = [
    { match: '停车费', type: 'expense', enabled: true },
    { match: '工资', type: 'income', enabled: false },
  ];
  it('返回首个启用的包含匹配规则', () => {
    expect(matchImportRule('某某停车费 3元', rules)?.type).toBe('expense');
  });
  it('未启用规则不参与匹配，无命中返回 null', () => {
    expect(matchImportRule('九月工资发放', rules)).toBeNull();
    expect(matchImportRule('', rules)).toBeNull();
  });
});

describe('parseBillAOA：用户规则优先级最高', () => {
  it('规则可救回「不计收支」的中性行，并指定账户与分类', () => {
    const aoa = billAoa([['2026/9/13 17:36', '不计收支', '35.00', '某某停车', '停车费', '支付宝', '交易成功']]);
    // 无规则：中性行被跳过
    const plain = parseBillAOA(aoa);
    expect(plain.rows).toHaveLength(0);
    expect(plain.skippedRows).toHaveLength(1);
    // 有规则：按规则入库
    const ruled = parseBillAOA(aoa, [{ match: '停车费', type: 'expense', account: '支付宝', category: '交通', enabled: true }]);
    expect(ruled.rows).toHaveLength(1);
    expect(ruled.rows[0]).toMatchObject({ type: 'expense', account: '支付宝', category: '交通' });
    expect(ruled.skippedRows).toHaveLength(0);
  });

  it('规则命中优先于内置「还款→转账」判定', () => {
    const aoa = billAoa([['2026/9/13 17:36', '不计收支', '500.00', '花呗', '花呗主动还款', '招商银行卡', '还款成功']]);
    const builtin = parseBillAOA(aoa);
    expect(builtin.rows[0].type).toBe('transfer'); // 内置判定：储蓄卡 → 花呗
    const ruled = parseBillAOA(aoa, [{ match: '花呗主动还款', type: 'repay_in', account: '花呗', enabled: true }]);
    expect(ruled.rows[0].type).toBe('repay_in');
    expect(ruled.rows[0].account).toBe('花呗');
  });
});