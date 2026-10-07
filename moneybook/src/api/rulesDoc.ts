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