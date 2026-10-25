import { formatMoney } from '@/lib/format';
import { Card } from '@/components/ui/card';

export function StatCard({ title, value, color = '#1E6FA9', suffix = '' }: {
  title: string; value: number | null; color?: string; suffix?: string;
}) {
  return (
    <Card className="p-5">
      <div className="text-sm text-muted">{title}</div>
      <div className="mt-2 text-2xl font-bold" style={{ color }}>
        {/* value 为 null 表示「无法估算」（如收入为零时储蓄率无意义），显示 — 而非误导性数字 */}
        {value != null ? `${formatMoney(value)}${suffix}` : '—'}
      </div>
    </Card>
  );
}