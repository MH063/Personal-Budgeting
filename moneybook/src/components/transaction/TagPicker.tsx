import { useState } from 'react';
import { useTags, useTagMutations } from '@/hooks/useTags';
import { Input } from '@/components/ui/input';

/** 标签选择（可多选，支持即时新建标签） */
export function TagPicker({ value = [], onChange }: { value?: number[]; onChange: (ids: number[]) => void }) {
  const { data: tags = [] } = useTags();
  const { create } = useTagMutations();
  const [text, setText] = useState('');

  function toggle(id: number) {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  }

  async function addTag() {
    const t = text.trim();
    if (!t) return;
    const exist = tags.find((x) => x.name.toLowerCase() === t.toLowerCase());
    if (exist) {
      if (!value.includes(exist.id)) onChange([...value, exist.id]);
      setText('');
      return;
    }
    const id = await create.mutateAsync({ name: t });
    if (!value.includes(id)) onChange([...value, id]);
    setText('');
  }

  return (
    <div className="rounded-lg border border-[var(--border)] p-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.length === 0 && <span className="text-xs text-muted">暂无标签，可在下方添加</span>}
        {tags.map((t) => {
          const on = value.includes(t.id);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => toggle(t.id)}
              className={`rounded-full border px-2 py-0.5 text-xs transition ${on ? '' : 'opacity-45'}`}
              style={on ? { background: t.color, color: '#fff', borderColor: t.color } : { borderColor: 'var(--border)' }}
            >
              {t.name}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-1">
        <Input
          placeholder="添加标签并回车"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
          className="h-7 text-xs"
        />
        <button
          type="button"
          onClick={addTag}
          className="h-7 shrink-0 rounded border border-[var(--border)] px-2 text-xs hover:bg-black/5 dark:hover:bg-white/5"
        >
          添加
        </button>
      </div>
    </div>
  );
}