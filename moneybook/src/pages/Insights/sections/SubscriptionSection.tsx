import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';
import { ExpandList } from '@/components/common/ExpandList';
import { buildSubscriptionReminders, nextDueDate, cancellationGuide } from '@/api/subscription';

/** 订阅分类 → 中文标签（订阅 / 住房 / 家庭转账 / 其他） */
const SUB_CATEGORY_LABEL: Record<string, string> = {
  subscription: '订阅', housing: '住房', personal: '家庭转账', other: '其他',
};

/**
 * 订阅与重复扣费区块：识别月度固定重复扣费，展示即将到期项、全部识别项与订阅变价提醒。
 * 全部本地计算；「可取消」与否由 cancellationGuide 给出的可执行提示决定。
 * （自「智能洞察」页拆出，展示与交互保持不变。）
 */
export default function SubscriptionSection() {
  const subscription = useQuery({ queryKey: ['insights', 'subscription'], queryFn: () => buildSubscriptionReminders() });
  const sub = subscription.data;

  return (
    <section>
      <h3 className="mb-2 font-semibold">🔁 订阅与重复扣费</h3>
      {subscription.isLoading ? (
        <p className="text-sm text-muted">识别中…</p>
      ) : !sub || sub.items.length === 0 ? (
        <p className="text-sm text-muted">未发现明显的月度固定重复扣费。</p>
      ) : (
        <Card className="divide-y divide-[var(--border)]">
          {sub.dueSoon.map((b) => (
            <div key={b.key} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-warning,#F59E0B)]" />
                <b>{b.label}</b>
                <span className="text-muted">· 每月 {formatMoney(b.amount)}</span>
                <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] dark:bg-white/10" title={b.isSubscription ? cancellationGuide(b) : `非可取消订阅：${b.reason || ''}`}>{SUB_CATEGORY_LABEL[b.category] ?? '其他'}</span>
              </span>
              <span className="text-xs text-[var(--color-warning,#F59E0B)]">将到期 {nextDueDate(b) ?? '--'} · 置信 {Math.round(b.confidence * 100)}%</span>
            </div>
          ))}
          <ExpandList className="divide-y divide-[var(--border)]" items={sub.items} initial={8} render={(b) => (
            <div key={b.key} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="min-w-0">
                <span className="text-muted">🔄 {b.label}</span>
                <span className="ml-2 rounded bg-black/5 px-1.5 py-0.5 text-[10px] dark:bg-white/10" title={b.isSubscription ? cancellationGuide(b) : `非可取消订阅：${b.reason || ''}`}>{SUB_CATEGORY_LABEL[b.category] ?? '其他'}</span>
                {b.isSubscription && (
                  <span className="ml-1 text-[10px] text-muted" title={cancellationGuide(b)}>可取消</span>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted">{b.hits} 个月 · {formatMoney(b.amount)}/月 · 置信 {Math.round(b.confidence * 100)}%</span>
            </div>
          )} />
        </Card>
      )}
      {sub && sub.priceUp.length > 0 && (
        <Card className="mt-2 border-[var(--color-warning,#F59E0B)]/40">
          <div className="px-4 py-2.5">
            <div className="mb-1 text-xs font-medium text-[var(--color-warning,#F59E0B)]">⚠️ 订阅变价提醒</div>
            <ul className="space-y-1 text-sm">
              {sub.priceUp.map((c) => (
                <li key={c.payee} className="flex items-center justify-between">
                  <span>{c.payee}：{formatMoney(c.prevAmount)} → <b>{formatMoney(c.currAmount)}</b>（{Math.round((c.ratio - 1) * 100)}%↑）</span>
                  <span className="text-[10px] text-muted">最近 {c.date ?? '--'}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}
    </section>
  );
}
