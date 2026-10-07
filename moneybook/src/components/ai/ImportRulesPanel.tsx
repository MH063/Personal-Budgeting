import { useState } from 'react';
import { toast } from 'sonner';
import { loadImportRules, saveImportRules } from '@/api/importRules';
import type { ImportRule } from '@/api/import';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';

/**
 * 资金流向判定规则面板（智能规则页的「执行规则」第三类，规则集中统一管理）。
 * 背景：该规则原挂在「数据备份与导出 → 导入管理」页的折叠区里，用户反馈规则分散、
 * 难以一栏看全（历史缺陷）。现迁移至智能规则页，与归类规则 / 商户归并 / 参考知识
 * 并列展示；导入管理页仅保留提示与跳转入口。
 * 机制：命中关键词（包含匹配）时按规则判定交易类型/账户/分类，优先级高于内置识别
 * （还款/退款/提现/收支方向）；规则仅存本机 settings 表（kv.importRules），无网络。
 * 生成来源：可在导入预览/待核对里手动修正归类后自动沉淀（幂等合并；已停用规则
 * 不会被自动覆盖，尊重用户显式关闭）。
 */

/** 类型下拉选项（与导入可产生的交易类型一致，import.RULE_TYPES 口径） */
const TYPE_OPTIONS: { value: ImportRule['type']; label: string }[] = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '转账' },
  { value: 'repay_in', label: '负债减少' },
];

const inputCls =
  'h-7 rounded border border-[var(--border)] bg-[var(--bg)] px-1 text-xs';

export default function ImportRulesPanel() {
  const [rules, setRules] = useState<ImportRule[]>(() => loadImportRules());

  /** 新增一条空白规则（默认支出，关键词留空待填） */
  function addRule() {
    setRules((prev) => [...prev, { match: '', type: 'expense', enabled: true }]);
  }

  /** 编辑规则字段（就地更新指定下标的属性） */
  function patchRule(i: number, patch: Partial<ImportRule>) {
    setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  /** 删除规则 */
  function removeRule(i: number) {
    setRules((prev) => prev.filter((_, idx) => idx !== i));
  }

  /** 保存到本机（丢弃关键词为空的项）；下次选择文件解析时生效 */
  function persistRules() {
    const valid = rules.filter((r) => r.match.trim());
    setRules(valid);
    saveImportRules(valid);
    toast.success(`已保存 ${valid.length} 条规则（下次选择文件解析时生效）`);
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
        🧭 资金流向判定规则（{rules.length} 条）
        <Hint text="命中关键词（包含匹配）时按此规则判定资金流向，优先级高于内置识别（还款/退款/提现/收支方向）；可把某商家或某说明文本固定归到某类型、某账户或某分类。全部本机存储、无网络。" />
      </div>
      <p className="mb-3 text-xs text-muted">
        在导入预览里修正行的类型/账户/分类并导入，或在「导入后待核对」保存修正后，会自动沉淀为规则（幂等合并；已停用的规则不会被自动覆盖）。
      </p>
      {rules.length === 0 && <div className="mb-2 text-xs text-muted">暂无规则，点「添加规则」新建。</div>}
      <div className="space-y-2">
        {rules.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
            <input value={r.match} onChange={(e) => patchRule(i, { match: e.target.value })} placeholder="关键词"
              className={`${inputCls} w-28`} />
            <select value={r.type} onChange={(e) => patchRule(i, { type: e.target.value as ImportRule['type'] })}
              className={`${inputCls} [color-scheme:inherit]`}>
              {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input value={r.account ?? ''} onChange={(e) => patchRule(i, { account: e.target.value || undefined })} placeholder="账户(可空)"
              className={`${inputCls} w-28`} />
            <input value={r.toAccount ?? ''} onChange={(e) => patchRule(i, { toAccount: e.target.value || undefined })} placeholder="转入账户(转账用)"
              className={`${inputCls} w-28`} />
            <input value={r.category ?? ''} onChange={(e) => patchRule(i, { category: e.target.value || undefined })} placeholder="分类(可空)"
              className={`${inputCls} w-24`} />
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={r.enabled !== false} onChange={(e) => patchRule(i, { enabled: e.target.checked })} />
              启用
            </label>
            <button type="button" onClick={() => removeRule(i)} title="删除该规则"
              className="flex h-6 w-6 items-center justify-center rounded-md text-sm text-muted hover:bg-[var(--color-danger)]/10 hover:text-[var(--color-danger)]">✕</button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={addRule}>+ 添加规则</Button>
        <Button type="button" size="sm" onClick={persistRules}>保存规则</Button>
      </div>
    </div>
  );
}