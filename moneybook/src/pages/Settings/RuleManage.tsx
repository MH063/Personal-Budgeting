import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { loadUserRules, saveUserRules, parseUserRules, learnCorrection, type UserRule } from '@/api/merchantNorm';
import { loadImportRules, parseImportRules, saveImportRules } from '@/api/importRules';
import type { ImportRule } from '@/api/import';
import { parseRulesDoc, buildRulesDocText, type DocRules } from '@/api/rulesDoc';
import { useKnowledgeStore, type KnowledgeEntry } from '@/stores/useKnowledgeStore';
import { downloadJSON, saveJSON, downloadText, saveText } from '@/lib/export';
import { queryAuditLogs, countAuditByKind, type AuditEntry } from '@/api/audit';
import AuditHistoryDialog from '@/components/ai/AuditHistoryDialog';

/**
 * 智能规则（全部规则的统一栏目：四类规则合并为「统一规则列表」展示与在线管理）
 * ---------------------------------------------------------------
 * 背景（用户反馈的重复与割裂问题）：
 *  - 原页面分四个区块（归类/归并列表、资金流向面板、知识库、反馈学习），各有独立的
 *    添加表单与展示，用户感觉「选项重复、规则分散」（历史缺陷）；
 *  - 更实质的割裂：归类规则（文本→分类）原本只在交易录入的 AI 建议环节生效，
 *    导入账单时完全不参与——同一意图「→分类」被拆成两条互不相通的路径。
 * 本次改造（方案已与用户确认）：
 *  1) 统一列表：四类规则汇成一个列表（汇总条数 + 类型筛选 + 统一搜索），
 *     行内直接启用/停用/编辑/删除，删除即实时生效（引擎读的就是这份存储）；
 *  2) 统一添加：一个表单 +「动作」四选一（归类 / 归并 / 资金流向 / AI 参考知识），
 *     选中后动态显示对应目标字段，用户无需理解各规则的存储差异；
 *  3) 语义打通：导入解析收尾时归类规则兜底生效（见 import.ts applyUserCategoryRules），
 *     「星巴克 => 咖啡」加一条处处生效；
 *  4) 文档式导入导出：规则可导出为人类可读清单（每行一条「匹配词 => 目标」），
 *     也可从 txt/md 批量导入；文档在导出那一刻按最新规则集生成——删除规则后
 *     再导出自动同步（文档不是独立数据源，不存在双源不一致）。
 * 机制分层（合的是展示与入口，不是执行机制）：
 *  - 执行规则（归类 / 归并 / 资金流向）：本机存储、本地引擎执行、不消耗 AI；
 *    优先级：用户规则 > 内置同义 > 学习模型/AI 默认。
 *  - AI 参考知识：随 AI 请求发送给当前服务商（见 llm.ts knowledgeBlock），只喂 AI、不本地执行。
 *  - 审计历史：页面只显示最近数条摘要，完整记录（筛选/搜索/分页/清理）在弹窗中查看。
 */

/** 规则备份包标识（导入时校验，避免误读其他 JSON 文件） */
const RULES_BUNDLE_TYPE = 'moneybook-rules';

/** 统一条目的四种类别（展示层合并；存储与执行机制各自独立） */
type EntryKind = 'categorize' | 'merchant_renamed' | 'flow' | 'knowledge';
/** 添加表单的「动作」：与条目类别一一对应 */
type AddAction = EntryKind;

/** 列表行类别标签 */
const KIND_LABEL: Record<EntryKind, string> = {
  categorize: '归类',
  merchant_renamed: '归并',
  flow: '资金流向',
  knowledge: 'AI 参考',
};

/** 资金流向类型选项（与导入可产生的交易类型一致，import.RULE_TYPES 口径） */
const FLOW_TYPE_OPTIONS: { value: ImportRule['type']; label: string }[] = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '转账' },
  { value: 'repay_in', label: '负债减少' },
];
const FLOW_TYPE_LABEL: Record<ImportRule['type'], string> = {
  expense: '支出', income: '收入', transfer: '转账', repay_in: '负债减少',
};

/** 匹配词输入框占位文案（按动作区分，帮助用户理解匹配方式为「包含匹配」） */
const MATCH_PLACEHOLDER: Record<Exclude<AddAction, 'knowledge'>, string> = {
  categorize: '匹配词，如：星巴克',
  merchant_renamed: '匹配词，如：金拱门',
  flow: '匹配关键词，如：停车费',
};

/** 筛选下拉选项 */
const FILTER_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'categorize', label: '归类' },
  { value: 'merchant_renamed', label: '商户归并' },
  { value: 'flow', label: '资金流向' },
  { value: 'knowledge', label: 'AI 参考知识' },
];

/** 知识文档导入：允许的纯文本扩展名（不做 PDF/Word 二进制解析：易出错且需额外重依赖） */
const KNOWLEDGE_DOC_EXT = ['txt', 'md', 'markdown', 'csv', 'json', 'log', 'yaml', 'yml', 'ini'];
/** 单条知识内容上限（字符数）：超出即截断，避免超大文档撑爆 prompt、无谓消耗 Token */
const KNOWLEDGE_DOC_MAX_CHARS = 50000;

/** 统一规则条目（展示层聚合视图；执行路由回各自存储） */
interface RuleEntry {
  key: string;
  kind: EntryKind;
  /** 在其所属存储数组中的下标（供启用/停用/删除定位；知识条目用 id 不受下标影响） */
  idx: number;
  enabled: boolean;
  match?: string;
  to?: string;
  rule?: ImportRule;
  knowledge?: KnowledgeEntry;
}

/** 把四类规则汇成统一条目列表：归类/归并取同一存储（保留 kind 区分），资金流向与知识各取所属。 */
function buildEntries(merchantRules: UserRule[], flowRules: ImportRule[], knowledge: KnowledgeEntry[]): RuleEntry[] {
  const list: RuleEntry[] = [];
  merchantRules.forEach((r, i) => {
    list.push({ key: `m-${i}`, kind: r.kind, idx: i, enabled: r.enabled, match: r.match, to: r.to });
  });
  flowRules.forEach((r, i) => {
    list.push({ key: `f-${i}`, kind: 'flow', idx: i, enabled: r.enabled !== false, match: r.match, rule: r });
  });
  knowledge.forEach((k) => {
    list.push({ key: `k-${k.id}`, kind: 'knowledge', idx: -1, enabled: true, knowledge: k });
  });
  return list;
}

/** 资金流向规则的一句话描述：类型 · 分类 · 账户 · 转入账户（空字段省略） */
function flowDesc(r: ImportRule): string {
  return [FLOW_TYPE_LABEL[r.type], r.category, r.account, r.toAccount ? `转入 ${r.toAccount}` : '']
    .filter(Boolean)
    .join(' · ');
}

/** 浏览器预览：动态文件选择框读取文本（桌面版走系统对话框 + fs 插件） */
function pickTextFile(accept: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) { reject(new Error('未选择文件')); return; }
      f.text().then(resolve, reject);
    };
    input.click();
  });
}

/** 是否桌面（Tauri）环境：决定导入导出走系统对话框还是浏览器回退 */
function isTauriEnv(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof window !== 'undefined' && (window as any)?.__TAURI_INTERNALS__ !== undefined;
}

export default function RuleManage() {
  // —— 四类规则数据源 ——
  const [merchantRules, setMerchantRules] = useState<UserRule[]>(() => loadUserRules());
  const [flowRules, setFlowRules] = useState<ImportRule[]>(() => loadImportRules());
  const knowledgeEntries = useKnowledgeStore((s) => s.entries);
  const addKnowledge = useKnowledgeStore((s) => s.add);
  const updateKnowledge = useKnowledgeStore((s) => s.update);
  const removeKnowledge = useKnowledgeStore((s) => s.remove);

  // —— 统一搜索 + 类型筛选 ——
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | EntryKind>('all');

  // —— 添加表单（动作四选一，字段随动作动态显示） ——
  const [action, setAction] = useState<AddAction>('categorize');
  const [match, setMatch] = useState('');
  const [to, setTo] = useState('');
  const [flowType, setFlowType] = useState<ImportRule['type']>('expense');
  const [flowAccount, setFlowAccount] = useState('');
  const [flowToAccount, setFlowToAccount] = useState('');
  const [flowCategory, setFlowCategory] = useState('');
  const [kTitle, setKTitle] = useState('');
  const [kContent, setKContent] = useState('');
  const knowledgeDocRef = useRef<HTMLInputElement>(null);
  const [importingDocs, setImportingDocs] = useState(false);

  // —— 知识条目行内编辑 ——
  const [editKId, setEditKId] = useState<string | null>(null);
  const [editKTitle, setEditKTitle] = useState('');
  const [editKContent, setEditKContent] = useState('');

  // —— 反馈学习与审计 ——
  const [learnText, setLearnText] = useState('');
  const [learnCat, setLearnCat] = useState('');
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditOpen, setAuditOpen] = useState(false);
  const [correctionCount, setCorrectionCount] = useState(0);

  // —— 统一条目与总览统计 ——
  const entries = buildEntries(merchantRules, flowRules, knowledgeEntries);
  const catCount = merchantRules.filter((r) => r.kind === 'categorize').length;
  const renCount = merchantRules.length - catCount;

  // 统一搜索 + 类型筛选：按条目类别匹配不同字段（忽略大小写）
  const q = query.trim().toLowerCase();
  const hitText = (s?: string) => !q || String(s ?? '').toLowerCase().includes(q);
  const visible = entries.filter((e) => {
    if (kindFilter !== 'all' && e.kind !== kindFilter) return false;
    if (!q) return true;
    if (e.kind === 'knowledge') return hitText(e.knowledge?.title) || hitText(e.knowledge?.content);
    if (e.kind === 'flow') {
      return hitText(e.match) || hitText(e.rule?.category) || hitText(e.rule?.account) || hitText(e.rule?.toAccount);
    }
    return hitText(e.match) || hitText(e.to);
  });

  /** 持久化归类/归并规则（kv.merchantRules），并回读刷新（与既有 persist 模式一致） */
  const persistMerchant = (next: UserRule[]) => {
    saveUserRules(next);
    setMerchantRules(loadUserRules());
  };

  /** 持久化资金流向规则（kv.importRules），并回读刷新 */
  const persistFlows = (next: ImportRule[]) => {
    saveImportRules(next);
    setFlowRules(loadImportRules());
  };

  /** 纠错回写：把「原文 + 正确分类」沉淀为归类规则并记审计（幂等） */
  async function doLearn() {
    const ok = await learnCorrection(learnText, learnCat);
    toast.success(ok ? '已回写为自定义规则并记录审计' : '该规则已存在，未重复添加');
    setLearnText('');
    setLearnCat('');
    setMerchantRules(loadUserRules());
    void refreshAudit();
  }

  /** 刷新审计摘要（最近 5 条 + 总条数 + 纠错回写次数） */
  async function refreshAudit() {
    const { total, rows } = await queryAuditLogs({ limit: 5 });
    setAudit(rows);
    setAuditTotal(total);
    setCorrectionCount(await countAuditByKind('rule_learned'));
  }

  // 挂载时加载一次审计与纠正次数
  useEffect(() => {
    void refreshAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 添加规则：按当前动作路由到对应存储（知识条目无匹配词，走标题+内容） */
  function addByAction() {
    if (action === 'knowledge') {
      if (!kTitle.trim() && !kContent.trim()) { toast.error('请输入标题或内容'); return; }
      addKnowledge({ title: kTitle.trim() || '未命名知识', content: kContent.trim() });
      setKTitle('');
      setKContent('');
      toast.success('已添加知识条目，写入后将随 AI 请求参与上下文');
      return;
    }
    const m = match.trim();
    if (!m) { toast.error('请填写匹配词'); return; }
    if (action === 'flow') {
      persistFlows([...flowRules, {
        match: m,
        type: flowType,
        account: flowAccount.trim() || undefined,
        toAccount: flowType === 'transfer' ? (flowToAccount.trim() || undefined) : undefined,
        category: flowCategory.trim() || undefined,
        enabled: true,
      }]);
      setMatch('');
      setFlowAccount('');
      setFlowToAccount('');
      setFlowCategory('');
      toast.success('资金流向规则已添加（下次选择文件解析时生效）');
      return;
    }
    const t = to.trim();
    if (!t) { toast.error('请填写目标'); return; }
    persistMerchant([...merchantRules, { kind: action, match: m, to: t, enabled: true }]);
    setMatch('');
    setTo('');
    toast.success('规则已添加');
  }

  /** 行内启用/停用：按条目类别路由到对应存储（知识条目无启停概念，不显示入口） */
  function toggleEntry(e: RuleEntry) {
    if (e.kind === 'flow') {
      persistFlows(flowRules.map((r, i) => (i === e.idx ? { ...r, enabled: r.enabled === false } : r)));
    } else if (e.kind !== 'knowledge') {
      persistMerchant(merchantRules.map((r, i) => (i === e.idx ? { ...r, enabled: !r.enabled } : r)));
    }
  }

  /** 行内删除：删除后引擎实时不再命中；导出文档/备份在生成那一刻自动同步（不含已删条目） */
  function removeEntry(e: RuleEntry) {
    if (e.kind === 'knowledge' && e.knowledge) {
      removeKnowledge(e.knowledge.id);
      if (editKId === e.knowledge.id) setEditKId(null);
      toast.success('已删除该知识条目');
      return;
    }
    if (e.kind === 'flow') persistFlows(flowRules.filter((_, i) => i !== e.idx));
    else persistMerchant(merchantRules.filter((_, i) => i !== e.idx));
  }

  /** 进入知识条目的行内编辑 */
  function startEditK(k: KnowledgeEntry) {
    setEditKId(k.id);
    setEditKTitle(k.title);
    setEditKContent(k.content);
  }

  /** 保存知识条目行内编辑 */
  function saveEditK() {
    if (editKId === null) return;
    updateKnowledge(editKId, { title: editKTitle.trim() || '未命名知识', content: editKContent.trim() });
    setEditKId(null);
    toast.success('已保存知识条目');
  }

  /**
   * 知识文档批量导入：读取纯文本文件内容作为知识条目（存本机 settings 表，随 AI 请求发送）。
   * 校验：① 扩展名白名单，拒收其它类型（含二进制）；② 内容含 NUL 视为二进制拒收；
   * ③ 超长截断至 KNOWLEDGE_DOC_MAX_CHARS 并汇总提示，避免用户无感知地送出超大上下文。
   */
  async function onImportKnowledgeDocs(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    setImportingDocs(true);
    let okCount = 0;
    let truncatedCount = 0;
    const failed: string[] = [];
    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
      if (!KNOWLEDGE_DOC_EXT.includes(ext)) {
        failed.push(`${f.name}（仅支持 ${KNOWLEDGE_DOC_EXT.join('/')} 纯文本）`);
        continue;
      }
      try {
        const text = await f.text();
        if (text.includes('\u0000')) {
          failed.push(`${f.name}（疑似二进制文件）`);
          continue;
        }
        const body = text.trim();
        if (!body) {
          failed.push(`${f.name}（内容为空）`);
          continue;
        }
        const clipped = body.length > KNOWLEDGE_DOC_MAX_CHARS;
        if (clipped) truncatedCount++;
        addKnowledge({ title: f.name, content: clipped ? body.slice(0, KNOWLEDGE_DOC_MAX_CHARS) : body });
        okCount++;
      } catch {
        failed.push(`${f.name}（读取失败）`);
      }
    }
    setImportingDocs(false);
    if (okCount) {
      toast.success(
        `已导入 ${okCount} 个文档${truncatedCount ? `（其中 ${truncatedCount} 个超长已截断至 ${KNOWLEDGE_DOC_MAX_CHARS} 字符）` : ''}`
      );
    }
    if (failed.length) toast.error(`未导入：${failed.join('；')}`);
  }

  /** 汇总四类规则为导出备份包（含停用规则，保留完整配置；换机迁移/分享用） */
  function buildRulesBundle() {
    return {
      type: RULES_BUNDLE_TYPE,
      version: 1,
      exportedAt: new Date().toISOString(),
      merchantRules: loadUserRules(),
      importRules: loadImportRules(),
      knowledge: useKnowledgeStore.getState().entries.map((e) => ({ title: e.title, content: e.content })),
    };
  }

  /** 导出备份包（JSON）：桌面弹系统保存对话框并显示路径；浏览器回退直接下载 */
  async function handleExportRules() {
    try {
      const bundle = buildRulesBundle();
      const total = bundle.merchantRules.length + bundle.importRules.length + bundle.knowledge.length;
      if (!total) { toast.error('暂无规则可导出'); return; }
      const filename = `规则备份_${dayjs().format('YYYY-MM-DD')}.json`;
      console.log('[规则导出] 备份包条数：', total);
      if (isTauriEnv()) {
        const dest = await saveJSON(filename, bundle);
        if (!dest) return; // 用户取消保存对话框
        toast.success(`已导出 ${total} 条规则：${dest}`);
        return;
      }
      downloadJSON(filename, bundle);
      toast.success(`已导出 ${total} 条规则`);
    } catch (e) {
      toast.error(`导出规则失败：${(e as Error).message}`);
    }
  }

  /**
   * 合并备份包导入（不覆盖现有规则：按各自键去重跳过，重复项自动忽略）。
   * 归类/归并按 kind+match+to 去重；资金流向按 match 去重；知识按 title+content 去重。
   * @returns 各类型新增条数的汇总描述（供成功提示）
   */
  function applyRulesBundle(raw: unknown): string {
    const b = raw as { type?: string; merchantRules?: unknown; importRules?: unknown; knowledge?: unknown } | null;
    if (!b || typeof b !== 'object' || b.type !== RULES_BUNDLE_TYPE) {
      throw new Error('文件不是规则备份（缺少标识），请选择本应用「导出备份」生成的 JSON');
    }
    // ① 归类 / 商户归并：键 kind+match+to
    const curM = loadUserRules();
    const mergedM = [...curM];
    let addM = 0;
    for (const r of parseUserRules(b.merchantRules)) {
      if (!mergedM.some((x) => x.kind === r.kind && x.match === r.match && x.to === r.to)) { mergedM.push(r); addM++; }
    }
    if (addM) persistMerchant(mergedM);
    // ② 资金流向判定：键 match
    const curI = loadImportRules();
    const mergedI = [...curI];
    let addI = 0;
    for (const r of parseImportRules(b.importRules)) {
      if (!mergedI.some((x) => x.match === r.match)) { mergedI.push(r); addI++; }
    }
    if (addI) persistFlows(mergedI);
    // ③ 参考知识：键 title+content
    const seen = new Set(useKnowledgeStore.getState().entries.map((e) => `${e.title}\u0000${e.content}`));
    let addK = 0;
    const items = Array.isArray(b.knowledge) ? b.knowledge : [];
    for (const k of items) {
      const title = String((k as { title?: unknown })?.title ?? '').trim();
      const content = String((k as { content?: unknown })?.content ?? '').trim();
      if (!title && !content) continue;
      const key = `${title || '未命名知识'}\u0000${content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      useKnowledgeStore.getState().add({ title: title || '未命名知识', content });
      addK++;
    }
    return `已导入：归类/归并 ${addM} 条、资金流向 ${addI} 条、参考知识 ${addK} 条（重复项已自动跳过）`;
  }

  /** 从 JSON 备份包导入规则（桌面系统对话框 / 浏览器文件选择），合并去重、不覆盖现有规则 */
  async function handleImportRules() {
    try {
      let text: string;
      if (isTauriEnv()) {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        const p = await open({ filters: [{ name: '规则备份', extensions: ['json'] }], multiple: false });
        if (typeof p !== 'string') return; // 用户取消选择
        text = await readTextFile(p);
      } else {
        text = await pickTextFile('.json,application/json');
      }
      const msg = applyRulesBundle(JSON.parse(text));
      console.log('[规则导入] 备份包合并结果：', msg);
      toast.success(msg);
    } catch (e) {
      toast.error(`导入规则失败：${(e as Error).message}`);
    }
  }

  /** 导出为文档（人类可读清单，仅含启用规则；删除规则后再导出自动同步、不含有已删条目） */
  async function handleExportDoc() {
    try {
      const text = buildRulesDocText(loadUserRules(), loadImportRules());
      // 统计有效规则行数（排除注释行与空行）
      const count = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;
      if (!count) { toast.error('暂无可导出的启用规则'); return; }
      const filename = `规则清单_${dayjs().format('YYYY-MM-DD')}.md`;
      console.log('[规则文档导出] 条数：', count);
      if (isTauriEnv()) {
        const dest = await saveText(filename, text);
        if (!dest) return; // 用户取消保存对话框
        toast.success(`已导出 ${count} 条规则：${dest}`);
        return;
      }
      downloadText(filename, text);
      toast.success(`已导出 ${count} 条规则`);
    } catch (e) {
      toast.error(`导出文档失败：${(e as Error).message}`);
    }
  }

  /** 合并文档解析结果到各存储（去重、不覆盖；键与备份包导入同口径）；返回新增总数 */
  function applyDocRules(doc: DocRules): number {
    // 归类 + 归并 → kv.merchantRules（键 kind+match+to）
    const mergedM = [...loadUserRules()];
    let addM = 0;
    for (const r of doc.categorize) {
      if (!mergedM.some((x) => x.kind === 'categorize' && x.match === r.match && x.to === r.to)) {
        mergedM.push({ kind: 'categorize', match: r.match, to: r.to, enabled: true });
        addM++;
      }
    }
    for (const r of doc.merchant) {
      if (!mergedM.some((x) => x.kind === 'merchant_renamed' && x.match === r.match && x.to === r.to)) {
        mergedM.push({ kind: 'merchant_renamed', match: r.match, to: r.to, enabled: true });
        addM++;
      }
    }
    if (addM) persistMerchant(mergedM);
    // 资金流向 → kv.importRules（键 match）
    const mergedI = [...loadImportRules()];
    let addI = 0;
    for (const r of doc.flow) {
      if (!mergedI.some((x) => x.match === r.match)) { mergedI.push(r); addI++; }
    }
    if (addI) persistFlows(mergedI);
    return addM + addI;
  }

  /**
   * 从文档导入规则（txt/md 每行一条，如「星巴克 => 咖啡」；桌面系统对话框 / 浏览器文件选择）。
   * 无法解析的行不阻断导入，仅汇总提示用户核对（解析规则见 rulesDoc.parseRulesDoc）。
   */
  async function handleImportDoc() {
    try {
      let text: string;
      if (isTauriEnv()) {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        const p = await open({ filters: [{ name: '规则文档', extensions: ['txt', 'md', 'markdown'] }], multiple: false });
        if (typeof p !== 'string') return; // 用户取消选择
        text = await readTextFile(p);
      } else {
        text = await pickTextFile('.txt,.md,.markdown,text/plain');
      }
      const doc = parseRulesDoc(text);
      const added = applyDocRules(doc);
      console.log('[规则文档导入] 新增条数：', added, '；无法解析行：', doc.invalid.length);
      if (!added && !doc.invalid.length) { toast.success('没有新增规则（可能已全部存在）'); return; }
      toast.success(
        `已导入 ${added} 条规则（重复项已自动跳过）${doc.invalid.length ? `；${doc.invalid.length} 行无法解析已忽略` : ''}`
      );
    } catch (e) {
      toast.error(`导入文档失败：${(e as Error).message}`);
    }
  }

  const textareaCls =
    'w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-primary)]';

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 flex items-center gap-1.5 text-lg font-semibold">
          智能规则
          <Hint text="全部规则统一本栏管理：① 执行规则（归类、商户归并、资金流向判定）——用户规则 > 内置同义 > AI/默认的优先级执行，命中即生效并显示「依据」，全部本地存储、不消耗 AI；② AI 参考知识——随 AI 请求发送给当前服务商的参考资料，对全部服务商一致生效。行内可随时停用或删除，删除即实时生效。" />
        </h2>
        <p className="text-xs text-muted">
          四类规则统一列表展示；执行规则命中本地引擎、不消耗 AI，AI 参考知识只发送给 AI 不做本地执行。
        </p>
      </div>

      {/* 工具栏：统一搜索 + 总览统计 + 备份/文档 双通道导入导出 */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
        <Input
          placeholder="搜索全部规则（关键词 / 目标）…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-[220px]"
        />
        <span className="text-xs text-muted">
          共 {entries.length} 条：归类 {catCount} · 归并 {renCount} · 资金流向 {flowRules.length} · 参考知识 {knowledgeEntries.length}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void handleImportRules()}>导入备份</Button>
          <Button variant="outline" size="sm" onClick={() => void handleExportRules()}>导出备份</Button>
          <Button variant="outline" size="sm" onClick={() => void handleImportDoc()}>导入文档</Button>
          <Button variant="outline" size="sm" onClick={() => void handleExportDoc()}>导出文档</Button>
        </div>
      </div>

      {/* 统一添加表单：动作四选一，目标字段随动作动态显示 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="mb-1 text-sm font-medium">＋ 添加规则</h3>
        <p className="mb-3 text-xs text-muted">
          选择一种动作录入；执行规则（归类 / 归并 / 资金流向）本地即时生效、不消耗 AI；AI 参考知识随请求发送给当前服务商。
          也可用右上角「导入文档」按「匹配词 =&gt; 目标」每行一条批量录入。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={action}
            onChange={(v) => setAction(v as AddAction)}
            options={[
              { value: 'categorize', label: '归类到分类（文本→分类）' },
              { value: 'merchant_renamed', label: '归并到商户（文本→规范名）' },
              { value: 'flow', label: '资金流向判定（导入时指定类型/账户）' },
              { value: 'knowledge', label: 'AI 参考知识（随请求发送）' },
            ]}
            placeholder="动作"
          />
          {action !== 'knowledge' && (
            <Input
              placeholder={MATCH_PLACEHOLDER[action]}
              value={match}
              onChange={(e) => setMatch(e.target.value)}
              className="max-w-[200px]"
            />
          )}
          {action === 'categorize' && (
            <Input placeholder="目标分类，如：咖啡" value={to} onChange={(e) => setTo(e.target.value)} className="max-w-[180px]" />
          )}
          {action === 'merchant_renamed' && (
            <Input placeholder="规范商户名，如：麦记" value={to} onChange={(e) => setTo(e.target.value)} className="max-w-[180px]" />
          )}
          {action === 'flow' && (
            <>
              <Select
                value={flowType}
                onChange={(v) => setFlowType(v as ImportRule['type'])}
                options={FLOW_TYPE_OPTIONS}
                placeholder="类型"
              />
              <Input placeholder="账户（可空）" value={flowAccount} onChange={(e) => setFlowAccount(e.target.value)} className="max-w-[130px]" />
              {flowType === 'transfer' && (
                <Input placeholder="转入账户" value={flowToAccount} onChange={(e) => setFlowToAccount(e.target.value)} className="max-w-[130px]" />
              )}
              <Input placeholder="分类（可空）" value={flowCategory} onChange={(e) => setFlowCategory(e.target.value)} className="max-w-[120px]" />
            </>
          )}
          <Button size="sm" onClick={addByAction}>添加</Button>
          {action === 'knowledge' && (
            <>
              <input
                ref={knowledgeDocRef}
                type="file"
                hidden
                multiple
                accept=".txt,.md,.markdown,.csv,.json,.log,.yaml,.yml,.ini"
                onChange={(e) => void onImportKnowledgeDocs(e)}
              />
              <Button size="sm" variant="outline" onClick={() => knowledgeDocRef.current?.click()} disabled={importingDocs}>
                {importingDocs ? '导入中…' : '从文件导入知识'}
              </Button>
            </>
          )}
        </div>
        {action === 'knowledge' && (
          <div className="mt-2 space-y-2">
            <Input
              value={kTitle}
              onChange={(e) => setKTitle(e.target.value)}
              placeholder="标题（例：预算规则、记账偏好）"
            />
            <textarea
              rows={2}
              value={kContent}
              onChange={(e) => setKContent(e.target.value)}
              placeholder="知识 / 规则内容…"
              className={textareaCls}
            />
          </div>
        )}
      </div>

      {/* 统一规则列表：类型筛选 + 搜索联动；行内启用/停用/编辑/删除 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            规则列表（{visible.length} / {entries.length} 条）
            <Hint text="四类规则统一展示：归类 / 归并 / 资金流向为本地执行规则（命中即生效、不消耗 AI）；AI 参考知识随请求发送给服务商。行内可直接停用 / 编辑 / 删除；删除后立即生效，导出文档与备份在生成时自动同步。" />
          </div>
          <Select
            value={kindFilter}
            onChange={(v) => setKindFilter(v as 'all' | EntryKind)}
            options={FILTER_OPTIONS}
            placeholder="类型筛选"
          />
        </div>
        {entries.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">暂无规则。可在上方选择动作添加，或用「导入文档」批量录入。</p>
        ) : visible.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">
            没有匹配{query.trim() ? `「${query.trim()}」` : '当前筛选'}的规则。
          </p>
        ) : (
          <div className="rounded-lg border border-[var(--border)]">
            {visible.map((e) =>
              e.kind === 'knowledge' && e.knowledge && editKId === e.knowledge.id ? (
                // 知识条目行内编辑（标题 + 内容），保存后面板即时刷新
                <div key={e.key} className="space-y-2 border-b border-[var(--border)] px-4 py-3 last:border-0">
                  <Input value={editKTitle} onChange={(ev) => setEditKTitle(ev.target.value)} placeholder="标题" />
                  <textarea
                    rows={3}
                    value={editKContent}
                    onChange={(ev) => setEditKContent(ev.target.value)}
                    className={textareaCls}
                    placeholder="内容…"
                  />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditKId(null)}>取消</Button>
                    <Button size="sm" onClick={saveEditK}>保存</Button>
                  </div>
                </div>
              ) : (
                <div key={e.key} className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5 text-sm last:border-0">
                  <div className="min-w-0 flex-1 truncate">
                    <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium dark:bg-white/10">
                      {KIND_LABEL[e.kind]}
                    </span>
                    {e.kind === 'knowledge' ? (
                      <span className="ml-2">
                        <span className="font-medium">{e.knowledge?.title}</span>
                        <span className="ml-2 text-muted">{e.knowledge?.content}</span>
                      </span>
                    ) : e.kind === 'flow' && e.rule ? (
                      <span className="ml-2">{e.match} → {flowDesc(e.rule)}</span>
                    ) : (
                      <span className="ml-2">{e.match} → {e.to}</span>
                    )}
                    {!e.enabled && <span className="ml-2 text-xs text-muted">（停用）</span>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {e.kind !== 'knowledge' && (
                      <button type="button" onClick={() => toggleEntry(e)} className="text-xs text-muted hover:underline">
                        {e.enabled ? '停用' : '启用'}
                      </button>
                    )}
                    {e.kind === 'knowledge' && e.knowledge && (
                      <button type="button" onClick={() => startEditK(e.knowledge!)} className="text-xs text-muted hover:underline">
                        编辑
                      </button>
                    )}
                    <button type="button" onClick={() => removeEntry(e)} className="text-xs text-[var(--color-danger)] hover:underline">
                      删除
                    </button>
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </div>

      {/* —— 反馈学习（纠正回写） —— */}
      <div className="rounded-lg border border-[var(--border)] p-3">
        <h3 className="mb-1 text-sm font-medium">🔁 反馈学习</h3>
        <p className="mb-2 text-xs text-muted">AI/规则判错时，纠正它：输入"原文 + 正确分类"，一键回写为自定义归类规则并记审计。</p>
        <div className="mb-2 flex items-center gap-2">
          <Input placeholder="原文，如：星巴克拿铁" value={learnText} onChange={(e) => setLearnText(e.target.value)} className="max-w-[220px]" />
          <Input placeholder="正确分类，如：咖啡" value={learnCat} onChange={(e) => setLearnCat(e.target.value)} className="max-w-[160px]" />
          <Button size="sm" disabled={!learnText.trim() || !learnCat.trim()} onClick={() => void doLearn()}>加入规则并记录</Button>
        </div>
        <div className="mb-2 rounded-md border border-[var(--border)] bg-black/2 px-2 py-1 text-xs text-muted dark:bg-white/5">
          已通过纠错回写 {correctionCount} 条规则 · 规则优先级：用户规则 &gt; 内置同义 &gt; AI/默认
        </div>
        <div className="mt-3 flex items-center justify-between">
          <h4 className="text-xs font-medium text-muted">
            审计历史（AI/规则修改留痕{auditTotal > 0 ? ` · 共 ${auditTotal} 条` : ''}）
          </h4>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void refreshAudit()}>刷新</Button>
            <Button variant="outline" size="sm" onClick={() => setAuditOpen(true)}>查看审计历史</Button>
          </div>
        </div>
        {audit.length === 0 ? (
          <p className="mt-1 text-xs text-muted">暂无审计记录。</p>
        ) : (
          <ul className="mt-1 space-y-1 text-xs">
            {audit.map((a) => (
              <li key={a.id} className="truncate rounded border border-[var(--border)] px-2 py-1.5">
                <span className="text-muted">{a.created_at} [{a.source}]</span> {a.action} · {a.after || '-'}
                {a.basis && <span className="ml-1 text-muted">（{a.basis}）</span>}
              </li>
            ))}
          </ul>
        )}
        {auditTotal > audit.length && (
          <p className="mt-1 text-[11px] text-muted">
            仅显示最近 {audit.length} 条，筛选、搜索、分页与清理请点「查看审计历史」。
          </p>
        )}
      </div>

      {/* 审计历史弹窗：来源筛选 + 关键字搜索 + 分页加载 + 单条详情 + 清理 */}
      <AuditHistoryDialog
        open={auditOpen}
        onClose={() => setAuditOpen(false)}
        onChanged={() => void refreshAudit()}
      />
    </div>
  );
}