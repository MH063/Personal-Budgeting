/**
 * 票据 OCR → AI 解析成账模块单元测试。
 * 覆盖：脱敏后才上送、名称白名单组装、AI 解析路径、未配置 AI 不阻断。
 */
import { describe, it, expect } from 'vitest';
import { ocrTextToItems, buildOcrPrompt, heuristicExtractOcrItems } from '@/api/ocrBook';
import { maskSensitive } from '@/lib/sanitize';
import type { Account } from '@/api/accounts';
import type { Category } from '@/api/categories';

const accounts: Account[] = [
  { id: 1, name: '现金', type: 'cash', balance: 0, initial_balance: 0, icon: '💵', color: '#10B981', is_active: 1, sort_order: 1, note: '' },
  { id: 2, name: '招商银行卡', type: 'bank', balance: 0, initial_balance: 0, icon: '🏦', color: '#1E6FA9', is_active: 1, sort_order: 2, note: '' },
];

const cats: Category[] = [
  { id: 1, name: '餐饮', type: 'expense', icon: '🍜', color: '#EF4444', sort_order: 1, is_active: 1 },
  { id: 2, name: '工资', type: 'income', icon: '💰', color: '#10B981', sort_order: 1, is_active: 1 },
];

describe('buildOcrPrompt：名称白名单组装', () => {
  it('仅包含账户/分类名称，不含余额等明细', () => {
    const user = buildOcrPrompt('识别文本', accounts, cats);
    expect(user).toContain('现金');
    expect(user).toContain('招商银行卡');
    expect(user).toContain('餐饮'); // 支出分类
    expect(user).toContain('工资'); // 收入分类
    expect(user).toContain('识别文本');
    expect(user).not.toContain('balance');
  });
});

describe('ocrTextToItems：脱敏与解析', () => {
  it('发送给 AI 的内容已脱敏，手机号被掩码；解析成功返回账目', async () => {
    let sent = '';
    const mockChat = async (messages: { role: string; content: string }[]) => {
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      sent = user;
      return '[{"type":"expense","amount":25,"categoryName":"餐饮","accountName":"现金"}]';
    };
    const ocrText = '午饭 25元 13812345678';
    const res = await ocrTextToItems(ocrText, accounts, cats, mockChat);
    expect(res.aiParsed).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ type: 'expense', amount: 25, accountId: 1, categoryId: 1 });
    // 脱敏：发给 AI 的 user 内容不应出现完整手机号
    expect(sent).not.toContain('13812345678');
    // 返回给 UI 的展示文本也是脱敏后的
    expect(res.text).not.toContain('13812345678');
  });

  it('未配置 AI（chat 抛错）时不阻断，返回脱敏文本与空账目', async () => {
    const mockChat = async () => { throw new Error('未启用或未配置 AI'); };
    const res = await ocrTextToItems('打车 6222021234567890 元', accounts, cats, mockChat);
    expect(res.aiParsed).toBe(false);
    expect(res.items).toEqual([]);
    expect(res.text).toBeDefined();
    // 银行卡号已被脱敏
    expect(res.text).not.toContain('6222021234567890');
  });

  it('空识别文本返回空结果，不调用 AI', async () => {
    let called = false;
    const mockChat = async () => { called = true; return '[]'; };
    const res = await ocrTextToItems('   ', accounts, cats, mockChat);
    expect(called).toBe(false);
    expect(res.items).toEqual([]);
    expect(res.text).toBe('');
  });

  it('AI 返回非法 JSON 时回退为空账目但不抛错', async () => {
    const mockChat = async () => '抱歉，无法解析';
    const res = await ocrTextToItems('午饭25元', accounts, cats, mockChat);
    expect(res.items).toEqual([]);
    expect(res.text).toContain('午饭');
  });
});

describe('heuristicExtractOcrItems：无 AI 本地启发式解析', () => {
  it('从完整小票文本中解析出金额/日期/支付时间/付款方式/收款方/两条订单号/商品说明', () => {
    const text = [
      '某某餐饮店',
      '商品说明：午餐',
      '2026-09-27 12:03',
      '付款方式：微信支付',
      '收款方全称：某某餐饮店',
      '订单号：20260927123456789012',
      '商家订单号：S123456789',
      '合计：¥32.20',
    ].join('\n');
    const res = heuristicExtractOcrItems(text, accounts, cats);
    expect(res).toHaveLength(1);
    const got = res[0];
    expect(got).toMatchObject({
      type: 'expense',
      amount: 32.2,
      date: '2026-09-27',
      payTime: '2026-09-27 12:03',
      payMethod: '微信支付',
      payee: '某某餐饮店',
      orderNo: '20260927123456789012',
      merchantOrderNo: 'S123456789',
    });
    expect(got.note).toContain('午餐');
    // 账户/分类未匹配，标记供表单手动补选
    expect(got.unmatched).toContain('account');
  });

  it('金额优先采用「合计」关联值，而不是订单中的最大数字', () => {
    const text = '订单号 288644001 小计 ¥12.00 合计 ¥32.20';
    const res = heuristicExtractOcrItems(text, accounts, cats);
    expect(res).toHaveLength(1);
    expect(res[0].amount).toBe(32.2);
    expect(res[0].orderNo).toBe('288644001');
  });

  it('无有效金额时返回空数组（不会把无小数点的纯数字当金额）', () => {
    const res = heuristicExtractOcrItems('打车 6222021234567890 元', accounts, cats);
    expect(res).toEqual([]);
  });

  it('只有日期没有具体时间时，支付时间回退为该日期', () => {
    const res = heuristicExtractOcrItems('合计：¥50\n2026-09-27', accounts, cats);
    expect(res).toHaveLength(1);
    expect(res[0].payTime).toBe('2026-09-27');
  });

  it('中文日期格式（2026年9月27日）能被解析到 date 与支付时间', () => {
    const res = heuristicExtractOcrItems('合计：¥20\n2026年9月27日 19:02', accounts, cats);
    expect(res[0].date).toBe('2026-09-27');
    expect(res[0].payTime).toBe('2026-09-27 19:02');
  });

  it('仅出现「商家订单号」时，orderNo 为空、merchantOrderNo 被正确抽取（标签不互相误匹配）', () => {
    const res = heuristicExtractOcrItems('合计：¥9\n商家订单号：M888999', accounts, cats);
    expect(res[0].orderNo).toBeUndefined();
    expect(res[0].merchantOrderNo).toBe('M888999');
  });

  it('无货币符号金额也能被识别（合计 32.2）', () => {
    const res = heuristicExtractOcrItems('合计 32.2', accounts, cats);
    expect(res).toHaveLength(1);
    expect(res[0].amount).toBeCloseTo(32.2);
  });

  it('存在多个订单号时取标签后的第一个', () => {
    const res = heuristicExtractOcrItems('合计：¥5\n订单号：AAA111\n交易单号：222333', accounts, cats);
    expect(res[0].orderNo).toBe('AAA111');
  });

  it('订单号紧邻处是金额/短数字时，不把金额当订单号，仍取到真正的订单号', () => {
    const res = heuristicExtractOcrItems('合计：¥32.20\n订单号：¥32.20\n20260927123456789012', accounts, cats);
    // 金额 32 因紧邻判定不足长度被跳过，订单号取自后文长编号（防止跨字段漂移）
    expect(res[0].orderNo).toBe('20260927123456789012');
    expect(res[0].amount).toBe(32.2);
  });

  it('标签与值被冒号后的换行隔开时，仍能取到紧邻编号', () => {
    const res = heuristicExtractOcrItems('合计：¥9\n订单号：\n M-882211', accounts, cats);
    expect(res[0].orderNo).toBe('M-882211');
  });

  it('订单号紧邻值过短（不足长度）时不作为订单号返回', () => {
    const res = heuristicExtractOcrItems('合计：¥9\n订单号：123\n商品编码：88886666', accounts, cats);
    // 紧邻的 123 太短不当作订单；回退深度扫描时 88886666 同样非紧邻，属尽力而为，不影响核心字段
    expect(res[0].amount).toBe(9);
    expect(res[0].payee).toBeUndefined();
  });

  it('备注不从首行商户名兜底提取，避免与收款方/金额语义重复（无「商品说明」标签时不把商户名写进备注）', () => {
    // 首行「某某餐饮店」是商户名/收款方，不应抄进备注；备注为默认文案，收款方来自商家名称
    const res = heuristicExtractOcrItems('某某餐饮店\n合计：¥20\n商家名称：某某餐饮店', accounts, cats);
    expect(res[0].note).not.toContain('某某餐饮店');
    expect(res[0].payee).toBe('某某餐饮店');
    expect(res[0].amount).toBe(20);
  });

  it('有「商品说明」标签时备注只取该标签内容，不混入商户名', () => {
    const res = heuristicExtractOcrItems('超市\n商品说明：可乐、薯片\n收款方：社区超市\n合计：¥8.5', accounts, cats);
    expect(res[0].note).toBe('可乐、薯片');
    expect(res[0].payee).toBe('社区超市');
  });

  it('付款方式独立于账户回填：账户未匹配时，付款方式仍被独立抽取（二者互不干扰/覆盖）', () => {
    const res = heuristicExtractOcrItems('某商户\n付款方式：微信支付\n收款方：某商户\n合计：¥12', accounts, cats);
    // 付款方式不受「账户未匹配」影响，正常抽取
    expect(res[0].payMethod).toBe('微信支付');
    expect(res[0].payee).toBe('某商户');
    // 账户仍未匹配（启发式无法可靠映射名称→ID），但不阻断付款方式
    expect(res[0].accountId).toBeUndefined();
    expect(res[0].unmatched).toContain('account');
  });

  it('未识别到付款方式时 payMethod 为空，账户/其它字段不受影响', () => {
    const res = heuristicExtractOcrItems('收款方：某店\n合计：¥6', accounts, cats);
    expect(res[0].payMethod).toBeUndefined();
    expect(res[0].payee).toBe('某店');
    expect(res[0].amount).toBe(6);
  });
});

describe('订单号脱敏统一（maskSensitive）', () => {
  it('订单号语境的长编号不被当银行卡掩码（保留，供 AI/启发式一致回填）', () => {
    expect(maskSensitive('订单号：20260927123456789012 合计 ¥32.20')).toContain('20260927123456789012');
  });

  it('真银行卡（无订单号语境）仍被掩码', () => {
    expect(maskSensitive('刷卡 6222021234567890 元')).not.toContain('6222021234567890');
  });

  it('商家订单号同样保留', () => {
    expect(maskSensitive('商家订单号：S123456789')).toContain('S123456789');
  });

  it('ocrTextToItems 预览文本保留订单号，与启发式提取结果一致', async () => {
    const noAi = async () => { throw new Error('未配置'); };
    const r = await ocrTextToItems('订单号：20260927123456789012\n合计：¥32.20', accounts, cats, noAi);
    // 脱敏后的展示文本与启发式取到的订单号一致（不再被银行卡规则掩码）
    expect(r.text).toContain('20260927123456789012');
    expect(r.items[0].orderNo).toBe('20260927123456789012');
  });
});

describe('ocrTextToItems：本地启发式兜底提取新字段', () => {
  it('chat 抛错时仍提取交易明细 5 字段', async () => {
    const mockChat = async () => { throw new Error('未启用或未配置 AI'); };
    const text = '商品说明：奶茶\n2026/9/27 19:02\n付款方式：支付宝\n收款方全称：某饮品店\n商家订单号：M998877\n合计 ¥15';
    const res = await ocrTextToItems(text, accounts, cats, mockChat);
    expect(res.aiParsed).toBe(false);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      amount: 15,
      date: '2026-09-27',
      payTime: '2026-09-27 19:02',
      payMethod: '支付宝',
      payee: '某饮品店',
      merchantOrderNo: 'M998877',
    });
  });
});