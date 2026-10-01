export function EmptyState({ icon = '📭', text = '暂无数据' }: { icon?: string; text?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted">
      <div className="text-4xl">{icon}</div>
      <div className="text-sm">{text}</div>
    </div>
  );
}