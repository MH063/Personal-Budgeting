import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { loadUserRules, saveUserRules, parseUserRules, learnCorrection, type UserRule } from '@/api/merchantNorm';
import { loadImportRules, parseImportRules, saveImportRules } from '@/api/importRules';
import type { ImportRule } from '@/api/import';
import { useKnowledgeStore } from '@/stores/useKnowledgeStore';
import { downloadJSON, saveJSON } from '@/lib/export';
import { queryAuditLogs, countAuditByKind, type AuditEntry } from '@/api/audit';
import AuditHistoryDialog from '@/components/ai/AuditHistoryDialog';
import KnowledgePanel from '@/components/ai/KnowledgePanel';
import ImportRulesPanel from '@/components/ai/ImportRulesPanel';

/**
 * 智能规则管理（全部规则的统一栏目：执行规则 + AI 参考知识集中于此，用户要求）
 *  规则分两类机制，逻辑上明确区分：
 *   1) 执行规则：本地即时生效、不消耗 AI —— 用户规则 > 内置同义 > 学习模型/AI 默认。
 *      - merchant_renamed：把命中商户归并到规范名（麦当劳/金拱门/McDonald's 归一共）。
 *      - categorize：命中文本强制归到某分类（星巴克 → 咖啡），命中即显示"依据"。
 *      - 资金流向判定（ImportRulesPanel）：导入账单时按关键词判定类型/账户/分类，
 *        优先级高于内置识别；原挂在导入管理页，因规则分散迁入本页（历史缺陷）。
 *      上述规则仅存本机（settings 表），无网络；改后即时生效于分类推荐、商户画像与导入判定。
 *   2) 参考知识与规则：随 AI 请求发送给当前服务商作为参考资料（见 KnowledgePanel），
 *      对全部服务商一致生效，与凭证无关。两类机制分开管理、互不影响。
 *  - 页首工具栏：规则总览（四类条数一栏看全）+ 统一搜索（跨四类即时过滤定位）
 *    + 规则导入/导出（JSON 备份包，换机迁移或分享；导入按各自键去重合并、不覆盖现有）。
 *  - 审计历史：页面只显示最近数条摘要，完整记录（筛选/搜索/分页/清理）在弹窗中查看，
 *    避免记录随使用增长后把设置页撑得又长又难查。
 */

/** 规则备份包标识（导入时校验，避免误读其他 JSON 文件） */
const RULES_BUNDLE_TYPE = 'moneybook-rules';

/** 浏览器预览：动态文件选择框读取 JSON 文本（桌面版走系统对话框 + fs 插件） */
function pickJsonText(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) { reject(new Error('未选择文件')); return; }
      f.text().then(resolve, reject);
    };
    input.click();
  });
}

export default function RuleManage() {
  const [rules, setRules] = useState<UserRule[]>(() => loadUserRules());
  const [kind, setKind] = useState<UserRule['kind']>('categorize');
  const [match, setMatch] = useState('');
  const [to, setTo] = useState('');
  const [learnText, setLearnText] = useState('');
  const [learnCat, setLearnCat] = useState('');
  // 审计摘要：仅取最近 5 条 + 总条数（完整列表在 AuditHistoryDialog 中按需加载）
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditOpen, setAuditOpen] = useState(false);
  // 纠正回写统计（改进闭口径：用户纠正→回写规则多少次）
  const [correctionCount, setCorrectionCount] = useState(0);
  // 规则总览 + 统一搜索：query 下发三个子面板做跨四类即时过滤
  const [query, setQuery] = useState('');
  // 资金流向规则集（由 ImportRulesPanel 实时上报，供总览统计条数）
  const [importRuleList, setImportRuleList] = useState<ImportRule[]>(() => loadImportRules());
  // 导入规则包后递增 key 强制面板重挂载（重读本机规则并重新上报总览）
  const [importRulesVersion, setImportRulesVersion] = useState(0);
  // 参考知识条数（订阅 store，导入规则包/增删条目后自动刷新）
  const knowledgeEntries = useKnowledgeStore((s) => s.entries);

  const catCount = rules.filter((r) => r.kind === 'categorize').length;
  const renCount = rules.length - catCount;
  const totalCount = rules.length + importRuleList.length + knowledgeEntries.length;

  async function doLearn() {
    const ok = await learnCorrection(learnText, learnCat);
    toast.success(ok ? '已回写为自定义规则并记录审计' : '该规则已存在，未重复添加');
    setLearnText('');
    setLearnCat('');
    setRules(loadUserRules());
    void refreshAudit();
  }

  async function refreshAudit() {
    const { total, rows } = await queryAuditLogs({ limit: 5 });
    setAudit(rows);
    setAuditTotal(total);
    setCorrectionCount(await countAuditByKind('rule_learned'));
  }

  const persist = (next: UserRule[]) => {
    saveUserRules(next);
    setRules(loadUserRules());
  };

  // 挂载时加载一次审计与纠正次数
  useEffect(() => {
    void refreshAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addRule() {
    const m = match.trim();
    const t = to.trim();
    if (!m || !t) { toast.error('请填写匹配词与目标'); return; }
    persist([...rules, { kind, match: m, to: t, enabled: true }]);
    setMatch('');
    setTo('');
    toast.success('规则已添加');
  }

  function removeAt(id: number) {
    persist(rules.filter((_, i) => i !== id));
  }
  function toggleAt(id: number) {
    persist(rules.map((r, i) => (i === id ? { ...r, enabled: !r.enabled } : r)));
  }

  /** 汇总四类规则为导出包（含停用规则，保留完整配置；换机迁移/分享用） */
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

  /** 导出全部规则为 JSON：桌面弹系统保存对话框并显示路径；浏览器回退直接下载 */
  async function handleExportRules() {
    try {
      const bundle = buildRulesBundle();
      const total = bundle.merchantRules.length + bundle.importRules.length + bundle.knowledge.length;
      if (!total) { toast.error('暂无规则可导出'); return; }
      const filename = `规则备份_${dayjs().format('YYYY-MM-DD')}.json`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isTauri = typeof window !== 'undefined' && (window as any)?.__TAURI_INTERNALS__ !== undefined;
      if (isTauri) {
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
   * 合并导入规则包（不覆盖现有规则：按各自键去重跳过，重复项自动忽略）。
   * 归类/归并按 kind+match+to 去重；资金流向按 match 去重；知识按 title+content 去重。
   * @returns 各类型新增条数的汇总描述（供成功提示）
   */
  function applyRulesBundle(raw: unknown): string {
    const b = raw as { type?: string; merchantRules?: unknown; importRules?: unknown; knowledge?: unknown } | null;
    if (!b || typeof b !== 'object' || b.type !== RULES_BUNDLE_TYPE) {
      throw new Error('文件不是规则备份（缺少标识），请选择本应用「导出规则」生成的 JSON');
    }
    // ① 归类 / 商户归并：键 kind+match+to
    const curM = loadUserRules();
    const mergedM = [...curM];
    let addM = 0;
    for (const r of parseUserRules(b.merchantRules)) {
      if (!mergedM.some((x) => x.kind === r.kind && x.match === r.match && x.to === r.to)) { mergedM.push(r); addM++; }
    }
    if (addM) { saveUserRules(mergedM); setRules(loadUserRules()); }
    // ② 资金流向判定：键 match
    const curI = loadImportRules();
    const mergedI = [...curI];
    let addI = 0;
    for (const r of parseImportRules(b.importRules)) {
      if (!mergedI.some((x) => x.match === r.match)) { mergedI.push(r); addI++; }
    }
    if (addI) { saveImportRules(mergedI); setImportRulesVersion((v) => v + 1); }
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

  /** 从 JSON 文件导入规则包（桌面系统对话框 / 浏览器文件选择），合并去重、不覆盖现有规则 */
  async function handleImportRules() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isTauri = typeof window !== 'undefined' && (window as any)?.__TAURI_INTERNALS__ !== undefined;
      let text: string;
      if (isTauri) {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        const p = await open({ filters: [{ name: '规则备份', extensions: ['json'] }], multiple: false });
        if (typeof p !== 'string') return; // 用户取消选择
        text = await readTextFile(p);
      } else {
        text = await pickJsonText();
      }
      toast.success(applyRulesBundle(JSON.parse(text)));
    } catch (e) {
      toast.error(`导入规则失败：${(e as Error).message}`);
    }
  }

  // —— 统一搜索：归类/归并列表过滤（保留原始下标供删除/停用）；子面板各自过滤 ——
  const q = query.trim().toLowerCase();
  const hitText = (s: string) => !q || s.toLowerCase().includes(q);
  const visibleRules = rules.map((r, i) => ({ r, i })).filter(({ r }) => hitText(r.match) || hitText(r.to));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 flex items-center gap-1.5 text-lg font-semibold">
          智能规则
          <Hint text="全部规则统一本栏管理：① 执行规则（归类、商户归并、资金流向判定）——用户规则 > 内置同义 > AI/默认的优先级执行，命中即生效并显示「依据」，全部本地存储、不消耗 AI；② 参考知识与规则——随 AI 请求发送给当前服务商的参考资料，对全部服务商一致生效。" />
        </h2>
      </div>

      {/* 规则总览 + 统一搜索 + 规则备份：四类规则一栏看全、快速定位、可迁移 */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
        <Input
          placeholder="搜索全部规则（关键词 / 目标）…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-[240px]"
        />
        <span className="text-xs text-muted">
          共 {totalCount} 条：归类 {catCount} · 归并 {renCount} · 资金流向 {importRuleList.length} · 参考知识 {knowledgeEntries.length}
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void handleExportRules()}>导出规则</Button>
          <Button variant="outline" size="sm" onClick={() => void handleImportRules()}>导入规则</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={kind}
          onChange={(v) => setKind(v as UserRule['kind'])}
          options={[
            { value: 'categorize', label: '归类（文本→分类）' },
            { value: 'merchant_renamed', label: '商户归并（→规范名）' },
          ]}
          placeholder="类型"
        />
        <Input placeholder="匹配词，如：星巴克 / 麦当劳" value={match} onChange={(e) => setMatch(e.target.value)} className="max-w-[200px]" />
        <Input placeholder={kind === 'categorize' ? '目标分类，如：咖啡' : '规范商户名，如：麦记'} value={to} onChange={(e) => setTo(e.target.value)} className="max-w-[200px]" />
        <Button size="sm" onClick={addRule}>添加规则</Button>
      </div>

      <div className="rounded-lg border border-[var(--border)]">
        {rules.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">暂无自定义规则。添加后分类推荐/商户画像将优先按你的规则执行。</p>
        ) : visibleRules.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">没有匹配「{query.trim()}」的规则。</p>
        ) : (
          visibleRules.map(({ r, i }) => (
            <div key={i} className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5 text-sm last:border-0">
              <div className="min-w-0">
                <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium dark:bg-white/10">
                  {r.kind === 'categorize' ? '归类' : '归并'}
                </span>
                <span className="ml-2">{r.match} → {r.to}</span>
                {!r.enabled && <span className="ml-2 text-xs text-muted">（停用）</span>}
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => toggleAt(i)} className="text-xs text-muted hover:underline">
                  {r.enabled ? '停用' : '启用'}
                </button>
                <button type="button" onClick={() => removeAt(i)} className="text-xs text-[var(--color-danger)] hover:underline">
                  删除
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* —— 反馈学习（纠正回写） —— */}
      <div className="rounded-lg border border-[var(--border)] p-3">
        <h3 className="mb-1 text-sm font-medium">🔁 反馈学习</h3>
        <p className="mb-2 text-xs text-muted">AI/规则判错时，纠正它：输入"原文 + 正确分类"，一键回写为自定义规则并记审计。</p>
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

      {/* —— 资金流向判定规则（自导入管理页集中于此：全部规则统一一栏管理） —— */}
      <ImportRulesPanel key={importRulesVersion} filter={query} onRulesChange={setImportRuleList} />

      {/* —— 参考知识与规则（知识库合并于此：给 AI 的参考规则，随请求发送，全服务商生效） —— */}
      <KnowledgePanel filter={query} />
    </div>
  );
}