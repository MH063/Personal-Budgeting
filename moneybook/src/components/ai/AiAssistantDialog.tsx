import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useAIStore } from '@/stores/useAIStore';
import { useAiAssistantStore, type AssistantChatMsg } from '@/stores/useAiAssistantStore';
import {
  buildAggregateContext,
  chatStream,
  buildDiagnosisContext,
  DIAGNOSIS_SYSTEM,
  BUDGET_SYSTEM,
  FORECAST_SYSTEM,
  buildBudgetProposal,
  parseBudgetRecommendations,
  type BudgetProposalItem,
} from '@/api/llm';
import { answerFinancialQuestion } from '@/api/faq';
import { applyBudgetProposal, undoBudgetProposal } from '@/api/budgetApply';
import { completeFIM } from '@/api/deepseek';
import { BOOK_SYSTEM, parseBookOutput, splitStatements, type AiBookItem } from '@/api/aiBook';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useTransactionMutations } from '@/hooks/useTransactions';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { TX_TYPES } from '@/lib/constants';

/**
 * 全局 AI 助手弹窗（单例，挂载于 AppShell）。
 *
 * 合并背景：此前「仪表盘 AI 助手 / 智能洞察财务问答 / 月度体检 AI 深度分析」三处
 * 各自调用 LLM，同样的问题会重复触发、重复消耗 Tokens，且答案以大体量直接铺在页面上。
 * 现在全部收敛为这一个对话弹窗：
 *  - 「对话 / 报告」Tab：连续多轮问答（带上下文）、月度报告、省钱建议、财务体检、
 *    下月预测、预算建议（可一键写入），结果只在弹窗内展示，不再占用页面空间；
 *  - 「自然语言记账」Tab：解析记账语句并确认入账；
 *  - 各页面只保留「打开 AI 助手」入口，不再放置重复的 AI 区块。
 * 隐私边界：仅上送本地脱敏聚合事实，绝不上送单笔明细。
 */

export default function AiAssistantDialog() {
  const open = useAiAssistantStore((s) => s.open);
  const close = useAiAssistantStore((s) => s.closeAssistant);
  const enabled = useAIStore((s) => s.enabled);
  const [tab, setTab] = useState<'chat' | 'book'>('chat');

  return (
    <Modal open={open} onClose={close} title="AI 助手" wide>
      <div className="mb-3 flex items-center gap-2 border-b border-[var(--border)] pb-2">
        <TabBtn active={tab === 'chat'} onClick={() => setTab('chat')}>对话 / 报告</TabBtn>
        <TabBtn active={tab === 'book'} onClick={() => setTab('book')}>自然语言记账</TabBtn>
        {/* 跳转设置页前先关闭弹窗，避免弹窗残留遮挡设置页（用户反馈） */}
        <Link to="/settings?tab=ai" onClick={close} className="ml-auto text-xs text-muted hover:underline">
          {enabled ? 'AI 设置 →' : '开启 AI →'}
        </Link>
      </div>
      {tab === 'chat' ? (
        <ChatTab enabled={enabled} />
      ) : enabled ? (
        <BookTab />
      ) : (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-4">
          <div className="font-semibold">🤖 自然语言记账需要先开启 AI</div>
          <div className="mt-1 text-sm text-muted">
            开启并配置凭证后，可直接输入「午饭 25 元 用微信支付」等语句自动解析成账。
            未开启 AI 不影响手动记账与本地问答（左侧「对话 / 报告」Tab 的快捷问答始终可用）。
          </div>
          <Link to="/settings?tab=ai" onClick={close} className="mt-2 inline-block text-sm" style={{ color: 'var(--color-primary)' }}>去开启 →</Link>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 对话 / 报告 Tab
// ---------------------------------------------------------------------------

const QUICK_QUERIES = ['上个月花了多少', '上个月餐饮花了多少', '哪类支出增长最快', '这个月收入多少'];

function ChatTab({ enabled }: { enabled: boolean }) {
  // 由入口携带的分析锚点（月度体检可传用户选定的月份/维度）：体检与预测据此分析对应月份
  const anchor = useAiAssistantStore((s) => s.anchor);
  // 对话历史放 store：切换 Tab / 关闭弹窗重开后仍保留，支撑连续追问
  const msgs = useAiAssistantStore((s) => s.msgs);
  const setMsgs = useAiAssistantStore((s) => s.setMsgs);
  const clearMsgs = useAiAssistantStore((s) => s.clearMsgs);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [fimBusy, setFimBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 卸载（切换 Tab / 关闭弹窗）时中止未完成的流式请求，避免无人查看时继续消耗 Tokens
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // 预算建议 → 一键写入 的本地面板状态（写入与撤销均在本地完成，不上传云端）
  const [budgetItems, setBudgetItems] = useState<BudgetProposalItem[]>([]);
  const [budgetChecked, setBudgetChecked] = useState<boolean[]>([]);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [budgetApplying, setBudgetApplying] = useState(false);
  const [budgetConfirming, setBudgetConfirming] = useState(false);
  const [budgetUndoToken, setBudgetUndoToken] = useState<string | null>(null);
  const [budgetStatus, setBudgetStatus] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);

  // 新消息追加后自动滚到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  /** 追加流式增量到最后一条 assistant 消息 */
  function appendLast(delta: string) {
    setMsgs((prev) =>
      prev.map((m, i) => (i === prev.length - 1 && m.role === 'assistant' ? { ...m, content: m.content + delta } : m))
    );
  }

  /** 结束最后一条 assistant 消息的 pending 态（可附来源标注） */
  function settleLast(patch: Partial<AssistantChatMsg>) {
    setMsgs((prev) => prev.map((m, i) => (i === prev.length - 1 ? { ...m, pending: false, ...patch } : m)));
  }

  /**
   * 普通问答：本地聚合先给确定答案；启用 AI 时强制走 LLM（仅脱敏聚合事实），
   * 失败自动回退本地。只带最近 6 条历史（单条截断 500 字）控制上送 token 量。
   */
  async function sendQuestion(text: string) {
    const t = text.trim();
    if (!t || sending) return;
    setInput('');
    const history = msgs.slice(-6).map((m) => ({ role: m.role, content: m.content.slice(0, 500) }));
    setMsgs((prev) => [...prev, { role: 'user', content: t }, { role: 'assistant', content: '', pending: true }]);
    setSending(true);
    try {
      const res = await answerFinancialQuestion(t, { history });
      settleLast({ content: res.answer, source: res.source });
    } catch (e) {
      settleLast({ content: `（回答失败：${(e as Error).message}）` });
    } finally {
      setSending(false);
    }
  }

  /** 专家指令（报告/建议/体检/预测）：单轮流式 LLM，数据为本地脱敏汇总 */
  async function sendExpert(kind: 'report' | 'suggest' | 'diag' | 'forecast') {
    if (!enabled) {
      toast.info('请先在「AI 设置」中开启并配置凭证');
      return;
    }
    if (sending) return;
    const meta = {
      report: { label: '📄 生成月度报告', user: '请生成该月财务月度报告：收支概况、分类占比、资产变化、值得注意的点与下月建议。', system: '你是个人财务助手，依据以下汇总数据输出结构化中文报告（分小节）：' },
      suggest: { label: '💡 省钱与理财建议', user: '请基于这些数据给出 3-5 条具体、可执行的省钱/理财建议，按优先级排序。', system: '你是个人财务顾问。数据：' },
      diag: { label: '🩺 财务体检', user: '请输出本月的财务体检报告。', system: DIAGNOSIS_SYSTEM },
      forecast: { label: '🔮 下月预测', user: '请预测下个月并给出风险预警。', system: FORECAST_SYSTEM },
    }[kind];

    setMsgs((prev) => [...prev, { role: 'user', content: meta.label }, { role: 'assistant', content: '', pending: true }]);
    setSending(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      let messages: { role: 'system' | 'user'; content: string }[];
      if (kind === 'diag' || kind === 'forecast') {
        const { text } = await buildDiagnosisContext(anchor?.month, anchor?.dim);
        messages = [
          { role: 'system', content: `${meta.system}\n\n（数据为本地脱敏汇总，不含明细）` },
          { role: 'user', content: `${meta.user}\n\n数据：\n${text}` },
        ];
      } else {
        const ctx = await buildAggregateContext();
        messages = [
          { role: 'system', content: `${meta.system}\n${ctx}` },
          { role: 'user', content: meta.user },
        ];
      }
      await chatStream(messages, { onDelta: appendLast, signal: ac.signal });
      settleLast({ source: 'ai' });
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? '（已停止生成）' : `（生成失败：${(e as Error).message}）`;
      setMsgs((prev) => prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: m.content || msg, pending: false } : m)));
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  }

  // FIM 续写补全：用 DeepSeek /beta/completions 把当前输入续写成完整句子（仅 DeepSeek 凭证可用）
  async function continueText() {
    const s = input.trim();
    if (!s || fimBusy) return;
    setFimBusy(true);
    try {
      const r = await completeFIM({ prompt: s, max_tokens: 96 });
      setInput((prev) => (prev ? (prev.endsWith(r.text) ? prev : prev + r.text) : r.text));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setFimBusy(false);
    }
  }

  // 预算建议流程：云端只收「编号 + 汇总金额」，本地把编号映射回真实分类后待用户确认写入
  async function runBudgetProposal() {
    if (!enabled) {
      toast.info('请先在「AI 设置」中开启并配置凭证');
      return;
    }
    setBudgetLoading(true);
    setBudgetItems([]);
    setBudgetChecked([]);
    setBudgetConfirming(false);
    setBudgetUndoToken(null);
    setBudgetStatus(null);
    try {
      const { text, itemsMap } = await buildBudgetProposal();
      // 预算建议无需流式展示：onDelta 传空实现，仅取完整返回文本
      const raw = await chatStream(
        [
          { role: 'system', content: BUDGET_SYSTEM },
          { role: 'user', content: text },
        ],
        { onDelta: () => {} }
      );
      const recs = parseBudgetRecommendations(raw);
      const items = recs
        .map((r) => {
          const base = itemsMap[r.token];
          return {
            categoryId: base?.categoryId ?? null,
            categoryName: base?.categoryName ?? r.token,
            amount: Math.max(0, Number(r.amount)),
            basis: r.basis,
          };
        })
        .filter((i) => i.amount > 0);
      if (!items.length) {
        setBudgetStatus({ kind: 'error', msg: 'AI 未返回可写入的预算建议，请重试。' });
        return;
      }
      setBudgetItems(items);
      setBudgetChecked(items.map(() => true));
    } catch (e) {
      setBudgetStatus({ kind: 'error', msg: (e as Error).message });
    } finally {
      setBudgetLoading(false);
    }
  }

  async function confirmBudgetWrite() {
    if (budgetApplying) return;
    const selected = budgetItems.filter((_, i) => budgetChecked[i] && budgetItems[i].amount > 0);
    if (!selected.length) return;
    setBudgetApplying(true);
    setBudgetStatus(null);
    try {
      const token = await applyBudgetProposal(selected);
      setBudgetUndoToken(token);
      setBudgetConfirming(false);
      setBudgetStatus({ kind: 'success', msg: `已写入 ${selected.length} 项预算` });
      toast.success('已写入预算');
    } catch (e) {
      setBudgetStatus({ kind: 'error', msg: (e as Error).message });
      toast.error((e as Error).message);
    } finally {
      setBudgetApplying(false);
    }
  }

  async function undoBudget() {
    if (!budgetUndoToken) return;
    try {
      await undoBudgetProposal(budgetUndoToken);
      setBudgetUndoToken(null);
      setBudgetItems([]);
      setBudgetChecked([]);
      setBudgetConfirming(false);
      setBudgetStatus(null);
      toast.info('已撤销');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function reset() {
    abortRef.current?.abort();
    clearMsgs();
    setInput('');
    setBudgetItems([]);
    setBudgetChecked([]);
    setBudgetUndoToken(null);
    setBudgetStatus(null);
  }

  const hasBudgetPanel = budgetLoading || budgetItems.length > 0 || !!budgetStatus || !!budgetUndoToken;

  return (
    <div>
      {/* 消息流（连续对话，仅在此弹窗内展示，不占用页面空间） */}
      <div ref={scrollRef} className="mb-2 flex max-h-[44vh] min-h-[180px] flex-col gap-2 overflow-auto pr-1 text-sm">
        {msgs.length === 0 ? (
          <p className="m-auto py-6 text-center text-muted">
            输入问题即可咨询，例如「上个月餐饮花了多少」。可连续追问；
            {enabled ? '上方快捷按钮可生成报告 / 体检 / 预测。' : '开启 AI 后还可用报告、体检、预测等深度能力。'}
          </p>
        ) : (
          msgs.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 leading-relaxed ${
                  m.role === 'user' ? 'text-white' : 'border border-[var(--border)] bg-black/2 dark:bg-white/5'
                }`}
                style={m.role === 'user' ? { background: 'var(--color-primary)' } : undefined}
              >
                {m.role === 'assistant' && <span className="mr-1 text-[10px]">💰</span>}
                {m.content}
                {m.pending && <span className="ml-1 animate-pulse">▍</span>}
                {m.role === 'assistant' && !m.pending && m.source && (
                  <span className="ml-2 align-middle text-[10px] text-muted">{m.source === 'ai' ? 'AI' : '本地'}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 快捷问答（本地规则即可作答，零 token） */}
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {QUICK_QUERIES.map((p) => (
          <button
            key={p}
            type="button"
            disabled={sending}
            onClick={() => void sendQuestion(p)}
            className="rounded-full border border-[var(--border)] px-2.5 py-0.5 text-xs text-muted hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
          >
            {p}
          </button>
        ))}
      </div>

      {/* AI 分析快捷指令（需开启 AI；每次点击只发起一次请求，结果留在对话中可追问） */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <QuickChip disabled={!enabled || sending} onClick={() => void sendExpert('report')}>📄 月度报告</QuickChip>
        <QuickChip disabled={!enabled || sending} onClick={() => void sendExpert('suggest')}>💡 省钱建议</QuickChip>
        <QuickChip disabled={!enabled || sending} onClick={() => void sendExpert('diag')}>🩺 财务体检</QuickChip>
        <QuickChip disabled={!enabled || sending} onClick={() => void sendExpert('forecast')}>🔮 下月预测</QuickChip>
        <QuickChip disabled={!enabled || sending || budgetLoading} onClick={() => void runBudgetProposal()}>📋 预算建议·可写入</QuickChip>
        {msgs.length > 0 && (
          <button
            type="button"
            onClick={reset}
            className="ml-auto rounded-full border border-[var(--color-danger)]/40 px-2.5 py-0.5 text-xs text-[var(--color-danger)] hover:opacity-80"
          >
            清空对话
          </button>
        )}
      </div>

      {/* 预算建议面板（仅在触发后出现） */}
      {hasBudgetPanel && (
        <BudgetProposalPanel
          items={budgetItems}
          checked={budgetChecked}
          loading={budgetLoading}
          applying={budgetApplying}
          confirming={budgetConfirming}
          undoToken={budgetUndoToken}
          status={budgetStatus}
          onToggle={(i) => setBudgetChecked((prev) => prev.map((v, idx) => (idx === i ? !v : v)))}
          onShowConfirm={() => setBudgetConfirming(true)}
          onConfirm={confirmBudgetWrite}
          onCancelConfirm={() => setBudgetConfirming(false)}
          onUndo={undoBudget}
        />
      )}

      {/* 输入区 */}
      <div className="mt-2 flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void sendQuestion(input); }}
          placeholder="追问：例如「那下个月呢？」"
          className="h-9 flex-1 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm outline-none"
        />
        <Button variant="outline" size="sm" onClick={continueText} disabled={sending || fimBusy || !input.trim()}>
          {fimBusy ? '补全中…' : '续写补全'}
        </Button>
        <Button size="sm" disabled={sending || !input.trim()} onClick={() => void sendQuestion(input)}>
          {sending ? '思考中…' : '发送'}
        </Button>
      </div>
      <p className="mt-1.5 text-[10px] text-muted">
        连续对话共享上下文（仅带最近几条、单条截断，控制 token）；启用 AI 时自动接入，仅上送脱敏聚合事实，不含单笔明细。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 自然语言记账 Tab（原仪表盘 AiAssistant 的记账能力，逻辑不变）
// ---------------------------------------------------------------------------

function BookTab() {
  const [input, setInput] = useState('');
  const [parsing, setParsing] = useState(false);
  const [pendingList, setPendingList] = useState<AiBookItem[]>([]);
  const [bookError, setBookError] = useState('');
  const [bookMsg, setBookMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { create } = useTransactionMutations();
  const { data: accounts = [] } = useAccounts(false);
  const { data: cats = [] } = useCategories();

  // 解析记账语句（多句批量，可被取消）。
  // 隐私安全：user 内容只含记账文本与账户/分类名称白名单；BOOK_SYSTEM 已约束
  // 「只能从清单选择名称，不得编造」，回复限定为 JSON 数组。
  async function runParse() {
    const s = input.trim();
    if (!s || parsing) return;
    setParsing(true);
    setBookError('');
    setBookMsg('');
    setPendingList([]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      // 名称白名单：仅传名称，不传余额/统计/明细
      const nameList = [
        `账户：${accounts.map((a) => a.name).join('、')}`,
        `支出分类：${cats.filter((c) => c.type === 'expense').map((c) => c.name).join('、')}`,
        `收入分类：${cats.filter((c) => c.type === 'income').map((c) => c.name).join('、')}`,
      ].join('；');
      for (const stmt of splitStatements(s)) {
        if (abortRef.current === null) break; // 已取消
        const raw = await chatStream(
          [
            { role: 'system', content: BOOK_SYSTEM },
            { role: 'user', content: `${nameList}\n记账内容：${stmt}` },
          ],
          // 记账解析不需要流式展示，仅取完整返回文本（onDelta 空实现）
          { onDelta: () => {}, signal: ac.signal }
        );
        const items = parseBookOutput(raw, accounts, cats);
        if (items.length) setPendingList((prev) => [...prev, ...items]);
        setInput('');
      }
      // 全部解析完毕仍为空：给出提示（不允许直接抛错中断整批）
      setPendingList((prev) => {
        if (prev.length === 0 && abortRef.current !== null) {
          setBookError('未能从描述中解析出有效记账内容，请补充金额/账户信息后重试，或改用手动记账。');
        }
        return prev;
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== '已取消') setBookError(msg);
    } finally {
      abortRef.current = null;
      setParsing(false);
    }
  }

  function cancelParse() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  async function confirmBook() {
    if (!pendingList.length || busy) return;
    // 账户未匹配（accountId/toAccountId 缺失）的条目无法入库：整批阻止并提示修正，防止误记账
    const missingAccount = (it: AiBookItem) =>
      it.type === 'transfer' ? it.toAccountId == null : it.accountId == null;
    if (pendingList.some(missingAccount)) {
      setPendingList((prev) =>
        prev.map((it) => ({
          ...it,
          unmatched: [...new Set([...(it.unmatched ?? []), ...(missingAccount(it) ? (['account'] as const) : [])])],
        }))
      );
      toast.error('存在账户未匹配的条目，请修正后再确认记账（或删除该条）。');
      return;
    }
    setBusy(true);
    try {
      const valid = pendingList.filter((it) => it.amount > 0);
      for (const it of valid) {
        await create.mutateAsync({
          type: it.type,
          amount: it.amount,
          categoryId: it.categoryId,
          accountId: it.accountId as number,
          toAccountId: it.toAccountId,
          date: it.date,
          note: it.note,
          // 交易明细 5 字段：AI 识别出即一并写入，避免在文字记账入口丢失
          payTime: it.payTime,
          payMethod: it.payMethod,
          payee: it.payee,
          orderNo: it.orderNo,
          merchantOrderNo: it.merchantOrderNo,
        });
      }
      setPendingList([]);
      setBookMsg(`✅ 记账成功（${valid.length} 笔）`);
      toast.success(`AI 记账成功（${valid.length} 笔）`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={2}
        placeholder="例：午饭 25 元 用微信支付；可一句多条，如「打车 32 元，买菜 68 元」"
        className="w-full resize-none rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm outline-none"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={runParse} disabled={parsing || !input.trim()}>{parsing ? '解析中…' : '解析记账'}</Button>
        {parsing && <Button variant="outline" onClick={cancelParse}>取消</Button>}
        {pendingList.length > 0 && (
          <>
            <Button
              onClick={confirmBook}
              disabled={busy || pendingList.some((it) => (it.type === 'transfer' ? it.toAccountId == null : it.accountId == null))}
              title={pendingList.some((it) => (it.type === 'transfer' ? it.toAccountId == null : it.accountId == null)) ? '存在账户未匹配的条目，请修正后再确认' : undefined}
            >
              {busy ? '记账中…' : `确认记账（${pendingList.length} 笔）`}
            </Button>
            <Button variant="outline" onClick={() => setPendingList([])}>放弃</Button>
          </>
        )}
        {bookError && <Button variant="outline" onClick={() => { setBookError(''); void runParse(); }}>重试</Button>}
      </div>

      <BookOutcome
        parsing={parsing}
        pendingList={pendingList}
        error={bookError}
        msg={bookMsg}
        onPatch={(idx, patch) =>
          setPendingList((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded px-2 py-1 text-sm"
      style={active ? { background: 'var(--color-primary)', color: '#fff' } : { color: 'var(--muted)' }}
    >
      {children}
    </button>
  );
}

function QuickChip({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-full border border-[var(--color-primary)]/40 px-2.5 py-0.5 text-xs text-[var(--color-primary-fg)] hover:bg-[var(--color-primary)]/10 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** 记账结果面板：多行可编辑预览（类型/金额/备注等），修改直接写回父级 pendingList */
function BookOutcome({ parsing, pendingList, error, msg, onPatch }: {
  parsing: boolean;
  pendingList: AiBookItem[];
  error: string;
  msg: string;
  onPatch: (idx: number, patch: Partial<AiBookItem>) => void;
}) {
  if (parsing) {
    return (
      <div className="mt-3 rounded-lg border border-[var(--border)] p-3 text-sm text-muted">
        AI 解析中…（可点击「取消」中断，数据仅发送到你在设置中配置的接口）
      </div>
    );
  }
  if (msg) {
    return (
      <div className="mt-3 rounded-lg border border-[var(--border)] p-3 text-sm" style={{ color: 'var(--color-success)' }}>
        {msg}
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-3 rounded-lg border border-[var(--border)] p-3 text-sm" style={{ color: 'var(--color-danger)' }}>
        {error}（可修改描述后点击「重试」，或改用手动记账）
      </div>
    );
  }
  if (!pendingList.length) return null;
  return (
    <div className="mt-3 rounded-lg border border-[var(--border)] p-3 text-sm">
      <p className="mb-2 font-medium">解析结果（请逐条核对，可直接修改后点击「确认记账」）：</p>
      <div className="space-y-2">
        {pendingList.map((it, idx) => (
          <Fragment key={idx}>
          <div className="grid grid-cols-2 items-center gap-2 rounded-lg border border-[var(--border)] p-2 sm:grid-cols-6">
            <select
              value={it.type}
              onChange={(e) => onPatch(idx, { type: e.target.value as AiBookItem['type'] })}
              className="h-8 rounded border border-[var(--border)] bg-[var(--card)] px-1.5 text-xs"
            >
              {Object.entries(TX_TYPES).filter(([k]) => ['income', 'expense', 'transfer', 'lend', 'borrow'].includes(k)).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            <input
              type="number"
              min="0"
              step="0.01"
              value={Number.isFinite(it.amount) ? it.amount : ''}
              onChange={(e) => onPatch(idx, { amount: Number(e.target.value) || 0 })}
              placeholder="金额"
              className="h-8 rounded border border-[var(--border)] bg-transparent px-1.5 text-xs"
            />
            <input
              type="date"
              value={it.date}
              onChange={(e) => onPatch(idx, { date: e.target.value })}
              className="h-8 rounded border border-[var(--border)] bg-transparent px-1.5 text-xs"
            />
            <input
              value={it.note}
              onChange={(e) => onPatch(idx, { note: e.target.value })}
              placeholder="备注"
              className="h-8 rounded border border-[var(--border)] bg-transparent px-1.5 text-xs"
            />
            {it.unmatched?.includes('category') && (
              <span className="text-[10px]" style={{ color: 'var(--color-danger)' }}>分类未匹配</span>
            )}
            {it.unmatched?.includes('account') && (
              <span className="text-[10px]" style={{ color: 'var(--color-danger)' }}>账户未匹配</span>
            )}
          </div>
          {/* 交易明细 5 字段：仅在任一字段有值时展开，可直接修改后一并落库 */}
          {(it.payTime || it.payMethod || it.payee || it.orderNo || it.merchantOrderNo) && (
            <div className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-black/2 px-2 py-1.5 text-xs dark:bg-white/5">
              <input
                value={it.payTime ?? ''}
                onChange={(e) => onPatch(idx, { payTime: e.target.value || undefined })}
                placeholder="支付时间"
                className="h-7 w-40 rounded border border-[var(--border)] bg-transparent px-1.5"
              />
              <input
                value={it.payMethod ?? ''}
                onChange={(e) => onPatch(idx, { payMethod: e.target.value || undefined })}
                placeholder="付款方式"
                className="h-7 w-28 rounded border border-[var(--border)] bg-transparent px-1.5"
              />
              <input
                value={it.payee ?? ''}
                onChange={(e) => onPatch(idx, { payee: e.target.value || undefined })}
                placeholder="收款方全称"
                className="h-7 w-36 rounded border border-[var(--border)] bg-transparent px-1.5"
              />
              <input
                value={it.orderNo ?? ''}
                onChange={(e) => onPatch(idx, { orderNo: e.target.value || undefined })}
                placeholder="订单号"
                className="h-7 w-40 rounded border border-[var(--border)] bg-transparent px-1.5"
              />
              <input
                value={it.merchantOrderNo ?? ''}
                onChange={(e) => onPatch(idx, { merchantOrderNo: e.target.value || undefined })}
                placeholder="商家订单号"
                className="h-7 w-40 rounded border border-[var(--border)] bg-transparent px-1.5"
              />
            </div>
          )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/**
 * 预算建议面板：展示 AI 建议的分类预算额度（真实分类名仅在本地面板显示，不上传云端），
 * 用户勾选后「一键写入」，写入本地成功后提供「撤销」按钮。
 */
function BudgetProposalPanel({
  items,
  checked,
  loading,
  applying,
  confirming,
  undoToken,
  status,
  onToggle,
  onShowConfirm,
  onConfirm,
  onCancelConfirm,
  onUndo,
}: {
  items: BudgetProposalItem[];
  checked: boolean[];
  loading: boolean;
  applying: boolean;
  confirming: boolean;
  undoToken: string | null;
  status: { kind: 'success' | 'error'; msg: string } | null;
  onToggle: (i: number) => void;
  onShowConfirm: () => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  onUndo: () => void;
}) {
  if (loading) {
    return (
      <div className="mt-2 rounded-lg border border-[var(--border)] p-3 text-sm text-muted">
        AI 正在生成预算建议…（仅发送编号与汇总金额，真实分类名不会上传）
      </div>
    );
  }
  if (!items.length && !status && !undoToken) return null;

  const selectedCount = items.filter((_, i) => checked[i] && items[i].amount > 0).length;

  return (
    <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-[var(--border)] p-3 text-sm">
      <h4 className="mb-2 font-medium">📋 预算建议（勾选后一键写入）</h4>
      {undoToken && (
        <div className="mb-2">
          <Button variant="outline" size="sm" onClick={onUndo} disabled={applying}>
            ↩ 撤销本次写入
          </Button>
        </div>
      )}
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={checked[i] ?? false}
              onChange={() => onToggle(i)}
              disabled={applying || confirming}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="font-medium">{it.categoryName}</span>
                <span className="font-semibold" style={{ color: 'var(--color-primary)' }}>
                  ¥{it.amount.toFixed(2)}
                </span>
              </div>
              {it.basis && <div className="text-xs text-muted">{it.basis}</div>}
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!undoToken && (
          confirming ? (
            <>
              <Button size="sm" onClick={onConfirm} disabled={applying || selectedCount === 0}>
                {applying ? '写入中…' : `确认写入这 ${selectedCount} 项预算？`}
              </Button>
              <Button size="sm" variant="outline" onClick={onCancelConfirm} disabled={applying}>取消</Button>
            </>
          ) : (
            <Button size="sm" onClick={onShowConfirm} disabled={applying || selectedCount === 0}>
              {applying ? '写入中…' : `一键写入预算（${selectedCount}项）`}
            </Button>
          )
        )}
        {status && (
          <span
            className="inline-flex items-center gap-1.5 text-xs"
            style={{ color: status.kind === 'success' ? 'var(--color-success)' : 'var(--color-danger)' }}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{
                background: status.kind === 'success' ? 'var(--color-success)' : 'var(--color-danger)',
              }}
            />
            {status.msg}
          </span>
        )}
      </div>
    </div>
  );
}