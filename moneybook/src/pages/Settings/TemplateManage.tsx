import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { listTemplates, createTemplate, deleteTemplate, type TxnTemplate, type TxnTemplatePayload } from '@/api/txnTemplate';
import { listAccounts } from '@/api/accounts';
import { listCategories } from '@/api/categories';
import { listTags } from '@/api/tags';

/**
 * 常用交易模板管理（智能补全·模板复用）
 *  - 模板仅存本机（txn_templates 表），无网络。
 *  - 记账页可一键套用；此处负责新建 / 删除 / 浏览。
 *  - 金额可留空 = 每次手填。
 */

const TYPE_LABEL: Record<string, string> = {
  income: '收入', expense: '支出', transfer: '转账', lend: '借出', borrow: '借入',
};

export default function TemplateManage() {
  const [templates, setTemplates] = useState<TxnTemplate[]>([]);
  const [name, setName] = useState('');
  const [type, setType] = useState<TxnTemplatePayload['type']>('expense');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [payee, setPayee] = useState('');
  const [accMap, setAccMap] = useState<Record<number, string>>({});
  const [catMap, setCatMap] = useState<Record<number, string>>({});
  const [tagMap, setTagMap] = useState<Record<number, string>>({});

  async function refresh() {
    const [tpls, accs, cats, tags] = await Promise.all([listTemplates(), listAccounts(false), listCategories(), listTags()]);
    setTemplates(tpls);
    setAccMap(Object.fromEntries(accs.map((a) => [a.id, a.name])));
    setCatMap(Object.fromEntries(cats.map((c) => [c.id, c.name])));
    setTagMap(Object.fromEntries(tags.map((t) => [t.id, t.name])));
  }

  useEffect(() => {
    void refresh();
  }, []);

  const preview = useMemo(() => {
    return (t: TxnTemplate) => {
      const parts: string[] = [TYPE_LABEL[t.type] ?? t.type];
      if (t.amount != null) parts.push(`¥${t.amount}`);
      else parts.push('金额手填');
      if (t.payee) parts.push(t.payee);
      if (t.category_id != null && catMap[t.category_id]) parts.push(catMap[t.category_id]);
      if (t.account_id != null && accMap[t.account_id]) parts.push(accMap[t.account_id]);
      if (t.note) parts.push(t.note);
      const tnames = t.tag_ids.map((id) => tagMap[id]).filter(Boolean);
      if (tnames.length) parts.push(`#${tnames.join(' #')}`);
      return parts.join(' · ');
    };
  }, [accMap, catMap, tagMap]);

  async function doCreate() {
    const n = name.trim();
    if (!n) { toast.error('请填写模板名称'); return; }
    const amt = Number(amount);
    const payload: TxnTemplatePayload = {
      name: n,
      type,
      amount: amount && amt > 0 ? amt : null,
      note: note.trim(),
      payee: payee.trim(),
    };
    try {
      await createTemplate(payload);
      setName(''); setAmount(''); setNote(''); setPayee(''); setType('expense');
      await refresh();
      toast.success('模板已创建');
    } catch (e) {
      toast.error(`创建失败：${(e as Error).message}`);
    }
  }

  async function doDelete(id: number, tname: string) {
    try {
      await deleteTemplate(id);
      setTemplates((ts) => ts.filter((t) => t.id !== id));
      toast.success(`已删除模板「${tname}」`);
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">常用交易模板</h2>
        <p className="text-sm text-muted">
          高频交易存成模板，记账页一键套用。金额留空即为“每次手填”。全部本地存储，无网络。
        </p>
      </div>

      {/* 新建模板 */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={type}
          onChange={(v) => setType(v as TxnTemplatePayload['type'])}
          options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))}
          placeholder="类型"
        />
        <Input placeholder="模板名称，如：每月房租" value={name} onChange={(e) => setName(e.target.value)} className="max-w-[220px]" />
        <Input placeholder="金额（留空=手填）" value={amount} onChange={(e) => setAmount(e.target.value)} className="max-w-[140px]" />
        <Button size="sm" disabled={!name.trim()} onClick={() => void doCreate()}>创建模板</Button>
      </div>

      <div className="rounded-lg border border-[var(--border)]">
        {templates.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">暂无模板。可在记账页保存，或在上方直接创建。</p>
        ) : (
          templates.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5 text-sm last:border-0">
              <div className="min-w-0">
                <span className="font-medium">{t.name}</span>
                <div className="truncate text-xs text-muted">{preview(t)}</div>
              </div>
              <button type="button" onClick={() => void doDelete(t.id, t.name)} className="shrink-0 text-xs text-[var(--color-danger)] hover:underline">
                删除
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}