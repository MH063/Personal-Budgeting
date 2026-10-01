import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { loadUserRules, saveUserRules, learnCorrection, type UserRule } from '@/api/merchantNorm';
import { queryAuditLogs, countAuditByKind, type AuditEntry } from '@/api/audit';
import AuditHistoryDialog from '@/components/ai/AuditHistoryDialog';

/**
 * 智能规则管理（AI + 规则混合的可解释第一层）
 *  - 规则优先级：用户规则 > 内置同义 > 学习模型/AI 默认。
 *  - merchant_renamed：把命中商户归并到规范名（麦当劳/金拱门/McDonald's 归一共）。
 *  - categorize：命中文本强制归到某分类（星巴克 → 咖啡），命中即显示"依据"。
 *  规则仅存本机（settings 表），无网络；改后即时生效于分类推荐与商户画像。
 *  - 审计历史：页面只显示最近数条摘要，完整记录（筛选/搜索/分页/清理）在弹窗中查看，
 *    避免记录随使用增长后把设置页撑得又长又难查。
 */

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

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 flex items-center gap-1.5 text-lg font-semibold">
          智能规则
          <Hint text="用户规则 > 内置同义 > AI/默认的优先级执行。命中即生效并显示「依据」，可在记账/导入时一键采用；全部本地存储。" />
        </h2>
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
        ) : (
          rules.map((r, i) => (
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
    </div>
  );
}