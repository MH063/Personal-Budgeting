/**
 * 支付宝 / 微信支付真实账单导入适配单元测试。
 * 覆盖：CSV 文本解析、账单表头识别、收/支方向与不计收支跳过、
 * 5 个交易明细字段（支付时间/付款方式/收款方/订单号/商家订单号）映射。
 */
import { describe, it, expect } from 'vitest';
import {
  parseCsvText, parseBillAOA, normalizeAccountName, inferAccountType, enforceAccountType, accountsMatch,
  rowFingerprint, buildColumnMap, parseTxType, parseAoaWithMap,
  parseBillDate, detectCreditAccount, extractServiceFee, rowKeyOf,
} from './import';

describe('accountsMatch：账户并入已有同义账户（安全档：归一化精确）', () => {
  it('同卡同名/同义词命中，不同尾号不误并', () => {
    expect(accountsMatch('工商银行储蓄卡(1055)', '工商银行储蓄卡(1055)')).toBe(true);
    expect(accountsMatch('支付宝账户', '支付宝')).toBe(true);
    expect(accountsMatch('招商银行卡(1055)', '招商银行卡(6222)')).toBe(false); // 同银行不同卡
  });

  it('不同银行账户不误合并', () => {
    expect(accountsMatch('招商银行卡', '建设银行卡')).toBe(false);
    expect(accountsMatch('工商银行储蓄卡', '湖北农信储蓄卡')).toBe(false);
  });
});

describe('normalizeAccountName：账户名归一化', () => {
  it('去掉促销后缀、保留尾号（不同卡分开）', () => {
    expect(normalizeAccountName('工商银行储蓄卡(1055)&工商银行立减金')).toBe('工商银行储蓄卡(1055)');
    expect(normalizeAccountName('湖北农信储蓄卡(2440)&支付宝随机立减')).toBe('湖北农信储蓄卡(2440)');
    expect(normalizeAccountName('工商银行储蓄卡(1055)')).toBe('工商银行储蓄卡(1055)');
    expect(normalizeAccountName('工商银行储蓄卡(6222)')).toBe('工商银行储蓄卡(6222)');
  });

  it('同义账户归并为同一规范名（支付宝/微信/花呗/白条）', () => {
    expect(normalizeAccountName('支付宝账户')).toBe('支付宝');
    expect(normalizeAccountName('支付宝余额')).toBe('支付宝');
    expect(normalizeAccountName('支付宝钱包')).toBe('支付宝');
    expect(normalizeAccountName('零钱')).toBe('微信');
    expect(normalizeAccountName('微信零钱通')).toBe('微信');
    expect(normalizeAccountName('花呗分期(24期)')).toBe('花呗');
    expect(normalizeAccountName('京东白条')).toBe('白条');
  });

  it('「账户余额」及其括注变体归并为同一账户（避免支付宝同一资金源被拆分）', () => {
    expect(normalizeAccountName('账户余额')).toBe('账户余额');
    expect(normalizeAccountName('账户余额(个人余额)')).toBe('账户余额');
    expect(normalizeAccountName('账户余额（个人余额）')).toBe('账户余额');
  });
});

describe('inferAccountType：按关键词推断类型', () => {
  it('银行卡/信用/钱包/兜底现金', () => {
    expect(inferAccountType('工商银行储蓄卡')).toBe('bank');
    expect(inferAccountType('湖北农信储蓄卡')).toBe('bank');
    expect(inferAccountType('花呗')).toBe('credit');
    expect(inferAccountType('零钱')).toBe('ewallet');
    expect(inferAccountType('支付宝余额')).toBe('ewallet');
    expect(inferAccountType('现金')).toBe('cash');
  });
});

describe('enforceAccountType：类型加固，信用关键词强制为 credit', () => {
  it('名称含花呗/白条/信用/信用卡时无论推断为何都强制 credit', () => {
    expect(enforceAccountType('花呗', 'cash')).toBe('credit');
    expect(enforceAccountType('京东白条', 'cash')).toBe('credit');
    expect(enforceAccountType('信用卡', 'bank')).toBe('credit');
    expect(enforceAccountType('花呗增值服务', 'ewallet')).toBe('credit');
  });
  it('不含信用关键词则退回推断类型（不影响其它类型）', () => {
    expect(enforceAccountType('现金', 'cash')).toBe('cash');
    expect(enforceAccountType('工商银行储蓄卡', 'bank')).toBe('bank');
    expect(enforceAccountType('支付宝余额', 'ewallet')).toBe('ewallet');
  });
});

describe('rowFingerprint：导入去重指纹', () => {
  it('有订单号则优先用订单号判重', () => {
    const a = { date: '2026-09-01', type: 'expense', amount: 35.5, account: '微信', note: '午餐', orderNo: 'O123' };
    const b = { ...a, note: '不同备注' };
    expect(rowFingerprint(a)).toBe('order:O123');
    expect(rowFingerprint(a)).toBe(rowFingerprint(b)); // 同订单号视为同一笔
  });
  it('无订单号按 日期|类型|金额|账户|备注 组合判重；备注仅归一空白', () => {
    const a = { date: '2026-09-01', type: 'expense', amount: 35.5, account: '微信', note: '午饭' };
    const b = { ...a, note: '午  饭' }; // 仅空白差异 → 判同
    const c = { ...a, note: '晚饭' };   // 内容不同 → 判异
    expect(rowFingerprint(a)).toBe(rowFingerprint(b));
    expect(rowFingerprint(a)).not.toBe(rowFingerprint(c));
  });
});

describe('parseCsvText：标准 CSV 解析', () => {
  it('按逗号拆行，处理引号内逗号与转义引号', () => {
    const raw = 'a,b,c\n"x,y",z,"h""i"\n';
    expect(parseCsvText(raw)).toEqual([
      ['a', 'b', 'c'],
      ['x,y', 'z', 'h"i'],
    ]);
  });

  it('空串返回空数组', () => {
    expect(parseCsvText('')).toEqual([]);
  });
});

describe('parseBillAOA：支付宝真实账单', () => {
  // 模拟支付宝导出的 CSV（已拆为二维数组）：前几行为说明行，之后是真实表头与数据
  const aoa: unknown[][] = [
    ['导出信息：', ''],
    ['姓名：魏仕鹏', ''],
    ['交易时间', '交易分类', '交易对方', '对方账号', '商品说明', '收/支', '金额', '收/付款方式', '交易状态', '交易订单号', '商家订单号', '备注'],
    ['2026-09-27 19:02:39', '商业服务', 'Four Directions', 'em', 'VIP会员服务', '支出', '49.00', '湖北农信储蓄卡(2440)', '交易成功', '2026092723001403211426004580', '2026092719022076472664', ''],
    ['2026-09-25 06:33:22', '充值缴费', '中国电信', 'zhi', '话费自动充值', '支出', '59.69', '工商银行储蓄卡(1055)', '交易成功', '2026092523001403211412265161', 'ZY2609250633220084888880', ''],
    ['2026-09-02 10:00:00', '商业服务', '张三', 'z', '退款到账', '收入', '100.00', '支付宝余额', '交易成功', '20260902X', '0001', ''],
    ['2026-09-13 17:36:13', '信用借还', '花呗', '/', '还款', '不计收支', '819.55', '湖北农信', '还款成功', '20260913', '', ''],
    ['2026-09-10 08:00:00', '投资理财', '理财通', '/', '购买理财产品', '不计收支', '500.00', '账户余额', '交易成功', '20260910X', '', ''],
  ];
  const res = parseBillAOA(aoa);
  it('识别为账单格式且正确映射', () => {
    expect(res.detected).toBe(true);
    const [expense1, expense2, income] = res.rows;
    expect(expense1).toMatchObject({
      type: 'expense', amount: 49, date: '2026-09-27',
      payee: 'Four Directions', note: 'VIP会员服务',
      payTime: '2026-09-27 19:02:39',
      payMethod: '湖北农信储蓄卡(2440)',
      orderNo: '2026092723001403211426004580',
      merchantOrderNo: '2026092719022076472664',
    });
    expect(expense2.amount).toBe(59.69);
    expect(income).toMatchObject({ type: 'income', amount: 100, payee: '张三' });
  });

  it('「不计收支」中性行被跳过并记录原因', () => {
    expect(res.skipped.some((s) => s.includes('不计收支'))).toBe(true);
    const neu = res.skippedRows.find((r) => r.amount === 500);
    expect(neu).toBeDefined();
    expect(neu!._skippedReason).toContain('不计收支');
  });

  it('被跳过的行保留原始字段（_skippedReason+账户+日期），供用户手动恢复', () => {
    const neu = res.skippedRows.find((r) => r.amount === 500);
    expect(neu).toBeDefined();
    expect(neu!.account).toBe('账户余额'); // 账户字段保留，可编辑/恢复
    expect(neu!.date).toBe('2026-09-10');
    expect(res.skippedRows.length).toBe(1);
  });

  it('「信用借还」还款行按真实资金流向记为转账（清负债，不误算支出、也不被跳过）', () => {
    const repay = res.rows.find((r) => r.amount === 819.55);
    expect(repay).toBeDefined();
    expect(repay!).toMatchObject({
      type: 'transfer',
      account: '湖北农信',
      toAccount: '花呗',
      date: '2026-09-13',
    });
    expect(repay!._pending).toBeUndefined(); // 来源卡与信用账户均可识别 → 无需待确认
    expect(res.skippedRows.some((r) => r.amount === 819.55)).toBe(false);
  });
});

describe('parseBillAOA：微信支付真实账单', () => {
  const aoa: unknown[][] = [
    ['微信支付账单明细', ''],
    ['共485笔记录', ''],
    ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'],
    ['2026-09-28 19:30:04', '转账', '沐风', '转账备注:微信转账', '支出', '50', '工商银行储蓄卡(1055)', '对方已收钱', '5301000344911', '1000050001202', '/'],
    ['2026-09-26 13:37:44', '商户消费', '某餐厅', '某餐厅', '支出', '17.8', '工商银行储蓄卡(1055)', '支付成功', '4200003143', '48117833598', '/'],
    ['2026-09-01 09:00:00', '转账', '朋友', '红包', '收入', '200', '零钱', '已收款', '6101', '3100', '/'],
    ['2026-09-03 10:00:00', '理财通', '理财', '购买', '中性交易', '100', '零钱', '交易成功', '7101', '4100', '/'],
    ['2026-09-04 11:00:00', '商户消费', '某店', '商品', '支出', '30', '工商银行', '交易关闭', '8101', '5100', '/'],
  ];
  const res = parseBillAOA(aoa);
  it('微信账单正确映射且中性交易/已关闭被跳过', () => {
    expect(res.detected).toBe(true);
    const [expense1, expense2, income] = res.rows;
    expect(expense1).toMatchObject({
      type: 'expense', amount: 50, date: '2026-09-28',
      payee: '沐风',
      account: '工商银行储蓄卡(1055)', // 保留尾号（卡标识），不同卡可区分
      payMethod: '工商银行储蓄卡(1055)', // payMethod 保留完整支付方式
      orderNo: '5301000344911', merchantOrderNo: '1000050001202',
    });
    expect(expense2.amount).toBe(17.8);
    expect(income).toMatchObject({ type: 'income', amount: 200, payee: '朋友' });
    // 中性交易（100）与已关闭（30）均不写入
    expect(res.rows.map((r) => r.amount)).toEqual([50, 17.8, 200]);
  });
});

describe('parseBillAOA：资金流向建模（还款 / 退款 / 提现 / 服务费）', () => {
  // 支付宝账单列：交易时间|交易分类|交易对方|对方账号|商品说明|收/支|金额|收/付款方式|交易状态|交易订单号|商家订单号|备注
  const aliHeader = ['交易时间', '交易分类', '交易对方', '对方账号', '商品说明', '收/支', '金额', '收/付款方式', '交易状态', '交易订单号', '商家订单号', '备注'];
  // 微信账单列：交易时间|交易类型|交易对方|商品|收/支|金额(元)|支付方式|当前状态|交易单号|商户单号|备注
  const wxHeader = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'];

  it('信用账户还款 → 储蓄卡→信用账户 转账（清负债，不新增支出、不被跳过）', () => {
    const res = parseBillAOA([
      aliHeader,
      ['2026-09-13 17:36', '信用借还', '花呗', '/', '花呗主动还款-2026年09月账单', '不计收支', '819.55', '湖北农信储蓄卡(2440)', '还款成功', 'A1', '', ''],
      ['2026-09-20 10:00', '信用借还', '京东白条', '/', '白条还款', '不计收支', '300.00', '工商银行储蓄卡(1055)', '还款成功', 'A2', '', ''],
      ['2026-09-21 10:00', '信用借还', '招商银行信用卡', '/', '信用卡还款-招商银行', '不计收支', '1200.00', '工商银行储蓄卡(1055)', '还款成功', 'A3', '', ''],
    ]);
    expect(res.skippedRows).toHaveLength(0); // 还款行不再当作中性行被丢弃
    expect(res.rows[0]).toMatchObject({ type: 'transfer', account: '湖北农信储蓄卡(2440)', toAccount: '花呗', amount: 819.55 });
    expect(res.rows[1]).toMatchObject({ type: 'transfer', account: '工商银行储蓄卡(1055)', toAccount: '白条', amount: 300 });
    expect(res.rows[2]).toMatchObject({ type: 'transfer', account: '工商银行储蓄卡(1055)', toAccount: '招商银行信用卡', amount: 1200 });
    // 三个信用账户各自独立，绝不混同成一个负债
    expect([...new Set(res.rows.map((r) => r.toAccount))]).toEqual(['花呗', '白条', '招商银行信用卡']);
  });

  it('退款分去向：回花呗 → repay_in（负债减少，不算收入）；回储蓄卡 → income；均标「退款去向待确认」', () => {
    const res = parseBillAOA([
      aliHeader,
      ['2026-09-05 12:00', '退款', '高德', '/', '退款-高德顺风车订单', '不计收支', '40.91', '花呗', '退款成功', 'R1', '', ''],
      ['2026-09-06 12:00', '退款', 'TRAE', '/', '退款-TRAE会员Lite权益', '不计收支', '9.90', '中国银行储蓄卡(9509)', '退款成功', 'R2', '', ''],
    ]);
    expect(res.rows[0]).toMatchObject({ type: 'repay_in', account: '花呗', amount: 40.91, _pending: '退款去向待确认' });
    expect(res.rows[1]).toMatchObject({ type: 'income', account: '中国银行储蓄卡(9509)', amount: 9.9, _pending: '退款去向待确认' });
  });

  it('微信零钱提现 → 本金 transfer(微信→到账卡) + 服务费独立 expense；Excel 序列号日期可解析', () => {
    const res = parseBillAOA([
      wxHeader,
      ['46084.38396990741', '零钱提现', '湖北农信(2440)', '/', '/', '114.43', '湖北农信储蓄卡(2440)', '提现已到账', '2072', '/', '备注:服务费¥0.11'],
    ]);
    expect(res.rows).toHaveLength(2); // 本金 + 服务费
    expect(res.rows[0]).toMatchObject({
      type: 'transfer', account: '微信', toAccount: '湖北农信储蓄卡(2440)', amount: 114.43,
      date: '2026-03-03', // 46084.38 是 Excel 日期序列号
    });
    expect(res.rows[0]._pending).toBeUndefined(); // 账单已明示到账卡 → 不打扰用户
    expect(res.rows[1]).toMatchObject({ type: 'expense', amount: 0.11, category: '手续费' });
    expect(res.rows[1]._rowKey).toBe(`${res.rows[1].line}:fee`);
    expect(rowKeyOf(res.rows[0])).not.toBe(rowKeyOf(res.rows[1])); // 同行派生两行，标识不冲突
  });

  it('支付宝提现：收/付款方式列是「来源」，到账账户未知 → 标待确认，且无服务费时不派生多余行', () => {
    const res = parseBillAOA([
      aliHeader,
      ['2026-02-01 20:11', '账户存取', '湖北省农信社', '/', '提现-实时提现', '不计收支', '755.91', '余额', '交易成功', 'W1', '', ''],
    ]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      type: 'transfer', account: '账户余额', toAccount: '', amount: 755.91, _pending: '提现到账账户待确认',
    });
  });

  it('多信用账户不混同：花呗/白条/信用卡各自识别，非信用渠道不误判', () => {
    expect(detectCreditAccount('花呗主动还款')).toBe('花呗');
    expect(detectCreditAccount('京东白条还款')).toBe('白条');
    expect(detectCreditAccount('招商银行信用卡还款')).toBe('招商银行信用卡');
    expect(detectCreditAccount('支付宝余额')).toBe('');
  });

  it('判定依据 basis：还款/退款/提现/普通收支/服务费等分支都给出可解释文案', () => {
    // 还款 → 转账（来源卡 → 信用账户）
    const repay = parseBillAOA([
      aliHeader,
      ['2026-09-13 17:36', '信用借还', '花呗', '/', '还款', '不计收支', '819.55', '湖北农信储蓄卡(2440)', '还款成功', 'A1', '', ''],
    ]);
    expect(repay.rows[0].basis).toContain('转账');

    // 退款回信用账户 → 负债减少；回储蓄卡 → 收入
    const refundCredit = parseBillAOA([
      aliHeader,
      ['2026-09-01 10:00', '退款', '花呗', '/', '退款到账', '不计收支', '50', '花呗', '退款成功', 'R1', '', ''],
    ]);
    expect(refundCredit.rows[0].type).toBe('repay_in');
    expect(refundCredit.rows[0].basis).toContain('负债减少');
    const refundCard = parseBillAOA([
      aliHeader,
      ['2026-09-01 10:00', '退款', '某店', '/', '退款到账', '收入', '50', '工商银行储蓄卡(1055)', '退款成功', 'R2', '', ''],
    ]);
    expect(refundCard.rows[0].type).toBe('income');
    expect(refundCard.rows[0].basis).toContain('收入');

    // 提现 → 转账；服务费单独记，依据为手续费
    const withdraw = parseBillAOA([
      wxHeader,
      ['2026-03-03 10:00', '零钱提现', '湖北省农信社', '提现到银行卡', '不计收支', '114.54', '湖北农信储蓄卡(2440)', '交易成功', 'W', '', '服务费0.11元'],
    ]);
    const tx = withdraw.rows.find((r) => r.type === 'transfer');
    const feeRow = withdraw.rows.find((r) => r.category === '手续费');
    expect(tx?.basis).toContain('转账');
    expect(feeRow?.basis).toContain('手续费');

    // 普通收入/支出 → 依据收支方向列
    const normal = parseBillAOA([
      aliHeader,
      ['2026-09-10 08:00', '商业服务', '某店', '/', '购物', '支出', '35', '微信', '交易成功', 'N1', '', ''],
    ]);
    expect(normal.rows[0].basis).toContain('支出');
  });

  it('判定依据 basis：命中自定义资金流向规则时标注规则并优先于内置识别', () => {
    const rules = [{ match: '停车费', type: 'expense' as const, category: '交通', enabled: true }];
    const res = parseBillAOA(
      [
        aliHeader,
        ['2026-09-15 12:00', '商业服务', '停车公司', '/', '停车费', '不计收支', '15', '微信', '交易成功', 'R1', '', ''],
      ],
      rules,
    );
    const hit = res.rows[0];
    expect(hit.type).toBe('expense');
    expect(hit.basis).toContain('自定义规则「停车费」');
    expect(hit.category).toBe('交通');
  });

  it('parseBillDate：斜杠/紧凑日期（月日补零）与 Excel 序列号；extractServiceFee 兼容多种写法', () => {
    expect(parseBillDate('2026/9/13 17:36')).toBe('2026-09-13'); // 支付宝真实格式，必须补零
    expect(parseBillDate('2026-09-13')).toBe('2026-09-13');
    expect(parseBillDate('20260913')).toBe('2026-09-13');
    expect(parseBillDate(46084.38396990741)).toBe('2026-03-03'); // 微信账单的 Excel 序列号
    expect(parseBillDate('不是日期')).toBe('');
    expect(extractServiceFee('备注:服务费¥0.11')).toBe(0.11);
    expect(extractServiceFee('服务费 0.32 元')).toBe(0.32);
    expect(extractServiceFee('无手续费')).toBe(0);
  });
});

describe('parseBillAOA：非账单格式不误判', () => {
  it('自定义模板（无交易时间/收支列）detected=false', () => {
    const aoa: unknown[][] = [
      ['日期', '类型', '金额', '账户', '备注'],
      ['2026-09-01', '支出', '35.5', '微信', '午饭'],
    ];
    const res = parseBillAOA(aoa);
    expect(res.detected).toBe(false);
    expect(res.rows).toEqual([]);
  });
});

describe('parseBillAOA：表头列名容错', () => {
  it('表头用词/写法变化仍能识别并映射', () => {
    // 「交易时间」带空格全角、金额带括号、支付的列名改动、单号别名 → 均应容错命中
    const aoa: unknown[][] = [
      ['账单说明'],
      [' 交易时间 ', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'],
      ['2026-09-28 19:30:04', '转账', '沐风', '转账备注', '支出', '50', '工商银行储蓄卡(1055)', '对方已收钱', '5301000344911', '1000050001202', '/'],
    ];
    const res = parseBillAOA(aoa);
    expect(res.detected).toBe(true);
    const row = res.rows[0];
    expect(row).toMatchObject({
      type: 'expense', amount: 50, date: '2026-09-28', payee: '沐风',
      account: '工商银行储蓄卡(1055)', orderNo: '5301000344911', merchantOrderNo: '1000050001202',
    });
  });
});

describe('parseBillAOA：多平台账单表头（招商/云闪付/京东/美团常见列名）', () => {
  it('云闪付/银联风格：记账日期+借贷标志+交易金额+对方账户', () => {
    const aoa: unknown[][] = [
      ['银联云闪付交易明细'],
      ['记账日期', '交易时间', '借贷标志', '交易金额', '商户名称', '对方账户', '付款账户', '交易状态', '流水号', '备注'],
      ['2026/09/01', '12:03:00', '支出', '35.00', '某便利店', '6222021234', '招商银行卡(1055)', '成功', 'T202609011203', '早饭'],
    ];
    const res = parseBillAOA(aoa);
    expect(res.detected).toBe(true);
    expect(res.rows[0]).toMatchObject({
      type: 'expense', amount: 35, date: '2026-09-01',
      account: '招商银行卡(1055)', // 付款账户映射为渠道/账户
      payee: '某便利店',
    });
  });

  it('京东/购物风格：交易时间+商品分类+收支+金额+商家', () => {
    const aoa: unknown[][] = [
      ['交易时间', '商品分类', '商家名称', '收支', '金额', '状态', '订单号', '备注'],
      ['2026-09-05 15:22:01', '数码家电', '京东自营', '支出', '1599.00', '订单完成', 'JD20260905152201', '买耳机'],
    ];
    const res = parseBillAOA(aoa);
    expect(res.detected).toBe(true);
    expect(res.rows[0]).toMatchObject({ type: 'expense', amount: 1599, date: '2026-09-05', payee: '京东自营' });
    expect(res.rows[0].orderNo).toBe('JD20260905152201');
  });

  it('日期为紧凑 YYYYMMDD 也能解析', () => {
    const aoa: unknown[][] = [
      ['交易时间', '交易类型', '金额', '收/支'],
      ['20260927060239', '商户消费', '20', '支出'],
    ];
    const res = parseBillAOA(aoa);
    expect(res.detected).toBe(true);
    expect(res.rows[0].date).toBe('2026-09-27');
  });
});

describe('列映射预览：buildColumnMap / parseTxType / parseAoaWithMap', () => {
  it('buildColumnMap 自动推断常见表头映射', () => {
    const map = buildColumnMap(['日期', '类型', '金额', '账户', '备注']);
    expect(map.date).toBe(0);
    expect(map.type).toBe(1);
    expect(map.amount).toBe(2);
    expect(map.account).toBe(3);
    expect(map.note).toBe(4);
  });

  it('parseTxType 识别收支、转账与负债减少，中性返回 null', () => {
    expect(parseTxType('收入')).toBe('income');
    expect(parseTxType('支出')).toBe('expense');
    expect(parseTxType('转账')).toBe('transfer');
    expect(parseTxType('负债减少')).toBe('repay_in');
    expect(parseTxType('还款')).toBe('repay_in');
    expect(parseTxType('不计收支')).toBeNull();
    expect(parseTxType('中性')).toBeNull();
  });

  it('下载模板（12 列）自动映射：付款方式归 payMethod 而非 account，且含负债减少行可解析', () => {
    // 与 ImportManage.downloadTemplate 的模板列保持一致
    const header = ['日期', '类型', '金额', '账户', '转入账户', '分类', '备注', '支付时间', '付款方式', '收款方', '订单号', '商家订单号'];
    const map = buildColumnMap(header);
    expect(map.date).toBe(0);
    expect(map.type).toBe(1);
    expect(map.amount).toBe(2);
    expect(map.account).toBe(3);
    expect(map.toAccount).toBe(4);
    expect(map.category).toBe(5);
    expect(map.note).toBe(6);
    expect(map.payTime).toBe(7);
    // 「付款方式」必须归 payMethod（此前会被 account 的歧义别名抢先认领）
    expect(map.payMethod).toBe(8);
    expect(map.payee).toBe(9);
    expect(map.orderNo).toBe(10);
    expect(map.merchantOrderNo).toBe(11);
    const aoa: unknown[][] = [
      header,
      ['2026-09-04', '负债减少', '99', '信用卡', '', '还款', '信用卡还款', '2026-09-04 15:20:00', '银行卡', '招商银行', '', ''],
      ['2026-09-05', '支出', '0', '微信', '', '', '', '', '', '', '', ''],
    ];
    const res = parseAoaWithMap(aoa, map);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      type: 'repay_in', amount: 99, account: '信用卡', category: '还款',
      payTime: '2026-09-04 15:20:00', payMethod: '银行卡', payee: '招商银行',
    });
    expect(res.skipped.length).toBeGreaterThan(0); // 金额 0 行被跳过
  });

  it('parseAoaWithMap 按用户指定列解析（含 5 交易字段），漏金额/类型行被跳过', () => {
    const aoa: unknown[][] = [
      ['日期', '方向', '金额', '账户', '收款方', '订单号'],
      ['2026-09-01', '支出', '35.5', '微信', '某餐厅', 'O123'],
      ['2026-09-02', '收入', '100', '支付宝', '某人', 'O124'],
      ['2026-09-03', '', '0', '微信', 'x', ''],
    ];
    const map = buildColumnMap(['日期', '方向', '金额', '账户', '收款方', '订单号']);
    const res = parseAoaWithMap(aoa, map);
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({ type: 'expense', amount: 35.5, date: '2026-09-01', account: '微信', payee: '某餐厅', orderNo: 'O123' });
    expect(res.rows[1]).toMatchObject({ type: 'income', amount: 100, payee: '某人' });
    expect(res.skipped.length).toBeGreaterThan(0); // 第三行金额 0/类型空被跳过
  });

  it('用户可手动改映射（把账户列改到另一列）', () => {
    const aoa: unknown[][] = [
      ['日期', '类型', '金额', '备注', '账户'],
      ['2026-09-01', '支出', '20', '午饭', '现金'],
    ];
    const map = buildColumnMap(['日期', '类型', '金额', '备注', '账户']);
    const res = parseAoaWithMap(aoa, map);
    expect(res.rows[0].account).toBe('现金'); // 账户列在第 5 列也被正确推断
  });
});