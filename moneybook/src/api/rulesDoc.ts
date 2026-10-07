import type { ImportRule } from './import';
import { IMPORT_TYPE_LABEL } from './import';
import type { UserRule } from './merchantNorm';

/**
 * 规则文档（人类可读的规则清单）的解析与生成。
 * ---------------------------------------------------------------
 * 设计目标（用户要求「以导入文档的形式」管理规则）：
 *  - 批量录入：一份 txt/md，每行一条规则，导入即并入统一规则列表（去重合并、不覆盖现有）；
 *  - 可读可分享：导出的文档就是规则清单本身，换机迁移 / 给他人参考都直接可读；
 *  - 删除即同步：文档在「导出那一刻」按最新规则集生成——删除某条规则后再导出，
 *    文档自然不再包含它（文档不是独立数据源，不存在「删了规则文档还在」的双源问题）。
 *
 * 文档格式（每行一条；空行与 `#` / `//` 开头的注释行自动跳过）：
 *   星巴克 => 咖啡                            归类：匹配文本包含「星巴克」→ 分类「咖啡」
 *   归并: 金拱门 => 麦当劳                     商户归并：归并到规范商户名
 *   流向: 停车费 => 支出|交通|支付宝           资金流向判定：类型|分类|账户|转入账户（尾部可省略、中间空位留空占位）
 * 分隔符支持 `=>`、`->`、`→`、`⇒`；前缀「归类 / 归并 / 流向」必须带冒号（中英文均可，无前缀默认归类）。
 * 流向字段竖线兼容全角「｜」；解析失败的行不报错终止，而是收集到 invalid 供界面提示用户核对。
 *
 * 模板与合并（用户要求「规则只允许文件导入建立，并给出正式格式文档模板」）：
 *  - buildRulesDocTemplate：生成可下载的格式模板（示例均为注释行，直接导入 0 条规则、绝不误伤）；
 *  - mergeDocRules：按「文档优先」合并（同匹配词更新内容、保留启用/停用状态），
 *    使「改文档 → 重新导入」成为修改规则的唯一途径——模板 / 导入 / 导出共用同一格式契约，
 *    便于用户设计与外部工具识别。
 */

/** 文档解析结果：三类执行规则 + 无法解析的行 */
export interface DocRules {
  /** 归类规则（文本 → 分类） */
  categorize: { match: string; to: string }[];
  /** 商户归并规则（文本 → 规范商户名） */
  merchant: { match: string; to: string }[];
  /** 资金流向判定规则（关键词 → 类型/分类/账户/转入账户） */
  flow: ImportRule[];
  /** 无法解析的原始行（供界面提示，不影响其余行导入） */
  invalid: string[];
}

/** 资金流向类型：中文标签 → 内部值（文档可读性优先，同时兼容直接写内部值） */
const FLOW_TYPE_BY_LABEL: Record<string, ImportRule['type']> = {
  收入: 'income',
  支出: 'expense',
  转账: 'transfer',
  负债减少: 'repay_in',
  income: 'income',
  expense: 'expense',
  transfer: 'transfer',
  repay_in: 'repay_in',
};

/** 行前缀 → 规则类别（无前缀默认归类） */
const PREFIX_RE = /^(归并|归类|流向)\s*[:：]\s*/;
/** 匹配词与目标的分隔符 */
const ARROW_RE = /^(.+?)\s*(?:=>|->|→|⇒)\s*(.+)$/;

/**
 * 解析规则文档文本为三类执行规则。
 * 逐行处理：跳过空行/注释行；剥离可选前缀；按分隔符拆「匹配词 → 目标」；
 * 流向行的目标再按 `|` 拆「类型|分类|账户|转入账户」。无法解析的行记入 invalid。
 */
export function parseRulesDoc(text: string): DocRules {
  const out: DocRules = { categorize: [], merchant: [], flow: [], invalid: [] };
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    let kind: 'categorize' | 'merchant' | 'flow' = 'categorize';
    let body = line;
    const p = PREFIX_RE.exec(line);
    if (p) {
      kind = p[1] === '归并' ? 'merchant' : p[1] === '流向' ? 'flow' : 'categorize';
      body = line.slice(p[0].length).trim();
    }
    const m = ARROW_RE.exec(body);
    if (!m) { out.invalid.push(rawLine); continue; }
    const match = m[1].trim();
    const target = m[2].trim();
    if (!match || !target) { out.invalid.push(rawLine); continue; }
    if (kind === 'flow') {
      // 目标：类型|分类|账户|转入账户（后三项可省略，仅转账使用转入账户）
      // 竖线兼容全角「｜」：中文输入法下用户常打出全角竖线，避免整行被判为非法
      const [typeRaw = '', category = '', account = '', toAccount = ''] = target.split(/[|｜]/).map((s) => s.trim());
      const type = FLOW_TYPE_BY_LABEL[typeRaw];
      if (!type) { out.invalid.push(rawLine); continue; }
      out.flow.push({
        match,
        type,
        category: category || undefined,
        account: account || undefined,
        toAccount: type === 'transfer' ? (toAccount || undefined) : undefined,
        enabled: true,
      });
    } else if (kind === 'merchant') {
      out.merchant.push({ match, to: target });
    } else {
      out.categorize.push({ match, to: target });
    }
  }
  return out;
}

/**
 * 资金流向规则 → 文档目标文本（类型|分类|账户|转入账户）。
 * 仅省略「尾部」空字段；中间空字段保留空位占位（如 `支出||支付宝`）——
 * 历史缺陷（防回归）：曾用 filter 省略全部空字段，导致「分类为空、仅账户」的规则
 * 导出后再导入时按 | 切分错位（账户值被当成分类）。
 */
function flowToDocTarget(r: ImportRule): string {
  const cells = [IMPORT_TYPE_LABEL[r.type] ?? r.type, r.category ?? '', r.account ?? '', r.toAccount ?? '']
    .map((s) => String(s ?? '').trim());
  // 去掉尾部连续空单元格（文档更简洁），但保留中间空位以维持字段对齐
  while (cells.length > 1 && !cells[cells.length - 1]) cells.pop();
  return cells.join('|');
}

/**
 * 生成规则文档文本（导出用）。
 * 仅含「启用」的规则：文档定位为「生效中的规则清单」；含停用规则的完整配置请用 JSON 备份迁移。
 * 内容以生成时刻的规则集为准，删除规则后再导出即自动同步（不存在独立文档数据源）。
 */
export function buildRulesDocText(merchantRules: UserRule[], flowRules: ImportRule[]): string {
  const lines: string[] = [];
  lines.push('# 记账规则清单（导出自「设置 - 智能规则」）');
  lines.push('# 每行一条规则，空行与 # 注释行导入时自动跳过；仅含启用中的规则（完整备份请用 JSON 导出）');
  lines.push('# 格式：匹配词 => 目标 ｜ 归并: 匹配词 => 商户名 ｜ 流向: 关键词 => 类型|分类|账户|转入账户');
  const cats = merchantRules.filter((r) => r.kind === 'categorize' && r.enabled);
  const renames = merchantRules.filter((r) => r.kind === 'merchant_renamed' && r.enabled);
  const flows = flowRules.filter((r) => r.enabled !== false && r.match);
  lines.push('');
  lines.push('# —— 归类规则（匹配文本包含关键词 → 归到分类）——');
  for (const r of cats) lines.push(`${r.match} => ${r.to}`);
  lines.push('');
  lines.push('# —— 商户归并（命中文本 → 归并为规范商户名）——');
  for (const r of renames) lines.push(`归并: ${r.match} => ${r.to}`);
  lines.push('');
  lines.push('# —— 资金流向判定（导入账单时命中关键词 → 指定类型/账户/分类）——');
  for (const r of flows) lines.push(`流向: ${r.match} => ${flowToDocTarget(r)}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * 生成规则文档模板（「下载模板」用；文件名「规则文档模板.md」）。
 * 设计（用户要求「正确的格式文档模板，便于用户设计以及后期工具的识别」）：
 *  - 模板即格式契约：模板本身被 parseRulesDoc 解析为 0 条规则且 invalid 为空——
 *    示例均为行首 # 注释行，用户未修改直接导入不会产生任何规则（防误伤）；
 *  - 用户复制示例行、去掉行首 # 即生效（与「导出文档」共用同一格式，三处互认）；
 *  - 三类规则各给示例：归类（无前缀）/ 归并（前缀「归并:」）/ 流向（前缀「流向:」）。
 */
export function buildRulesDocTemplate(): string {
  return [
    '# 记账规则文档模板（MoneyBook）',
    '# ------------------------------------------------------------------',
    '# 使用步骤：',
    '#  1. 复制本文件到任意位置，按下方格式填写你的规则（每行一条）；',
    '#  2. 打开应用「设置 → 智能规则」，点「导入文档」选择本文件；',
    '#  3. 空行与 #（或 //）开头的行会被自动跳过；同一匹配词再次导入会按本文件更新内容，',
    '#     列表内停用 / 启用状态保持不变；',
    '#  4. 无法解析的行会被汇总提示并跳过，不影响其余规则导入；',
    '#  5. 本模板未修改时直接导入不会新增任何规则（示例均为注释行）。',
    '#',
    '# 匹配词与目标之间的分隔符：=> 或 -> 或 → 或 ⇒',
    '#',
    '# ① 归类规则 —— 匹配文本包含关键词 → 归到分类（无需前缀）',
    '#    示例（去掉行首 # 后生效）：',
    '# 星巴克 => 咖啡',
    '# 麦当劳 => 餐饮',
    '#',
    '# ② 商户归并 —— 命中文本 → 归并为规范商户名（前缀「归并:」）',
    '#    示例（去掉行首 # 后生效）：',
    '# 归并: 金拱门 => 麦当劳',
    '#',
    '# ③ 资金流向判定 —— 导入账单时命中关键词 → 指定类型/分类/账户（前缀「流向:」）',
    '#    目标格式：类型|分类|账户|转入账户（后三项可省略；中间空位需留空占位，如 支出||支付宝）',
    '#    类型取值：收入 / 支出 / 转账 / 负债减少',
    '#    注意：转入账户仅「转账」类型使用，其它类型填写会被忽略',
    '#    示例（去掉行首 # 后生效）：',
    '# 流向: 停车费 => 支出|交通|支付宝',
    '# 流向: 工资 => 收入',
    '# 流向: 归还信用卡 => 转账|还款|支付宝|招商银行信用卡',
    '#',
    '# —— 在下方填写你的规则 ——',
    '',
  ].join('\n');
}

/** 文档合并结果（mergeDocRules 返回）：更新后的规则全量数组 + 新增 / 更新计数 */
export interface DocMergeResult {
  /** 更新后的归类 / 归并规则全量数组（调用方负责持久化） */
  merchant: UserRule[];
  /** 更新后的资金流向规则全量数组（调用方负责持久化） */
  flow: ImportRule[];
  /** 新增条数（文档里有、存储里没有的） */
  added: number;
  /** 更新条数（匹配词命中且内容有变化） */
  updated: number;
}

/**
 * 把文档解析结果合并进现有规则（用户确认的「文档优先」语义：改文档 → 重新导入是修改规则的唯一途径）。
 *  - 同一匹配词（归类 / 归并按 kind+match，流向按 match）再次导入 → 按文档值更新内容；
 *  - 不存在的 → 新增（默认启用）；
 *  - 启用状态不随文档变化：文档不含停用信息，停用 / 启用是列表内的显式操作，
 *    反复导入同一文档保持幂等，不会把用户停用的规则意外复活；
 *  - 内容一致的重复导入不计入 updated（避免提示虚报「更新 N 条」）。
 */
export function mergeDocRules(merchant: UserRule[], flow: ImportRule[], doc: DocRules): DocMergeResult {
  const m = [...merchant];
  const f = [...flow];
  let added = 0;
  let updated = 0;

  /** 归类 / 归并 upsert：同 kind+match 更新 to；否则追加（新增默认启用） */
  const upsertMerchant = (kind: UserRule['kind'], match: string, to: string) => {
    const i = m.findIndex((r) => r.kind === kind && r.match === match);
    if (i < 0) {
      m.push({ kind, match, to, enabled: true });
      added++;
      return;
    }
    if (m[i].to !== to) {
      m[i] = { ...m[i], to };
      updated++;
    }
  };
  for (const r of doc.categorize) upsertMerchant('categorize', r.match, r.to);
  for (const r of doc.merchant) upsertMerchant('merchant_renamed', r.match, r.to);

  /** 资金流向 upsert：同 match 覆盖类型 / 分类 / 账户 / 转入账户；保留既有启用状态 */
  for (const r of doc.flow) {
    const i = f.findIndex((x) => x.match === r.match);
    if (i < 0) {
      f.push(r);
      added++;
      continue;
    }
    const old = f[i];
    const same =
      old.type === r.type &&
      (old.category ?? '') === (r.category ?? '') &&
      (old.account ?? '') === (r.account ?? '') &&
      (old.toAccount ?? '') === (r.toAccount ?? '');
    if (!same) {
      f[i] = { ...old, type: r.type, category: r.category, account: r.account, toAccount: r.toAccount };
      updated++;
    }
  }
  return { merchant: m, flow: f, added, updated };
}