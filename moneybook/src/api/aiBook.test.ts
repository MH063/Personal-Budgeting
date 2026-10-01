/**
 * AI 自然语言记账解析模块单元测试。
 * 覆盖：JSON 数组稳健提取、zod 严格校验与非法项过滤、
 * 账户/分类模糊匹配（精确/包含/归一）、多语句拆分。
 */
import { describe, it, expect } from 'vitest';
import {
  extractBookArray,
  parseBookOutput,
  toBookItem,
  splitStatements,
  BOOK_SYSTEM,
} from '@/api/aiBook';
import type { Account } from '@/api/accounts';
import type { Category } from '@/api/categories';

const accounts: Account[] = [
  { id: 1, name: '现金', type: 'cash', balance: 0, initial_balance: 0, icon: '💵', color: '#10B981', is_active: 1, sort_order: 1, note: '' },
  { id: 2, name: '微信', type: 'ewallet', balance: 0, initial_balance: 0, icon: '💬', color: '#3B82F6', is_active: 1, sort_order: 2, note: '' },
  { id: 3, name: '招商银行卡', type: 'bank', balance: 0, initial_balance: 0, icon: '🏦', color: '#1E6FA9', is_active: 1, sort_order: 3, note: '' },
];

const cats: Category[] = [
  { id: 1, name: '餐饮', type: 'expense', icon: '🍜', color: '#EF4444', sort_order: 1, is_active: 1 },
  { id: 2, name: '工资', type: 'income', icon: '💰', color: '#10B981', sort_order: 1, is_active: 1 },
  { id: 3, name: '交通', type: 'expense', icon: '🚌', color: '#3B82F6', sort_order: 2, is_active: 1 },
];

describe('extractBookArray：JSON 数组稳健提取', () => {
  it('剥离 ```json 围栏并解析数组', () => {
    const raw = '```json\n[{"type":"expense","amount":25}]\n```';
    const out = extractBookArray(raw);
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(1);
    expect((out[0] as Record<string, unknown>).amount).toBe(25);
  });

  it('解析带前缀文字的数组（只取 [] 内含内容）', () => {
    const raw = '好的，以下是解析结果：[{"amount":30}] 完毕';
    const out = extractBookArray(raw);
    expect((out[0] as Record<string, unknown>).amount).toBe(30);
  });

  it('无数组时返回空数组（异常不抛出）', () => {
    expect(extractBookArray('我无法理解你的需求')).toEqual([]);
  });

  it('损坏 JSON 返回空数组', () => {
    expect(extractBookArray('[{bad json')).toEqual([]);
  });

  it('非数组顶层（对象）返回空数组', () => {
    expect(extractBookArray('{"amount":1}')).toEqual([]);
  });
});

describe('parseBookOutput：zod 严格校验与过滤', () => {
  it('合法条目被保留', () => {
    const raw = '[{"type":"expense","amount":25,"categoryName":"餐饮","accountName":"现金"}]';
    const items = parseBookOutput(raw, accounts, cats);
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({ type: 'expense', amount: 25, accountId: 1, categoryId: 1 });
  });

  it('金额非法（负数/零/字符串）的条目被过滤', () => {
    const raw = '[{"amount":-5},{"amount":0},{"amount":"abc"},{"amount":12}]';
    const items = parseBookOutput(raw, accounts, cats);
    expect(items.length).toBe(1);
    expect(items[0].amount).toBe(12);
  });

  it('type 不在枚举内被过滤（zod 校验）', () => {
    const raw = '[{"type":"investment","amount":10},{"type":"income","amount":20}]';
    const items = parseBookOutput(raw, accounts, cats);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('income');
  });

  it('字段缺失时不抛错，type/date 使用默认值', () => {
    const items = parseBookOutput('[{"amount":30}]', accounts, cats);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('expense');
    expect(items[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('无效输入（非 JSON）返回空列表，不抛异常', () => {
    expect(parseBookOutput('抱歉，我无法解析', accounts, cats)).toEqual([]);
    expect(parseBookOutput('', accounts, cats)).toEqual([]);
    expect(parseBookOutput('null', accounts, cats)).toEqual([]);
  });

  it('多条混合：合法保留、非法丢弃', () => {
    const raw = '[{"type":"expense","amount":1},{"amount":-9},{"type":"income","amount":2,"categoryName":"工资"}]';
    const items = parseBookOutput(raw, accounts, cats);
    expect(items).toHaveLength(2);
    expect(items[0].amount).toBe(1);
    expect(items[1]).toMatchObject({ type: 'income', categoryId: 2 });
  });
});

describe('解析结果回填：交易 5 个扩展字段（payTime/payMethod/payee/orderNo/merchantOrderNo）', () => {
  it('AI 输出的 5 个字段被映射为 AiBookItem 对应字段', () => {
    const raw = '[{"type":"expense","amount":32.2,"categoryName":"餐饮","accountName":"现金","date":"2026-09-27","note":"午餐","payTime":"2026-09-27 12:03","payMethod":"微信支付","payee":"某某餐饮店","orderNo":"20260927123456789012","merchantOrderNo":"S123456789"}]';
    const items = parseBookOutput(raw, accounts, cats);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      payTime: '2026-09-27 12:03',
      payMethod: '微信支付',
      payee: '某某餐饮店',
      orderNo: '20260927123456789012',
      merchantOrderNo: 'S123456789',
    });
  });

  it('5 个字段为空字符串/纯空白/缺失时被清除为 undefined（不把空串写库）', () => {
    const items = parseBookOutput(
      '[{"type":"expense","amount":10,"date":"2026-09-27","payTime":"","payMethod":"  ","payee":"","merchantOrderNo":""}]',
      accounts, cats
    );
    expect(items[0].payTime).toBeUndefined();
    expect(items[0].payMethod).toBeUndefined();
    expect(items[0].payee).toBeUndefined();
    expect(items[0].merchantOrderNo).toBeUndefined();
    expect(items[0].date).toBe('2026-09-27'); // 日期字段不受影响
  });

  it('多条账单各自携带独立的 5 字段，互不串扰', () => {
    const raw = '[' +
      '{"type":"expense","amount":12,"payTime":"2026-09-27 09:00","payMethod":"微信支付","orderNo":"O-001"},' +
      '{"type":"expense","amount":8,"payTime":"2026-09-27 18:30","payMethod":"支付宝","orderNo":"O-002"}]';
    const items = parseBookOutput(raw, accounts, cats);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ payTime: '2026-09-27 09:00', payMethod: '微信支付', orderNo: 'O-001' });
    expect(items[1]).toMatchObject({ payTime: '2026-09-27 18:30', payMethod: '支付宝', orderNo: 'O-002' });
  });
});

describe('toBookItem：账户/分类模糊匹配', () => {
  it('精确名称匹配', () => {
    const item = toBookItem({ type: 'expense', amount: 10, accountName: '微信' }, accounts, cats);
    expect(item?.accountId).toBe(2);
  });

  it('包含匹配（部分名称）', () => {
    const item = toBookItem({ type: 'expense', amount: 10, accountName: '招商' }, accounts, cats);
    // contains 匹配命中「招商银行卡」
    expect(item?.accountId).toBe(3);
  });

  it('去空白/符号归一匹配', () => {
    const item = toBookItem({ type: 'expense', amount: 10, accountName: '招商 银行' }, accounts, cats);
    expect(item?.accountId).toBe(3);
  });

  it('账户不存在 → accountId 缺失并标记 unmatched', () => {
    const item = toBookItem({ type: 'expense', amount: 10, accountName: '不存在的账户' }, accounts, cats);
    expect(item?.accountId).toBeUndefined();
    expect(item?.unmatched).toContain('account');
  });

  it('分类不存在 → categoryId 缺失并标记 unmatched（不抛错）', () => {
    const item = toBookItem({ type: 'expense', amount: 10, accountName: '现金', categoryName: '不存在的分类' }, accounts, cats);
    expect(item?.categoryId).toBeUndefined();
    expect(item?.unmatched).toContain('category');
  });

  it('转账需匹配转入账户（toAccountId）', () => {
    const item = toBookItem({ type: 'transfer', amount: 100, accountName: '现金', toAccountName: '微信' }, accounts, cats);
    expect(item?.toAccountId).toBe(2);
  });

  it('转账无转入账户 → 标记 account 未匹配', () => {
    const item = toBookItem({ type: 'transfer', amount: 100, accountName: '现金' }, accounts, cats);
    expect(item?.toAccountId).toBeUndefined();
    expect(item?.unmatched).toContain('account');
  });

  it('金额无效返回 null', () => {
    expect(toBookItem({ type: 'expense', amount: 0, accountName: '现金' }, accounts, cats)).toBeNull();
  });

  it('date 非法时回退为今天（不抛错）', () => {
    const item = toBookItem({ type: 'expense', amount: 10, accountName: '现金', date: 'not-a-date' }, accounts, cats);
    expect(item?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('账户匹配与付款方式独立：payMethod 抽取不干预 accountId 名称匹配结果', () => {
    // AI 同时给出 accountName 与 payMethod，二者各自独立生效
    const item = toBookItem({ type: 'expense', amount: 10, accountName: '微信', payMethod: '微信支付' }, accounts, cats);
    expect(item?.accountId).toBe(2);      // 账户仍按名称正确匹配到「微信」
    expect(item?.payMethod).toBe('微信支付'); // 付款方式独立带入
  });

  it('AI 未给付款方式时产生 payMethod=undefined，账户匹配不受影响', () => {
    const item = toBookItem({ type: 'expense', amount: 10, accountName: '现金' }, accounts, cats);
    expect(item?.accountId).toBe(1);
    expect(item?.payMethod).toBeUndefined();
  });

  it('账户未匹配不影响付款方式独立回填', () => {
    const item = toBookItem({ type: 'expense', amount: 10, accountName: '不存在的账户', payMethod: '银行卡' }, accounts, cats);
    expect(item?.accountId).toBeUndefined();
    expect(item?.unmatched).toContain('account');
    expect(item?.payMethod).toBe('银行卡'); // 即使账户缺失，付款方式仍保留
  });
});

describe('splitStatements：多语句拆分', () => {
  it('按换行/分号/句号拆分并去空', () => {
    const s = '午饭 25 元；打车 10 元\n房租 1000 元。工资 5000 元';
    expect(splitStatements(s)).toEqual(['午饭 25 元', '打车 10 元', '房租 1000 元', '工资 5000 元']);
  });

  it('空串/空白输入返回空数组', () => {
    expect(splitStatements('')).toEqual([]);
    expect(splitStatements('   ; \n ')).toEqual([]);
  });

  it('无分隔符时整体为一条', () => {
    expect(splitStatements('午饭 25 元')).toEqual(['午饭 25 元']);
  });
});

describe('BOOK_SYSTEM：安全规范与输出约束', () => {
  it('明确要求只能使用给定的名称清单（防编造）', () => {
    expect(BOOK_SYSTEM).toContain('只能从系统给出的');
    expect(BOOK_SYSTEM).toContain('绝不能编造');
  });

  it('要求输出严格 JSON 数组并禁止代码块标记', () => {
    expect(BOOK_SYSTEM).toContain('只返回 JSON 数组');
    expect(BOOK_SYSTEM).toContain('不要任何解释、代码块标记');
  });
});