import { useState } from 'react';
import { toast } from 'sonner';
import { useCategories, useCategoryMutations } from '@/hooks/useCategories';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { IconPicker } from '@/components/ui/icon-picker';
import { DataTable } from '@/components/data-table/DataTable';

const TYPE_OPTIONS: SelectOption[] = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
];

export default function CategoryManage() {
  const { data: cats = [], isLoading } = useCategories();
  const { create, remove } = useCategoryMutations();
  const [name, setName] = useState('');
  const [type, setType] = useState<'expense' | 'income'>('expense');
  const [icon, setIcon] = useState('');

  async function onCreate() {
    if (!name.trim()) { toast.error('请输入分类名称'); return; }
    await create.mutateAsync({ name: name.trim(), type, icon: icon || (type === 'income' ? '💰' : '📦') });
    toast.success('分类已添加');
    setName(''); setIcon('');
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="mb-3 font-semibold">新增分类</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Input placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />
          <Select value={type} onChange={(v) => setType(v)} options={TYPE_OPTIONS} />
          <IconPicker value={icon} onChange={setIcon} className="h-9" />
          <Button onClick={onCreate} disabled={create.isPending}>添加</Button>
        </div>
      </div>

      <DataTable
        isLoading={isLoading}
        data={cats}
        columns={[
          { key: 'icon', header: '图标', render: (r) => <span>{r.icon}</span> },
          { key: 'name', header: '名称', render: (r) => <span className="font-medium">{r.name}</span> },
          { key: 'type', header: '类型', render: (r) => <Badge color={r.type === 'income' ? '#10B981' : '#EF4444'}>{r.type === 'income' ? '收入' : '支出'}</Badge> },
          {
            key: 'actions', header: '操作',
            render: (r) => (
              <button className="text-sm text-[var(--color-danger)]" onClick={() => remove.mutate(r.id)}>删除</button>
            ),
          },
        ]}
      />
    </div>
  );
}