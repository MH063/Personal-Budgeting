import { Link } from 'react-router-dom';
import { useAccounts } from '@/hooks/useAccounts';
import { Select, type SelectOption } from '@/components/ui/select';

export function AccountPicker({ value, onChange, excludeCredit = false, exclude = [], label = '账户' }: {
  value?: number;
  onChange: (id: number) => void;
  excludeCredit?: boolean;
  exclude?: number[];
  label?: string;
}) {
  const { data: accounts = [], isLoading } = useAccounts(true);
  const list = accounts.filter(
    (a) => !exclude.includes(a.id) && !(excludeCredit && a.type === 'credit')
  );
  const options: SelectOption[] = list.map((a) => ({
    value: String(a.id),
    label: `${a.name} (¥${a.balance.toFixed(2)})`,
    icon: a.icon,
    color: a.color,
  }));
  if (isLoading) {
    return <div className="h-9 rounded-lg border border-[var(--border)] px-3 text-sm text-muted flex items-center">加载中…</div>;
  }
  // 空态引导：账户不再预置，零账户用户必须能从这里直达创建入口，
  // 否则账户下拉为空且无任何提示，记账表单无法完成（历史缺陷）。
  if (list.length === 0) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-sm text-muted">
        <span>还没有账户，请先创建一个（如：现金 / 微信 / 银行卡）</span>
        <Link to="/settings?tab=account" className="shrink-0 hover:underline" style={{ color: 'var(--color-primary-fg)' }}>去创建 →</Link>
      </div>
    );
  }
  return (
    <Select
      value={value ? String(value) : undefined}
      onChange={(v) => onChange(Number(v))}
      options={options}
      placeholder={label}
    />
  );
}