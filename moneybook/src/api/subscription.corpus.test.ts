/**
 * 订阅分类标注集（P0-2）：用一份人工标注的小样本评估 classifyRecurring 的误判率/漏判率。
 * 这是"反馈闭环"的起点：样本持续扩充即可作为回归集，防止规则改动引入新的误判。
 */
import { describe, it, expect } from 'vitest';
import { classifyRecurring, type RecurringClass } from './subscription';

interface Label { payee: string; amount: number; category: RecurringClass['category']; isSubscription: boolean; }

/** 人工标注集（payee 需要贴近真实账单文案，含易混淆边界 case） */
const CORPUS: Label[] = [
  // —— 明确的付费订阅 ——
  { payee: '爱奇艺会员', amount: 25, category: 'subscription', isSubscription: true },
  { payee: '腾讯视频 VIP', amount: 25, category: 'subscription', isSubscription: true },
  { payee: '网易云音乐', amount: 15, category: 'subscription', isSubscription: true },
  { payee: '百度网盘超级会员', amount: 30, category: 'subscription', isSubscription: true },
  { payee: 'iCloud 存储', amount: 6, category: 'subscription', isSubscription: true },
  { payee: '美团外卖会员', amount: 15, category: 'subscription', isSubscription: true },
  { payee: '喜马拉雅VIP', amount: 22, category: 'subscription', isSubscription: true },
  { payee: 'B站大会员', amount: 25, category: 'subscription', isSubscription: true },
  { payee: '知乎盐选会员', amount: 19, category: 'subscription', isSubscription: true },
  { payee: 'WPS超级会员', amount: 89, category: 'subscription', isSubscription: true },
  // —— 话费/宽带/流量（订阅性服务，但当季波动不报涨价）——
  { payee: '移动话费充值', amount: 100, category: 'subscription', isSubscription: true },
  { payee: '联通流量套餐', amount: 50, category: 'subscription', isSubscription: true },
  // —— 住房刚性 ——
  { payee: '房租·王房东', amount: 3200, category: 'housing', isSubscription: false },
  { payee: '物业费', amount: 180, category: 'housing', isSubscription: false },
  { payee: '房贷还款', amount: 4200, category: 'housing', isSubscription: false },
  { payee: '燃气费', amount: 90, category: 'housing', isSubscription: false },
  { payee: '国网电费', amount: 150, category: 'housing', isSubscription: false },
  // —— 家庭转账/还款（误判排除）——
  { payee: '给妈妈的生活费', amount: 2000, category: 'personal', isSubscription: false },
  { payee: '父母家用', amount: 1500, category: 'personal', isSubscription: false },
  { payee: '花呗还款', amount: 1500, category: 'personal', isSubscription: false },
  { payee: '信用卡还款', amount: 3000, category: 'personal', isSubscription: false },
  { payee: '京东白条分期', amount: 600, category: 'personal', isSubscription: false },
  { payee: '房贷转账', amount: 4200, category: 'personal', isSubscription: false }, // 命中转账字样，不当作订阅
  { payee: '微信转账', amount: 800, category: 'personal', isSubscription: false },
  // —— 易混淆边界：教育 / 停车 / 保险 ——
  { payee: '某培训机构课程', amount: 500, category: 'other', isSubscription: true }, // 无法明确，金额≤500 保守当订阅
  { payee: '商场停车场月卡', amount: 300, category: 'other', isSubscription: true }, // 边界：金额≤500 保守当订阅
  { payee: '某健身房', amount: 199, category: 'other', isSubscription: true },
  { payee: '保险自动扣款', amount: 298, category: 'subscription', isSubscription: true }, // 含"保险"
  { payee: '某慈善机构', amount: 200, category: 'other', isSubscription: true },
  // —— 中立/非订阅 ——
  { payee: '某超市', amount: 800, category: 'other', isSubscription: false }, // 无特征且>500
  { payee: '某大额机构', amount: 5000, category: 'other', isSubscription: false },
];

describe('classifyRecurring 标注集误判/漏判率', () => {
  // 计算并打印误判率（用于人工复核；断言一个宽松阈值防止回归失控）
  it(`${CORPUS.length} 条标注：分类误判率与订阅漏/误判率低于阈值`, () => {
    let catMistakes = 0;
    let subMistakes = 0;
    for (const s of CORPUS) {
      const got = classifyRecurring(s.payee, s.amount);
      // 分类一致才算对
      if (got.category !== s.category) catMistakes++;
      // isSubscription 应为"可取消订阅"：二者要一致
      if (got.isSubscription !== s.isSubscription) subMistakes++;
    }
    const catRate = catMistakes / CORPUS.length;
    const subRate = subMistakes / CORPUS.length;
    // 注解集本身承认部分"边界保守"判定，允许存在少量误差；只要不开放回退失控
    expect(catRate).toBeLessThanOrEqual(0.25);
    expect(subRate).toBeLessThanOrEqual(0.25);
    // 输出供人工复核
    // eslint-disable-next-line no-console
    console.log(`[订阅标注集] ${CORPUS.length} 条：分类误判率 ${(catRate * 100).toFixed(1)}%，订阅漏/误判率 ${(subRate * 100).toFixed(1)}%`);
  });

  it('每条判定都带可解释的 reason（L2 可解释，供用户纠正）', () => {
    for (const s of CORPUS) {
      const got = classifyRecurring(s.payee, s.amount);
      expect(got.reason.length).toBeGreaterThan(0);
    }
  });
});