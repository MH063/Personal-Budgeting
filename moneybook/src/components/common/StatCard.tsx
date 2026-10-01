import { formatMoney } from '@/lib/format';
import { Card } from '@/components/ui/card';

export function StatCard({ title, value, color = '#1E6FA9', suffix = '' }: {
  title: string; value: number; color?: string; suffix?: string;
}) {
  return (
    <Card className="p-5">
      <div className="text-sm text-muted">{title}</div>
      <div className="mt-2 text-2xl font-bold" style={{ color }}>
        {formatMoney(value)}{suffix}
      </div>
    </Card>
  );
}