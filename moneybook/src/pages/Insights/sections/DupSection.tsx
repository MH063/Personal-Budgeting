import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/format';
import { ExpandList } from '@/components/common/ExpandList';
import { buildDupReport, aiVerifyDuplicates, listDupReviews, saveDupReview, deleteDupReview, type DupSuspect, type DupVerdict, type DupReview } from '@/api/dupDetect';
import { readAIConfig } from '@/stores/useAIStore';

/** 疑似重复判定的展示口径（dup=疑似重复 / ok=正常两笔 / uncertain=待核查） */
const DUP_VERDICT_META: Record<DupVerdict, { icon: string; label: string; color: string }> = {
  dup: { icon: '🔴', label: '疑似重复', color: '#EF4444' },
  ok: { icon: '🟢', label: '正常消费', color: '#10B981' },
  uncertain: { icon: '🟡', label: '待核查', color: '#F59E0B' },
};

/**
 * 疑似重复记账区块：识别「同商户不同订单号」的重复消费。
 * 判定链路三层——本地启发式（默认）→ AI 判定（可选，上云前脱敏）→ 用户人工复核（最高优先）。
 * 判定结果经 dup_reviews 表持久化：AI 缓存刷新不丢、人工结论跨会话保留；
 * 人工判定的配对移出「待处理」，可在「已处理」折叠区回顾或撤销重新复核。
 * （自「智能洞察」页拆出，展示与交互保持不变。）
 */
export default function DupSection() {
  // 疑似重复记账：默认本地启发式判定；用户点「AI 判定」后以 AI 结果覆盖展示
  const dup = useQuery({ queryKey: ['insights', 'dup'], queryFn: () => buildDupReport() });
  const [dupVerified, setDupVerified] = useState<DupSuspect[] | null>(null);
  const [dupAiBusy, setDupAiBusy] = useState(false);
  // 判定持久化（dup_reviews 表）：user=人工复核结果（最高优先），ai=AI 判定缓存（刷新不丢）
  const [userReviews, setUserReviews] = useState<Record<string, DupReview>>({});
  const [aiReviews, setAiReviews] = useState<Record<string, DupReview>>({});
  // 「已处理」折叠区展开状态（用户判定的配对可从待处理列表回顾）
  const [processedOpen, setProcessedOpen] = useState(false);

  // 载入本账本已持久化的全部判定（用户 + AI），刷新页面后人工复核结果不丢失
  useEffect(() => {
    void listDupReviews()
      .then((rs) => {
        const user: Record<string, DupReview> = {};
        const ai: Record<string, DupReview> = {};
        for (const r of rs) {
          if (r.source === 'user') user[r.pair_key] = r;
          else ai[r.pair_key] = r;
        }
        setUserReviews(user);
        setAiReviews(ai);
      })
      .catch(() => { /* 库暂不可用时静默，功能降级为纯内存判定 */ });
  }, []);

  // 派生展示：用户已判定的配对移出「待处理」列表（可在已处理中回顾）；
  // 其余待处理配对若已有 AI 判定缓存，用缓存覆盖展示（AI 判定刷新后同样不丢）
  const suspects = dupVerified ?? dup.data ?? [];
  const handled = suspects.filter((s) => userReviews[s.key]);
  const shown = suspects
    .filter((s) => !userReviews[s.key])
    .map((s) => {
      const ai = aiReviews[s.key];
      if (!ai) return s;
      return {
        ...s,
        verdict: ai.verdict,
        source: 'ai' as const,
        reliability: 0.9,
        reason: `AI 判定：${ai.verdict === 'dup' ? '疑似重复' : '正常两笔'}`,
      };
    });

  /** AI 判定疑似重复：仅当启用 AI 且允许明细时上云（文本脱敏），否则维持本地判定 */
  async function aiVerifyDups() {
    if (dupAiBusy) return;
    const suspects2 = dupVerified ?? dup.data ?? [];
    if (!suspects2.length) return;
    setDupAiBusy(true);
    try {
      const out = await aiVerifyDuplicates(suspects2);
      setDupVerified(out);
      // AI 判定结果持久化（source='ai' 缓存）：刷新/重进后 AI 判定不丢失，用户判定可覆盖
      for (const s of out) {
        if (s.source === 'ai') {
          try { await saveDupReview(s.key, s.verdict, 'ai'); } catch { /* 单条写入失败不阻断整体 */ }
        }
      }
      setAiReviews((prev) => {
        const next = { ...prev };
        for (const s of out) if (s.source === 'ai') next[s.key] = { pair_key: s.key, verdict: s.verdict, source: 'ai' } as DupReview;
        return next;
      });
      const dups = out.filter((s) => s.verdict === 'dup').length;
      toast.success(`AI 判定完成：${dups} 条疑似重复、${out.length - dups} 条正常/待核查（结果已保存）`);
    } catch (e) {
      toast.error(`AI 判定失败：${(e as Error).message}`);
    } finally {
      setDupAiBusy(false);
    }
  }

  /** 用户人工判定某对疑似重复（确认重复 / 标记正常 / 待核查）：落库持久化，判定后移入「已处理」 */
  async function reviewDupPair(key: string, verdict: DupVerdict) {
    try {
      await saveDupReview(key, verdict, 'user');
      setUserReviews((prev) => ({ ...prev, [key]: { pair_key: key, verdict, source: 'user' } as DupReview }));
      toast.success(verdict === 'ok' ? '已标记为正常消费，不再提示' : verdict === 'dup' ? '已确认重复记账' : '已标记为待核查');
    } catch (e) {
      toast.error(`保存判定失败：${(e as Error).message}`);
    }
  }

  /** 撤销人工判定：删除持久化记录，该配对回到待处理列表重新复核 */
  async function undoDupReview(key: string) {
    try {
      await deleteDupReview(key, 'user');
      setUserReviews((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      toast.success('已撤销人工判定');
    } catch (e) {
      toast.error(`撤销失败：${(e as Error).message}`);
    }
  }

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">🔎 疑似重复记账</h3>
        <Button type="button" onClick={aiVerifyDups} disabled={dupAiBusy || !suspects.length}>
          {dupAiBusy ? '判定中…' : '🤖 AI 判定'}
        </Button>
        <span className="text-xs text-muted">
          {readAIConfig().enabled && readAIConfig().allowDetail
            ? 'AI 判定将上云（文本已脱敏）；否则仅本地启发式'
            : 'AI 未开启或未允许发送明细，当前仅本地启发式'}
        </span>
        {handled.length > 0 && <span className="text-xs text-muted">已人工处理 {handled.length} 条</span>}
      </div>
      {dup.isLoading ? (
        <p className="text-sm text-muted">检测中…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted">
          {handled.length > 0 ? '全部疑似重复已处理完毕。' : '未发现短时同商户疑似重复消费。'}
        </p>
      ) : (
        <Card className="divide-y divide-[var(--border)]">
          <ExpandList className="divide-y divide-[var(--border)]" items={shown} initial={8} render={(s) => (
            <div key={s.key} className="px-4 py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <b>{s.a.payee || '未知商户'}</b>
                <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] dark:bg-white/10" style={{ color: DUP_VERDICT_META[s.verdict].color }}>
                  {DUP_VERDICT_META[s.verdict].icon} {DUP_VERDICT_META[s.verdict].label}
                </span>
                <span className="text-[10px] text-muted">
                  可靠 {Math.round(s.reliability * 100)}% · {s.source === 'ai' ? 'AI 判定' : '本地启发式'}
                </span>
              </div>
              <div className="mt-1 space-y-0.5 text-xs text-muted">
                <div>① {s.a.date} · {formatMoney(s.a.amount)} · 订单号{s.a.orderNo ? ` ${s.a.orderNo}` : '：无'}</div>
                <div>② {s.b.date} · {formatMoney(s.b.amount)} · 订单号{s.b.orderNo ? ` ${s.b.orderNo}` : '：无'}</div>
              </div>
              <div className="mt-1 text-xs">{s.reason}</div>
              {/* 人工复核：不只依赖 AI，用户可自行判定；判定落库，刷新不丢 */}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => reviewDupPair(s.key, 'dup')}>确认重复</Button>
                <Button size="sm" variant="outline" onClick={() => reviewDupPair(s.key, 'ok')}>标记正常</Button>
                <Button size="sm" variant="ghost" onClick={() => reviewDupPair(s.key, 'uncertain')}>待核查</Button>
              </div>
            </div>
          )} />
        </Card>
      )}

      {/* 已处理折叠区：用户人工判定的配对（持久化，可展开回顾或撤销重新复核） */}
      {handled.length > 0 && (
        <Card className="mt-2">
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-2 text-sm font-medium"
            onClick={() => setProcessedOpen(!processedOpen)}
          >
            <span>✓ 已处理 {handled.length} 条疑似重复</span>
            <span className="text-xs text-muted">{processedOpen ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          {processedOpen && (
            <div className="divide-y divide-[var(--border)]">
              {handled.map((s) => (
                <div key={s.key} className="px-4 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <b>{s.a.payee || '未知商户'}</b>
                    <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] dark:bg-white/10" style={{ color: DUP_VERDICT_META[s.verdict].color }}>
                      {DUP_VERDICT_META[s.verdict].icon} {DUP_VERDICT_META[s.verdict].label}
                    </span>
                    <span className="text-[10px] text-muted">人工判定</span>
                  </div>
                  <div className="mt-1 space-y-0.5 text-xs text-muted">
                    <div>① {s.a.date} · {formatMoney(s.a.amount)} · 订单号{s.a.orderNo ? ` ${s.a.orderNo}` : '：无'}</div>
                    <div>② {s.b.date} · {formatMoney(s.b.amount)} · 订单号{s.b.orderNo ? ` ${s.b.orderNo}` : '：无'}</div>
                  </div>
                  <div className="mt-2">
                    <Button size="sm" variant="ghost" onClick={() => undoDupReview(s.key)}>撤销判定（重新复核）</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </section>
  );
}
