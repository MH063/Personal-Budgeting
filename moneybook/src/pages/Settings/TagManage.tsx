import { useState } from 'react';
import { toast } from 'sonner';
import { useTags, useTagMutations } from '@/hooks/useTags';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

const PALETTE = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#6366F1', '#8B5CF6', '#EC4899', '#6B7280'];

export default function TagManage() {
  const { data: tags = [] } = useTags();
  const { create, update, remove } = useTagMutations();
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[0]);
  const [editing, setEditing] = useState<{ id: number; name: string; color: string } | null>(null);
  const [delTarget, setDelTarget] = useState<number | null>(null);

  function startEdit(t: { id: number; name: string; color: string }) {
    setEditing(t); setName(t.name); setColor(t.color);
  }

  async function save() {
    if (!name.trim()) return toast.error('请输入标签名称');
    try {
      if (editing) { await update.mutateAsync({ id: editing.id, name, color }); toast.success('已更新'); }
      else { await create.mutateAsync({ name, color }); toast.success('已创建'); }
      setEditing(null); setName(''); setColor(PALETTE[0]);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function confirmDelete() {
    if (delTarget == null) return;
    try { await remove.mutateAsync(delTarget); toast.success('已删除'); }
    catch (e) { toast.error((e as Error).message); }
    setDelTarget(null);
  }

  return (
    <div className="max-w-xl">
      <h2 className="mb-3 font-semibold">标签管理</h2>
      <div className="mb-4 rounded-lg border border-[var(--border)] p-3">
        <div className="mb-2 flex items-center gap-2">
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className="h-6 w-6 rounded-full transition"
              style={{ background: c, outline: color === c ? `2px solid ${c}` : 'none', border: '2px solid #fff' }}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input placeholder="标签名称" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
          <Button size="sm" onClick={save}>{editing ? '更新' : '添加'}</Button>
          {editing && <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setName(''); }}>取消</Button>}
        </div>
      </div>

      <ul className="space-y-2">
        {tags.length === 0 && <li className="text-sm text-muted">暂无标签</li>}
        {tags.map((t) => (
          <li key={t.id} className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2">
            <span className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full" style={{ background: t.color }} />
              {t.name}
            </span>
            <span className="flex gap-2">
              <button className="text-xs text-[var(--color-primary-fg)] hover:underline" onClick={() => startEdit(t)}>编辑</button>
              <button className="text-xs text-[var(--color-danger)] hover:underline" onClick={() => setDelTarget(t.id)}>删除</button>
            </span>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={delTarget != null}
        title="删除标签"
        description="删除后，历史交易上的该标签关联也会被移除。"
        confirmText="删除"
        danger
        onConfirm={confirmDelete}
        onClose={() => setDelTarget(null)}
      />
    </div>
  );
}