import { Card } from '@/components/ui/card';

export function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <h3 className="mb-3 font-semibold">{title}</h3>
      {children}
    </Card>
  );
}