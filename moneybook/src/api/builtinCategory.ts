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
}

/** 内置归类词典（支出在前、收入在后，仅作兜底；用户规则优先） */
export const BUILTIN_CATEGORY_RULES: BuiltinCategoryRule[] = [
  // —— 支出 ——
  {
    category: '餐饮',
    keywords: [
      '餐饮', '早餐', '午餐', '晚餐', '午饭', '晚饭', '早饭', '吃饭', '快餐', '外卖', '点餐', '小吃', '零食',
      '奶茶', '咖啡', '饮品', '饮料', '火锅', '烧烤', '餐厅', '饭店',
      '星巴克', '瑞幸', '蜜雪冰城', '肯德基', '麦当劳', '海底捞', '美团外卖', '饿了么',
    ],
  },
  {
    category: '交通',
    keywords: [
      '交通', '地铁', '公交', '打车', '滴滴', '出租车', '网约车', '加油', '停车', '高铁', '机票', '火车',
      '燃油', '高速', '过路费', '共享单车', '哈啰', '青桔', '充电桩',
      '中石化', '中石油', '中国石化', '中国石油',
    ],
  },
  {
    category: '购物',
    keywords: [
      '购物', '超市', '商场', '百货', '便利店', '日用', '服饰', '衣服', '鞋子', '鞋服',
    ],
  },
  {
    category: '居住',
    keywords: ['居住', '房租', '租房', '物业', '水费', '电费', '燃气', '煤气', '暖气', '水电', '缴费'],
  },
  {
    category: '娱乐',
    keywords: [
      '娱乐', '电影', '影院', '游戏', 'ktv', '唱歌', '演出', '视频会员', '会员',
      '腾讯视频', '爱奇艺', '优酷', '网易云', 'steam', '密室', '桌游',
    ],
  },
  {
    category: '医疗',
    keywords: ['医疗', '医院', '药店', '诊疗', '挂号', '诊所', '体检', '牙科', '医保', '药品'],
  },
  {
    category: '教育',
    keywords: ['教育', '学费', '培训', '课程', '网课', '教材', '书籍', '考试', '报名费', '文具'],
  },
  {
    category: '人情',
    keywords: ['人情', '礼金', '份子钱', '随礼', '请客', '送礼', '礼物', '结婚份子'],
  },
  {
    category: '通讯',
    keywords: ['通讯', '手机', '话费', '话费充值', '充话费', '流量', '宽带', '套餐', '月租', '充流量'],
  },
  {
    category: '旅行',
    keywords: ['旅游', '旅行', '酒店', '民宿', '门票', '景区', '景点', '跟团', '行程'],
  },
  {
    category: '美妆',
    keywords: ['美妆', '化妆品', '护肤品', '面膜', '香水', '彩妆', '口红', '眉笔', '粉底', '美发', '理发', '美容', '美甲'],
  },
  {
    category: '运动',
    keywords: ['健身房', '健身', '游泳', '瑜伽', '跑步', '慢跑', '球馆', '羽毛球', '篮球', '足球', '乒乓球', '运动', '体育', '骑行', '舞蹈'],
  },
  {
    category: '数码',
    keywords: ['数码', '电脑', '平板', '耳机', '键盘', '鼠标', '充电器', '配件', '家电', '显示器'],
  },
  {
    category: '宠物',
    keywords: ['宠物', '猫粮', '狗粮', '猫砂', '宠物店', '遛狗', '宠物美容', '宠物医院'],
  },
  {
    category: '宝宝',
    keywords: ['奶粉', '尿不湿', '纸尿裤', '母婴', '婴儿', '宝宝', '辅食', '婴儿车'],
  },
  {
    category: '网购',
    keywords: ['网购', '淘宝', '天猫', '京东', '拼多多', '唯品会', '苏宁', '抖音', '直播间', '快递', '菜鸟', '丰巢'],
  },
  // —— 收入 ——
  {
    category: '工资',
    keywords: ['工资', '薪资', '薪酬', '月薪', '报酬'],
  },
  {
    category: '奖金',
    keywords: ['奖金', '年终奖', '绩效', '提成', '红包', '压岁钱'],
  },
  {
    category: '兼职',
    keywords: ['兼职', '外快', '稿费', '劳务', '版税'],
  },
  {
    category: '投资收益',
    keywords: ['利息', '分红', '理财', '基金', '股票', '收益', '存款利息', '国债'],
  },
  {
    category: '其他收入',
    keywords: ['其他收入', '报销', '返现', '退款', '补贴', '奖学金'],
  },
];

/**
 * 内置词典归类（纯函数）：命中任一关键词即返回其分类；未命中返回 null。
 * 关键词按"包含匹配"，与用户规则/商户归并同一口径。
 */
export function classifyBuiltinCategory(text: string): { category: string; via: string } | null {
  const t = String(text ?? '');
  if (!t) return null;
  for (const rule of BUILTIN_CATEGORY_RULES) {
    const hit = rule.keywords.find((k) => k && t.includes(k));
    if (hit) return { category: rule.category, via: `内置词典「${hit}」` };
  }
  return null;
}

/**
 * 归类（用户规则优先，内置词典兜底）：供导入收尾与其它归类场景复用。
 * @param text  参与匹配的文本（商户名 + 备注，口径与 applyUserCategoryRules 一致）
 * @param rules 用户归类规则；缺省时读取本机已加载规则（loadUserRules）
 * @returns 命中的分类与依据；均未命中返回 null。`builtin=true` 表示来自低置信的内置词典兜底。
 */
export function categorizeWithRules(text: string, rules?: UserRule[]): { category: string; via: string; builtin: boolean } | null {
  const rs = rules ?? loadUserRules();
  const byRule = categorizeByRule(text, { rules: rs });
  if (byRule) return { ...byRule, builtin: false };
  const b = classifyBuiltinCategory(text);
  return b ? { ...b, builtin: true } : null;
}
