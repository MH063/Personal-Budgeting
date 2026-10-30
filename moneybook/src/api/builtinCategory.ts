import { categorizeByRule, loadUserRules, type UserRule } from './merchantNorm';

/**
 * 内置「文本 → 分类」词典（纯数据 + 纯函数，无 IO / 无 AI / 无 DB）。
 * ---------------------------------------------------------------
 * 目标（路线图第 3 项「导入生态扩展」——减少人工核对）：
 * 导入账单收尾时，对"用户归类规则未命中"的行提供一层**本地兜底分类**，
 * 使未开启 AI 的用户也能自动归类常见商户（星巴克→餐饮、滴滴→交通…），少一条条手改。
 *
 * 与既有资产的关系（避免口径分裂）：
 *  - `src/api/aiSuggest.ts` 的 LOCAL_CATEGORY_RULES 是**录入建议**（AI 建议的第一层）口径；
 *  - 本模块是**导入兜底**口径，分类名一律对齐系统默认 22 条分类（见 factoryReset.ts），
 *    保证命中即可匹配到库中已有分类，不会因名称不一致而多建分类；
 *  - 二者可择机合并为一处（本期不合并，避免扩大改动面）。
 *
 * 优先级（调用方应遵守）：用户归类规则 > 内置词典 > 空。
 */

/** 一条内置归类规则：命中任一关键词（包含匹配）即归到该分类 */
export interface BuiltinCategoryRule {
  /** 关键词列表（包含匹配） */
  keywords: string[];
  /** 目标分类名（对齐系统默认分类） */
  category: string;
  /**
   * 目标分类的收支方向。归类时按行方向过滤：
   * 支出行只匹配 expense 规则、收入行只匹配 income 规则，
   * 避免「支出行含『红包/报销/退款』却被归到收入分类」这类跨方向误判（历史缺陷：词典不区分方向）。
   */
  type: 'expense' | 'income';
}

/** 内置归类词典（支出在前、收入在后，仅作兜底；用户规则优先） */
export const BUILTIN_CATEGORY_RULES: BuiltinCategoryRule[] = [
  // —— 支出 ——
  {
    type: 'expense',
    category: '餐饮',
    keywords: [
      '餐饮', '早餐', '午餐', '晚餐', '午饭', '晚饭', '早饭', '吃饭', '快餐', '外卖', '点餐', '小吃', '零食',
      '奶茶', '咖啡', '饮品', '饮料', '火锅', '烧烤', '餐厅', '饭店',
      '星巴克', '瑞幸', '蜜雪冰城', '肯德基', '麦当劳', '海底捞', '美团外卖', '饿了么',
    ],
  },
  {
    type: 'expense',
    category: '交通',
    keywords: [
      '交通', '地铁', '公交', '打车', '滴滴', '出租车', '网约车', '加油', '停车', '高铁', '机票', '火车',
      '燃油', '高速', '过路费', '共享单车', '哈啰', '青桔', '充电桩',
      '中石化', '中石油', '中国石化', '中国石油',
    ],
  },
  {
    type: 'expense',
    category: '购物',
    keywords: [
      '购物', '超市', '商场', '百货', '便利店', '日用', '服饰', '衣服', '鞋子', '鞋服',
    ],
  },
  {
    type: 'expense',
    category: '居住',
    keywords: ['居住', '房租', '租房', '物业', '水费', '电费', '燃气', '煤气', '暖气', '水电', '缴费'],
  },
  {
    type: 'expense',
    category: '娱乐',
    keywords: [
      '娱乐', '电影', '影院', '游戏', 'ktv', '唱歌', '演出', '视频会员', '会员',
      '腾讯视频', '爱奇艺', '优酷', '网易云', 'steam', '密室', '桌游',
    ],
  },
  {
    type: 'expense',
    category: '医疗',
    keywords: ['医疗', '医院', '药店', '诊疗', '挂号', '诊所', '体检', '牙科', '医保', '药品'],
  },
  {
    type: 'expense',
    category: '教育',
    keywords: ['教育', '学费', '培训', '课程', '网课', '教材', '书籍', '考试', '报名费', '文具'],
  },
  {
    type: 'expense',
    category: '人情',
    keywords: ['人情', '礼金', '份子钱', '随礼', '请客', '送礼', '礼物', '结婚份子'],
  },
  {
    type: 'expense',
    category: '通讯',
    keywords: ['通讯', '手机', '话费', '话费充值', '充话费', '流量', '宽带', '套餐', '月租', '充流量'],
  },
  {
    type: 'expense',
    category: '旅行',
    keywords: ['旅游', '旅行', '酒店', '民宿', '门票', '景区', '景点', '跟团', '行程'],
  },
  {
    type: 'expense',
    category: '美妆',
    keywords: ['美妆', '化妆品', '护肤品', '面膜', '香水', '彩妆', '口红', '眉笔', '粉底', '美发', '理发', '美容', '美甲'],
  },
  {
    type: 'expense',
    category: '运动',
    keywords: ['健身房', '健身', '游泳', '瑜伽', '跑步', '慢跑', '球馆', '羽毛球', '篮球', '足球', '乒乓球', '运动', '体育', '骑行', '舞蹈'],
  },
  {
    type: 'expense',
    category: '数码',
    keywords: ['数码', '电脑', '平板', '耳机', '键盘', '鼠标', '充电器', '配件', '家电', '显示器'],
  },
  {
    type: 'expense',
    category: '宠物',
    keywords: ['宠物', '猫粮', '狗粮', '猫砂', '宠物店', '遛狗', '宠物美容', '宠物医院'],
  },
  {
    type: 'expense',
    category: '宝宝',
    keywords: ['奶粉', '尿不湿', '纸尿裤', '母婴', '婴儿', '宝宝', '辅食', '婴儿车'],
  },
  {
    type: 'expense',
    category: '网购',
    keywords: ['网购', '淘宝', '天猫', '京东', '拼多多', '唯品会', '苏宁', '抖音', '直播间', '快递', '菜鸟', '丰巢'],
  },
  // —— 收入 ——
  {
    type: 'income',
    category: '工资',
    keywords: ['工资', '薪资', '薪酬', '月薪', '报酬'],
  },
  {
    type: 'income',
    category: '奖金',
    keywords: ['奖金', '年终奖', '绩效', '提成', '红包', '压岁钱'],
  },
  {
    type: 'income',
    category: '兼职',
    keywords: ['兼职', '外快', '稿费', '劳务', '版税'],
  },
  {
    type: 'income',
    category: '投资收益',
    keywords: ['利息', '分红', '理财', '基金', '股票', '收益', '存款利息', '国债'],
  },
  {
    type: 'income',
    category: '其他收入',
    keywords: ['其他收入', '报销', '返现', '退款', '补贴', '奖学金'],
  },
];

/**
 * 平台账单「分类列」→ 系统默认分类 的**精确映射表**（纯数据）。
 * ---------------------------------------------------------------
 * 背景（真实账单实测）：支付宝「交易分类」是平台自有的业务分类（商业服务、爱车养车、
 * 信用借还、账户存取、生活服务…），与系统 22 条默认分类不是同一套语义；
 * 仅靠 BUILTIN_CATEGORY_RULES 的"关键词包含"最多只能碰上少数几个（餐饮美食、交通出行），
 * 其余会按原样自动新建，导致分类膨胀且语义错位（如「充值缴费」被"缴费"命中成「居住」）。
 *
 * 故此处给出**名字级精确映射**，优先于关键词词典（精确 > 包含，避免顺序误伤），
 * 目标值一律为系统默认 22 条分类（见 factoryReset.DEFAULT_CATEGORIES）。
 * 映射不到的平台分类仍由关键词词典兜底，最后才允许新建。
 */
export const PLATFORM_CATEGORY_MAP: Record<string, string> = {
  // —— 支付宝「交易分类」——
  '餐饮美食': '餐饮',
  '日用百货': '购物',
  '交通出行': '交通',
  '教育培训': '教育',
  '酒店旅游': '旅行',
  '数码电器': '数码',
  '医疗健康': '医疗',
  '美容美发': '美妆',
  '充值缴费': '通讯',   // 主要为话费/流量/宽带充值；水电燃气等由商户文本走关键词词典
  '转账红包': '人情',
  '爱车养车': '交通',   // 加油/保养/停车/洗车均属用车成本
  '生活服务': '居住',   // 家政/维修/洗衣等居家服务
  '商业服务': '购物',   // 商家服务费/代办/中介等
  '文化休闲': '娱乐',
  '家居家装': '居住',
  '公共服务': '居住',   // 水电燃气/政务等公共缴费
  '收入': '其他收入',
  // —— 微信「交易类型」（仅当自定义模板把该列误当"分类"时兜底；括号变体由归一化剥离）——
  '微信红包': '红包',
  '二维码收款': '其他收入',
};

/**
 * 平台分类列中**不代表消费分类**的取值：命中即视为"无分类"（不新建分类）。
 * 这些值是交易形态（还款/存取/转账/渠道），不是支出去向，落库成分类会污染统计。
 */
export const PLATFORM_CATEGORY_IGNORE: string[] = [
  '信用借还', '账户存取', '转账', '其他',
  '商户消费', '扫二维码付款', '零钱提现',
];

/**
 * 内置词典归类（纯函数）：命中任一关键词即返回其分类；未命中返回 null。
 * 关键词按"包含匹配"，与用户规则/商户归并同一口径。
 * @param type 行方向（已知时传入）：仅在同方向的规则中匹配，避免支出行被归到收入分类（反之亦然）；
 *             `transfer`/`repay_in` 等不计收支的行不传，按全量规则匹配
 */
export function classifyBuiltinCategory(text: string, type?: 'expense' | 'income'): { category: string; via: string } | null {
  const t = String(text ?? '');
  if (!t) return null;
  for (const rule of BUILTIN_CATEGORY_RULES) {
    if (type && rule.type !== type) continue;
    const hit = rule.keywords.find((k) => k && t.includes(k));
    if (hit) return { category: rule.category, via: `内置词典「${hit}」` };
  }
  return null;
}

/**
 * 归类（用户规则优先，内置词典兜底）：供导入收尾与其它归类场景复用。
 * @param text  参与匹配的文本（商户名 + 备注，口径与 applyUserCategoryRules 一致）
 * @param rules 用户归类规则；缺省时读取本机已加载规则（loadUserRules）
 * @param type  行方向：内置词典按方向过滤（用户规则由用户自定，不做方向限制）
 * @returns 命中的分类与依据；均未命中返回 null。`builtin=true` 表示来自低置信的内置词典兜底。
 */
export function categorizeWithRules(
  text: string, rules?: UserRule[], type?: 'expense' | 'income'
): { category: string; via: string; builtin: boolean } | null {
  const rs = rules ?? loadUserRules();
  const byRule = categorizeByRule(text, { rules: rs });
  if (byRule) return { ...byRule, builtin: false };
  const b = classifyBuiltinCategory(text, type);
  return b ? { ...b, builtin: true } : null;
}
