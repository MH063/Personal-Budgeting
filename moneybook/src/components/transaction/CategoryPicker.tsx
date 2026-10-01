import { useCategories } from '@/hooks/useCategories';
import { Select, type SelectOption } from '@/components/ui/select';

export function CategoryPicker({ type, value, onChange }: {
  type: 'income' | 'expense';
  value?: number;
  onChange: (id: number) => void;
}) {
  const { data: cats = [], isLoading } = useCategories(type);
  const options: SelectOption[] = cats.map((c) => ({
    value: String(c.id),
    label: c.name,
    icon: c.icon,
    color: c.color,
  }));
  return (
    <Select
      value={value ? String(value) : undefined}
      onChange={(v) => onChange(Number(v))}
      options={options}
      placeholder={isLoading ? '加载中…' : `选择${type === 'income' ? '收入' : '支出'}分类`}
    />
  );
}