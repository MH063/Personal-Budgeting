import { useEffect, useMemo, useState } from 'react';
import { useForm, Controller, type FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import dayjs from 'dayjs';
import { toast } from 'sonner';
import { Sheet } from '@/components/ui/modal';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { AmountInput } from './AmountInput';
import { CategoryPicker } from './CategoryPicker';
import { AccountPicker } from './AccountPicker';
import { TagPicker } from './TagPicker';
import OcrModal from './OcrModal';
import { useTransactionMutations } from '@/hooks/useTransactions';
import { getTransactionTags } from '@/api/tags';
import { listNegativeAccounts, listAccounts } from '@/api/accounts';
import { listCategories } from '@/api/categories';
import { suggestForText, type SuggestResult, classifyConfidence } from '@/api/aiSuggest';
import { getBudgetVsActualAdvanced } from '@/api/stats';
import { computeBudgetUsage, getUsageForCategory, budgetWarnMessage, type BudgetUsage } from '@/lib/budgetGuard';
import { resolveBookDate, listTransactions, type TransactionDetail } from '@/api/transactions';
import { listTemplates, createTemplate, templateToForm, type TxnTemplate, type TxnTemplatePayload } from '@/api/txnTemplate';
import { recommendTags, recommendMerchant } from '@/api/autocomplete';
import { listTags, listTagsByTransactions } from '@/api/tags';
import type { AiBookItem } from '@/api/aiBook';

const schema = z.object({
  type: z.enum(['income', 'expense', 'transfer', 'lend', 'borrow']),
  amount: z.coerce.number().positive('金额必须大于 0'),
  categoryId: z.coerce.number().optional(),
  accountId: z.coerce.number().optional(),
  toAccountId: z.coerce.number().optional(),
  date: z.string().min(1, '请选择日期'),
  note: z.string().optional(),
  payTime: z.string().optional(),
  payMethod: z.string().optional(),
  payee: z.string().optional(),
  orderNo: z.string().optional(),
  merchantOrderNo: z.string().optional(),
  tagIds: z.array(z.number()).optional(),
})
// 必填校验（需求：金额/分类/账户/日期/订单号以红色 * 标识并按类型动态生效）：
//  - 金额、账户、日期：全部类型必填（编辑时已预填，正常不会缺）；
//  - 分类：仅收入/支出必填（转账/借出/借入无分类概念）；
//  - 转入账户：仅转账必填；
//  - 订单号：新增记账必填（红色 * 标识 + onSubmit 内校验），编辑旧交易不强制，
//    避免历史无订单号的数据无法修改保存。
.superRefine((d, ctx) => {
  if (d.type === 'income' || d.type === 'expense') {
    if (d.categoryId == null) ctx.addIssue({ code: 'custom', path: ['categoryId'], message: '请选择分类' });
  }
  if (d.accountId == null) ctx.addIssue({ code: 'custom', path: ['accountId'], message: '请选择账户' });
  if (d.type === 'transfer' && d.toAccountId == null) {
    ctx.addIssue({ code: 'custom', path: ['toAccountId'], message: '请选择转入账户' });
  }
});

type FormData = z.infer<typeof schema>;

const TYPE_TABS = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '转账' },
  { value: 'lend', label: '借出' },
  { value: 'borrow', label: '借入' },
] as const;

// repay_in/repay_out 不在表单可选类型中，编辑时映射为对应的基础类型
function mapEditType(t: string): FormData['type'] {
  if (t === 'repay_in') return 'lend';
  if (t === 'repay_out') return 'borrow';
  return t as FormData['type'];
}

export default function TransactionForm({ open, onOpenChange, defaultType = 'expense', editTarget }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultType?: FormData['type'];
  editTarget?: TransactionDetail | null;
}) {
  const { create, update } = useTransactionMutations();
  const isEditing = !!editTarget;
  const [ocrOpen, setOcrOpen] = useState(false);
  // AI/本地「智能归类」：依据备注/收款方推荐分类与账户（普通/上云受 allowDetail 与脱敏约束）
  const [suggest, setSuggest] = useState<SuggestResult | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  // 智能补全·模板复用：常用交易模板一键套用 / 另存为模板
  const [templates, setTemplates] = useState<TxnTemplate[]>([]);
  const [savingTpl, setSavingTpl] = useState(false);
  const [tplName, setTplName] = useState('');
  // 历史驱动补全：推荐标签 / 商户
  const [recTags, setRecTags] = useState<number[]>([]);
  const [recMerchants, setRecMerchants] = useState<string[]>([]);
  const [tagNameMap, setTagNameMap] = useState<Record<number, string>>({});
  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      type: editTarget ? mapEditType(editTarget.type) : defaultType,
      amount: editTarget?.amount ?? (0 as unknown as number),
      categoryId: editTarget?.category_id ?? undefined,
      accountId: editTarget?.account_id ?? (undefined as unknown as number),
      toAccountId: editTarget?.to_account_id ?? undefined,
      date: editTarget?.date ?? dayjs().format('YYYY-MM-DD'),
      note: editTarget?.note ?? '',
      payTime: editTarget?.pay_time ?? '',
      payMethod: editTarget?.pay_method ?? '',
      payee: editTarget?.payee ?? '',
      orderNo: editTarget?.order_no ?? '',
      merchantOrderNo: editTarget?.merchant_order_no ?? '',
    },
  });
  const type = form.watch('type');
  const pending = isEditing ? update.isPending : create.isPending;
  const selectedCategoryId = form.watch('categoryId');

  // 当月各类预算实况（仅支出方向需要）；供超支红点强提醒（只提醒，不禁止记账）
  const ym = dayjs().format('YYYY-MM');
  const { data: budgetRows = [] } = useQuery({
    queryKey: ['budgetGuard', 'monthly', ym],
    queryFn: () => getBudgetVsActualAdvanced({ period: 'monthly', anchor: ym }),
    enabled: open && type === 'expense',
  });
  const budgetUsage = useMemo(
    () => computeBudgetUsage(budgetRows),
    [budgetRows]
  );
  const catBudget: BudgetUsage | null = type === 'expense'
    ? getUsageForCategory(budgetUsage, selectedCategoryId)
    : null;

  // 编辑时预填已有标签
  const { data: editTagIds = [] } = useQuery({
    queryKey: ['txTags', editTarget?.id],
    queryFn: () => (editTarget ? getTransactionTags(editTarget.id) : []),
    enabled: !!editTarget && open,
  });
  useEffect(() => {
    if (open && editTarget) form.setValue('tagIds', editTagIds);
  }, [editTagIds, open, editTarget, form]);

  // editTarget 变化或弹窗打开时重置表单为编辑目标值
  useEffect(() => {
    if (!open) return;
    setSuggest(null);
    if (editTarget) {
      form.reset({
        type: mapEditType(editTarget.type),
        amount: editTarget.amount,
        categoryId: editTarget.category_id ?? undefined,
        accountId: editTarget.account_id,
        toAccountId: editTarget.to_account_id ?? undefined,
        date: editTarget.date,
        note: editTarget.note,
        payTime: editTarget.pay_time ?? '',
        payMethod: editTarget.pay_method ?? '',
        payee: editTarget.payee ?? '',
        orderNo: editTarget.order_no ?? '',
        merchantOrderNo: editTarget.merchant_order_no ?? '',
        tagIds: [],
      });
    } else {
      form.reset({
        type: defaultType,
        amount: 0 as unknown as number,
        categoryId: undefined,
        accountId: undefined as unknown as number,
        toAccountId: undefined,
        date: dayjs().format('YYYY-MM-DD'),
        note: '',
        payTime: '',
        payMethod: '',
        payee: '',
        orderNo: '',
        merchantOrderNo: '',
        tagIds: [],
      });
    }
  }, [editTarget?.id, open, form]);

  // 打开弹窗时加载常用交易模板与标签名映射（本机表，无网络）
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const [tpls, tags] = await Promise.all([listTemplates(), listTags()]);
      setTemplates(tpls);
      setTagNameMap(Object.fromEntries(tags.map((t) => [t.id, t.name])));
    })();
  }, [open]);

  /** 一键套用模板：把模板回填到表单（金额留空的模板提示手填，金额必填由保存时校验兜底） */
  function applyTpl(t: TxnTemplate) {
    const f = templateToForm(t);
    form.setValue('type', f.type);
    if (f.amount != null) form.setValue('amount', f.amount as unknown as number);
    if (f.accountId) form.setValue('accountId', f.accountId as unknown as number);
    if (f.categoryId) form.setValue('categoryId', f.categoryId);
    if (f.toAccountId) form.setValue('toAccountId', f.toAccountId);
    form.setValue('note', f.note);
    form.setValue('payee', f.payee);
    form.setValue('payMethod', f.payMethod);
    form.setValue('tagIds', f.tagIds);
    toast.success(f.amount != null ? `已套用模板「${t.name}」` : `已套用模板「${t.name}」，请填写本次金额`);
  }

  /** 把当前表单另存为常用交易模板 */
  async function saveTpl() {
    const name = tplName.trim();
    if (!name) { toast.error('请填写模板名称'); return; }
    const amount = Number(form.watch('amount'));
    const payload: TxnTemplatePayload = {
      name,
      type: form.watch('type'),
      amount: amount > 0 ? amount : null, // 金额未填 → 存为空，每次手填
      categoryId: form.watch('categoryId'),
      accountId: form.watch('accountId'),
      toAccountId: form.watch('toAccountId'),
      note: form.watch('note') ?? '',
      payee: form.watch('payee') ?? '',
      payMethod: form.watch('payMethod') ?? '',
      tagIds: form.watch('tagIds') ?? [],
    };
    try {
      await createTemplate(payload);
      setTemplates(await listTemplates());
      setTplName('');
      setSavingTpl(false);
      toast.success('已保存为常用模板');
    } catch (e) {
      toast.error(`保存模板失败：${(e as Error).message}`);
    }
  }

  /** 采纳补全推荐的标签（追加，不覆盖已有选择） */
  function adoptTag(id: number) {
    const cur = form.watch('tagIds') ?? [];
    if (!cur.includes(id)) form.setValue('tagIds', [...cur, id]);
  }
  /** 采纳补全推荐的商户名到收款方 */
  function adoptMerchant(name: string) {
    form.setValue('payee', name);
  }

  async function onSubmit(d: FormData) {
    try {
      // 订单号：仅新增记账必填（红色 * 标识），编辑旧交易不强制——历史数据可能没有订单号
      if (!isEditing && !String(d.orderNo ?? '').trim()) { toast.error('请填写订单号'); return; }
      if (d.type === 'transfer' && !d.toAccountId) { toast.error('请选择转入账户'); return; }
      // 支出方向：该分类预算已超支/接近上限时强提醒（只提醒，不阻断记账）
      if (d.type === 'expense' && d.categoryId != null) {
        const usage = getUsageForCategory(budgetUsage, d.categoryId);
        if (usage && usage.status === 'over') {
          toast.error(`${budgetWarnMessage(usage)}。真实消费仍会记录，建议关注。`);
        } else if (usage && usage.status === 'warn') {
          toast.warning(budgetWarnMessage(usage));
        }
      }
      // ---- 日期(date) 与支付时间(payTime) 的关系 ----
      // date   = 账务归属日（记账轴，粒度到日，用于按日/月/年归集统计）
      // payTime= 实际支付时刻（交易明细，可含时分秒）
      // 二者同源但维度不同：date 只写日期、payTime 才写精确时刻。
      // resolveBookDate 保证：date 已有值不变；date 缺失时用 payTime 日期补全，避免「记账日≠支付日」。
      const date = resolveBookDate(d.date, d.payTime);
      const payload = {
        type: d.type, amount: d.amount,
        categoryId: d.categoryId, accountId: d.accountId as number, // superRefine 已保证账户必填
        toAccountId: d.toAccountId, date, note: d.note,
        // 付款方式(payMethod) 与账户(accountId) 关系：
        // accountId = 我方的资金账户实体（决定余额增减，必填）；
        // payMethod = 采用的支付手段（微信支付/支付宝/银行卡…），仅作交易明细描述，
        // 不与账户强绑定、也不自动改写账户，二者独立回填避免误改真实资金账户。
        payTime: d.payTime || undefined,
        payMethod: d.payMethod || undefined,
        payee: d.payee || undefined,
        orderNo: d.orderNo || undefined,
        merchantOrderNo: d.merchantOrderNo || undefined,
        tagIds: d.tagIds ?? [],
      };
      if (isEditing && editTarget) {
        await update.mutateAsync({ id: editTarget.id, p: payload });
        toast.success('修改成功');
      } else {
        await create.mutateAsync(payload);
        toast.success('记账成功');
      }
      // 记录后校验：现金/银行/钱包/投资/储蓄等受限账户余额为负时给出提示
      const negatives = await listNegativeAccounts();
      if (negatives.length) {
        toast.warning(
          `账户余额不足，已为负：${negatives.map((a) => `${a.icon}${a.name} -¥${Math.abs(a.balance)}`).join('、')}`
        );
      }
      form.reset({
        type: defaultType,
        amount: 0 as unknown as number,
        categoryId: undefined,
        accountId: undefined as unknown as number,
        toAccountId: undefined,
        date: dayjs().format('YYYY-MM-DD'),
        note: '',
        payTime: '',
        payMethod: '',
        payee: '',
        orderNo: '',
        merchantOrderNo: '',
        tagIds: [],
      });
      onOpenChange(false);
    } catch (e) {
      toast.error(`${isEditing ? '修改' : '记账'}失败：${(e as Error).message}`);
    }
  }

  // 把 OCR 识别出的记账项回填到表单（类型/金额/分类/账户/日期/备注/交易扩展字段）
  function applyOcrItem(item: AiBookItem) {
    form.setValue('type', item.type);
    form.setValue('amount', item.amount as unknown as number);
    if (item.categoryId) form.setValue('categoryId', item.categoryId);
    if (item.accountId) form.setValue('accountId', item.accountId as unknown as number);
    if (item.toAccountId) form.setValue('toAccountId', item.toAccountId);
    form.setValue('date', item.date || dayjs().format('YYYY-MM-DD'));
    if (item.note) form.setValue('note', item.note);
    if (item.payTime) form.setValue('payTime', item.payTime);
    if (item.payMethod) form.setValue('payMethod', item.payMethod);
    if (item.payee) form.setValue('payee', item.payee);
    if (item.orderNo) form.setValue('orderNo', item.orderNo);
    if (item.merchantOrderNo) form.setValue('merchantOrderNo', item.merchantOrderNo);
    // 未匹配账户/分类时提示用户手动补选
    if (item.unmatched?.includes('account')) toast.warning('账户未匹配，请手动选择账户');
    if (item.unmatched?.includes('category')) toast.warning('分类未匹配，请手动选择分类');
    toast.success('已填入，请核对后保存');
  }

  /** 批量入账：把 AI/OCR 解析出且账户已匹配的多条一次写入（多商品小票），未匹配的提示手动填 */
  function applyOcrBatch(items: AiBookItem[]) {
    void (async () => {
      const valid = items.filter((it) => it.amount > 0 && it.accountId != null);
      if (!valid.length) { toast.warning('没有账户已匹配的条目可直接入账，请逐条填入后手动选择账户'); return; }
      try {
        for (const it of valid) {
          await create.mutateAsync({
            type: it.type, amount: it.amount, categoryId: it.categoryId,
            accountId: it.accountId as number, toAccountId: it.toAccountId,
            date: it.date, note: it.note,
            payTime: it.payTime, payMethod: it.payMethod, payee: it.payee,
            orderNo: it.orderNo, merchantOrderNo: it.merchantOrderNo, tagIds: [],
          });
        }
        const skipped = items.length - valid.length;
        toast.success(`已入账 ${valid.length} 笔${skipped ? `，${skipped} 笔需逐条手动填写` : ''}`);
        onOpenChange(false);
      } catch (e) {
        toast.error(`批量入账失败：${(e as Error).message}`);
      }
    })();
  }

  /** 智能归类：用「收款方 + 备注」推荐分类与账户。未开可发送明文时仅跑本地规则（零外泄）。 */
  async function runSuggest() {
    const txt = `${form.watch('payee') || ''} ${form.watch('note') || ''}`.trim();
    if (!txt) { toast.info('请先填写备注或收款方，再使用智能归类'); return; }
    setSuggesting(true);
    try {
      const [cats, accs] = await Promise.all([listCategories(), listAccounts(false)]);
      // 分类白名单按当前类型过滤；账户用全部可持账户作为可选项
      const typeCats = cats.filter((c) => c.type === type).map((c) => c.name);
      const accOptions = accs.map((a) => ({ id: a.id, name: a.name }));
      const res = await suggestForText(txt, { categories: typeCats, accounts: accOptions });
      setSuggest(res);
      // 历史驱动补全：基于近 200 笔记账的共现情况，推荐高频标签与商户（仅本地统计，零外泄）
      try {
        const txs = await listTransactions({ limit: 200 });
        const tagsByTx = await listTagsByTransactions(txs.map((t) => t.id));
        const history = txs.map((t) => ({
          note: t.note || '',
          payee: t.payee || '',
          tagIds: (tagsByTx[t.id] ?? []).map((x) => x.id),
        }));
        setRecTags(recommendTags(txt, history));
        setRecMerchants(recommendMerchant(txt, history));
      } catch {
        setRecTags([]);
        setRecMerchants([]);
      }
      if (res.source === 'local' && !res.categories.length && !res.account) {
        toast.info('未识别到分类/账户，可手动选择');
      }
    } catch (e) {
      toast.error(`智能识别失败：${(e as Error).message}`);
    } finally {
      setSuggesting(false);
    }
  }

  /** 采纳推荐分类：按名称回填分类 id */
  function adoptCategory(name: string) {
    if (type !== 'income' && type !== 'expense') return;
    listCategories().then((cats) => {
      const c = cats.find((x) => x.type === type && x.name === name);
      if (c) form.setValue('categoryId', c.id);
    });
  }
  /** 采纳推荐账户：按名称回填账户 id */
  function adoptAccount(name: string) {
    listAccounts(false).then((accs) => {
      const a = accs.find((x) => x.name === name);
      if (a) form.setValue('accountId', a.id);
    });
  }

  /** 提交前校验失败回调：把第一个必填错误以 toast 提示（字段旁已有红色 * 标识，用户一目了然） */
  const onInvalid = (errs: FieldErrors<FormData>) => {
    const first = Object.values(errs)[0];
    toast.error(String((first as { message?: string })?.message ?? '请检查必填项'));
  };

  return (
    <Sheet open={open} onClose={() => onOpenChange(false)} title={isEditing ? '编辑交易' : '记一笔'}>
      {/* 拍照/票据录入入口：本地 OCR，图片不出本机 */}
      <div className="mb-3 flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={() => setOcrOpen(true)}>
          拍照录入 / 票据记账
        </Button>
      </div>

      {/* 常用交易模板：一键复用 + 另存为模板（智能补全·模板复用） */}
      {!isEditing && (
        <div className="mb-3 rounded-lg border border-[var(--border)] p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-muted">常用模板（一键复用）</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSavingTpl((v) => !v)}>
              {savingTpl ? '取消' : '＋ 存为模板'}
            </Button>
          </div>
          {savingTpl && (
            <div className="mb-2 flex items-center gap-2">
              <Input placeholder="模板名称，如：每月房租" value={tplName} onChange={(e) => setTplName(e.target.value)} className="max-w-[240px]" />
              <Button type="button" size="sm" onClick={() => void saveTpl()}>保存模板</Button>
            </div>
          )}
          {templates.length === 0 ? (
            <p className="text-xs text-muted">暂无模板。填好一笔后点「存为模板」，下次一键套用。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {templates.map((t) => (
                <button key={t.id} type="button" title={`${t.note || t.payee || ''}`} onClick={() => applyTpl(t)}
                  className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]">
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <Tabs value={type} onValueChange={(v) => form.setValue('type', v as FormData['type'])}>
        <TabsList className="grid grid-cols-5">
          {TYPE_TABS.map((t) => <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>)}
        </TabsList>
      </Tabs>

      <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="mt-5 space-y-4">
        <Controller
          control={form.control}
          name="amount"
          render={({ field, fieldState }) => (
            <div>
              <label className="mb-1 flex items-center gap-1 text-sm text-muted">金额 <RequiredStar /></label>
              <AmountInput {...field} error={fieldState.error?.message} />
            </div>
          )}
        />

        {(type === 'income' || type === 'expense') && (
          <div>
            <label className="mb-1 flex items-center gap-1 text-sm text-muted">分类 <RequiredStar /></label>
            <CategoryPicker type={type as 'income' | 'expense'} value={form.watch('categoryId')}
              onChange={(id) => form.setValue('categoryId', id)} />
            {catBudget && catBudget.status !== 'ok' && (
              <BudgetHint usage={catBudget} />
            )}
          </div>
        )}

        <div>
          <label className="mb-1 flex items-center gap-1 text-sm text-muted">账户 <RequiredStar /></label>
          <AccountPicker value={form.watch('accountId')} onChange={(id) => form.setValue('accountId', id)} />
        </div>

        {type === 'transfer' && (
          <div>
            <label className="mb-1 flex items-center gap-1 text-sm text-muted">转入账户 <RequiredStar /></label>
            <AccountPicker value={form.watch('toAccountId')} onChange={(id) => form.setValue('toAccountId', id)}
              exclude={form.watch('accountId') ? [form.watch('accountId')!] : []} />
          </div>
        )}

        <div>
          <label className="mb-1 flex items-center gap-1 text-sm text-muted">日期 <RequiredStar /></label>
          <Input type="date" value={form.watch('date')} onChange={(e) => form.setValue('date', e.target.value)} />
        </div>

        <div>
          <label className="mb-1 block text-sm text-muted">标签（可选，可多选）</label>
          <TagPicker value={form.watch('tagIds') ?? []} onChange={(ids) => form.setValue('tagIds', ids)} />
        </div>

        <div>
          <label className="mb-1 block text-sm text-muted">备注（可选）</label>
          <div className="flex items-start gap-2">
            <Textarea rows={2} placeholder="备注" value={form.watch('note')} onChange={(e) => form.setValue('note', e.target.value)} />
            <Button type="button" variant="outline" size="sm" onClick={runSuggest} disabled={suggesting} className="whitespace-nowrap">
              {suggesting ? '识别中…' : '智能归类'}
            </Button>
          </div>
          {suggest && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-black/2 p-2 text-xs dark:bg-white/5">
              <span className="text-muted">
                {suggest.source === 'ai' ? 'AI 推荐' : '本地推荐'}：
              </span>
              {suggest.categories.map((c) => (
                <button key={c.name} type="button" onClick={() => adoptCategory(c.name)}
                  className="rounded-full border border-[var(--color-primary)] px-2 py-0.5 text-[var(--color-primary-fg)] hover:bg-[var(--color-primary)]/10">
                  分类·{c.name}（{Math.round(c.score * 100)}%）
                  {classifyConfidence(c.score) === 'low' && <span className="ml-0.5 text-[10px]">·待核对</span>}
                </button>
              ))}
              {suggest.account && (
                <button key={suggest.account.id} type="button" onClick={() => adoptAccount(suggest.account!.name)}
                  className="rounded-full border border-[var(--border)] px-2 py-0.5 hover:bg-black/5 dark:hover:bg-white/5">
                  账户·{suggest.account.name}
                </button>
              )}
              {recMerchants.length > 0 && (
                <>
                  {recMerchants.map((m) => (
                    <button key={m} type="button" onClick={() => adoptMerchant(m)}
                      className="rounded-full border border-[var(--border)] px-2 py-0.5 hover:bg-black/5 dark:hover:bg-white/5">
                      商户·{m}
                    </button>
                  ))}
                </>
              )}
              {recTags.length > 0 && (
                <>
                  {recTags.map((id) => (
                    <button key={id} type="button" onClick={() => adoptTag(id)}
                      className="rounded-full border border-[var(--border)] px-2 py-0.5 hover:bg-black/5 dark:hover:bg-white/5">
                      标签·{tagNameMap[id] ?? `#${id}`}
                    </button>
                  ))}
                </>
              )}
              {!suggest.categories.length && !suggest.account && <span className="text-muted">未识别到匹配项，可手动选择</span>}
            </div>
          )}
        </div>

        {/* 交易扩展信息（支付时间/付款方式/收款方/订单号/商家订单号），可由 OCR/AI 解析自动回填 */}
        <div className="rounded-lg border border-[var(--border)] p-3">
          <div className="mb-2 text-xs font-medium text-muted">交易信息（可选）</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm text-muted">支付时间</label>
              <Input
                placeholder="如 2026-09-27 19:02:40"
                value={form.watch('payTime')}
                onChange={(e) => form.setValue('payTime', e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted">付款方式</label>
              <Input
                placeholder="如 微信支付、支付宝、银行卡"
                value={form.watch('payMethod')}
                onChange={(e) => form.setValue('payMethod', e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted">收款方全称</label>
              <Input
                placeholder="收款方 / 商户全称"
                value={form.watch('payee')}
                onChange={(e) => form.setValue('payee', e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1 text-sm text-muted">订单号 <RequiredStar /></label>
              <Input
                placeholder="订单号 / 交易单号"
                value={form.watch('orderNo')}
                onChange={(e) => form.setValue('orderNo', e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted">商家订单号</label>
              <Input
                placeholder="商家订单号（可选）"
                value={form.watch('merchantOrderNo')}
                onChange={(e) => form.setValue('merchantOrderNo', e.target.value)}
              />
            </div>
          </div>
        </div>

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? '保存中…' : '保存'}
        </Button>
      </form>

      {/* 拍照/票据 OCR 弹窗：识别结果回填本表单 */}
      <OcrModal open={ocrOpen} onClose={() => setOcrOpen(false)} onApply={applyOcrItem} onApplyMany={applyOcrBatch} />
    </Sheet>
  );
}

/** 记账页底部红/黄点预算强提醒条（仅提醒，不禁止记账） */
function BudgetHint({ usage }: { usage: BudgetUsage }) {
  const over = usage.status === 'over';
  const color = over ? 'var(--color-danger)' : 'var(--color-warning)';
  return (
    <div className="mt-1 flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
      style={{ color, borderColor: color, background: `${color}14` }}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      <span>{budgetWarnMessage(usage)}</span>
    </div>
  );
}

/** 必填项红色星号（用户需求：记一笔必填项以红色 * 标识） */
function RequiredStar() {
  return <span className="text-[var(--color-danger)]" title="必填">*</span>;
}