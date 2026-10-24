import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, TrendingUp, TrendingDown, Plus, Pencil, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, type SelectOption } from '@/components/ui/select';
import {
  getFinancialCheckup, type CheckupMetrics, type CheckupDiagnosisItem,
  type CashFlowKind, type DebtNature, type InsuranceKind, type InsurancePolicy,
  INSURANCE_KIND_LABELS,
} from '@/api/stats';
import { getInsurancePolicies, addInsurancePolicy, updateInsurancePolicy, deleteInsurancePolicy } from '@/api/insurance';
import { formatMoney } from '@/lib/format';

/** 指标/结论健康等级配色（亮暗主题通用） */
type Level = 'good' | 'warn' | 'risk' | 'none';
const LEVEL_COLOR: Record<Level, string> = {
  good: '#10B981',
  warn: '#F59E0B',
  risk: '#EF4444',
  none: '#94A3B8',
};

/** 横向占比条形：标签 + 金额（占比）+ 进度条 */
function RatioBar({ label, amount, ratio, color, count }: {
  label: string;
  amount: number;
  ratio: number | null;
  color: string;
  count?: number;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium text-[var(--fg)]">
          {label}
          {count !== undefined && <span className="ml-1 text-muted">{count} 笔</span>}
        </span>
        <span className="text-muted">
          {formatMoney(amount)}
          {ratio !== null && <span className="ml-1">（{(ratio * 100).toFixed(1)}%）</span>}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, (ratio ?? 0) * 100)}%`, background: color }} />
      </div>
    </div>
  );
}

/** 现金流三分元信息 */
const CASH_FLOW_META: { kind: CashFlowKind; label: string; color: string }[] = [
  { kind: 'operating', label: '经营性', color: '#3B82F6' },
  { kind: 'investing', label: '投资性', color: '#10B981' },
  { kind: 'financing', label: '融资性', color: '#F59E0B' },
];

/** 负债性质元信息 */
const NATURE_META: { kind: DebtNature; label: string; color: string }[] = [
  { kind: 'mortgage', label: '房贷', color: '#3B82F6' },
  { kind: 'auto', label: '车贷', color: '#8B5CF6' },
  { kind: 'consumer', label: '消费贷', color: '#EF4444' },
  { kind: 'business', label: '经营贷', color: '#F59E0B' },
  { kind: 'other', label: '其他', color: '#94A3B8' },
];

/** 收入三大类元信息 */
const INCOME_KIND_META: Record<string, { label: string; color: string }> = {
  labor: { label: '劳动收入', color: '#3B82F6' },
  capital: { label: '资本收入', color: '#10B981' },
  transfer: { label: '转移收入', color: '#F59E0B' },
};

/** 负债清偿状态配色（clear 无负债 / good 一年内还清 / slow 周期较长 / stuck 难以清偿） */
const PAYOFF_COLOR: Record<string, string> = {
  clear: LEVEL_COLOR.good,
  good: LEVEL_COLOR.good,
  slow: LEVEL_COLOR.warn,
  stuck: LEVEL_COLOR.risk,
};

/** 恩格尔系数分层：>0.6 贫困 / 0.5-0.6 温饱 / 0.4-0.5 小康 / <0.4 富裕 */
function engelLabel(c: number): string {
  return c > 0.6 ? '贫困水平' : c > 0.5 ? '温饱水平' : c > 0.4 ? '小康水平' : '富裕水平';
}

/** 险种元信息（页面展示用：标签 + 配色） */
const INSURANCE_KIND_META: { kind: InsuranceKind; label: string; color: string }[] = [
  { kind: 'life', label: INSURANCE_KIND_LABELS.life, color: '#3B82F6' },
  { kind: 'critical', label: INSURANCE_KIND_LABELS.critical, color: '#EF4444' },
  { kind: 'medical', label: INSURANCE_KIND_LABELS.medical, color: '#10B981' },
  { kind: 'accident', label: INSURANCE_KIND_LABELS.accident, color: '#F59E0B' },
];

/** 险种下拉选项（保单表单） */
const INSURANCE_KIND_OPTIONS: SelectOption[] = INSURANCE_KIND_META.map((m) => ({ value: m.kind, label: m.label }));

/**
 * 保单编辑弹窗（新增/编辑共用）。
 * key 由调用方按「弹窗打开状态 + 编辑对象」切换，保证每次打开时表单状态重置。
 */
function PolicyFormModal({ open, onClose, editing, onSave }: {
  open: boolean;
  onClose: () => void;
  editing: InsurancePolicy | null;
  onSave: (p: Omit<InsurancePolicy, 'id'>, editingId?: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<InsuranceKind>(editing?.kind ?? 'medical');
  const [name, setName] = useState(editing?.name ?? '');
  const [coverage, setCoverage] = useState(editing ? String(editing.coverage) : '');
  const [premium, setPremium] = useState(editing ? String(editing.annualPremium) : '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const covNum = Number(coverage);
  const valid = name.trim().length > 0 && covNum > 0 && Number(premium) >= 0;

  /** 提交保存：调用父级回调（新增或更新），成功后由父级关闭弹窗 */
  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    await onSave(
      { kind, name: name.trim(), coverage: covNum, annualPremium: Number(premium) || 0, note: note.trim() || undefined },
      editing?.id
    );
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? '编辑保单' : '添加保单'} guard={{ dirty, onSave: submit }}>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs text-muted">险种</label>
          <Select value={kind} onChange={(v) => { setKind(v); setDirty(true); }} options={INSURANCE_KIND_OPTIONS} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted">保单名称</label>
          <Input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} placeholder="如：XX重疾险（30 万保额）" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted">保额（元）</label>
            <Input type="number" min={0} value={coverage} onChange={(e) => { setCoverage(e.target.value); setDirty(true); }} placeholder="300000" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">年缴保费（元）</label>
            <Input type="number" min={0} value={premium} onChange={(e) => { setPremium(e.target.value); setDirty(true); }} placeholder="3000" />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted">备注（可选）</label>
          <Input value={note} onChange={(e) => { setNote(e.target.value); setDirty(true); }} placeholder="如：缴费至 60 岁 / 含身故责任" />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button disabled={!valid || saving} onClick={submit}>{editing ? '保存修改' : '添加保单'}</Button>
        </div>
        {!valid && <p className="text-xs text-muted">保单名称与保额必填（保额需大于 0）。</p>}
      </div>
    </Modal>
  );
}

/** 指标卡片：标题 + 主数值 + 单位 + 说明 + 健康色 */
function CheckupCard({ title, value, unit = '', hint, level }: {
  title: string;
  value: string;
  unit?: string;
  hint: string;
  level: Level;
}) {
  const color = LEVEL_COLOR[level];
  return (
    <Card className="p-5">
      <div className="text-sm text-muted">{title}</div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-2xl font-bold" style={{ color }}>{value}</span>
        {unit && <span className="text-xs text-muted">{unit}</span>}
      </div>
      <div className="mt-1.5 text-xs leading-relaxed text-muted">{hint}</div>
    </Card>
  );
}

/** 各指标的健康等级判定（与诊断结论口径一致） */
function metricLevel(m: CheckupMetrics): Record<string, Level> {
  return {
    income: m.totalIncome > 0 ? 'good' : 'none',
    labor: m.totalIncome > 0 ? (m.laborIncomeRatio >= 0.5 ? 'good' : 'warn') : 'none',
    sources: m.incomeSourceCount > 1 ? 'good' : m.incomeSourceCount === 1 ? 'warn' : 'none',
    debt: m.totalDebt <= 0.0001 ? 'good' : 'none',
    dsr: m.dsr === null ? 'none' : m.dsr > 0.43 ? 'risk' : m.dsr > 0.36 ? 'warn' : 'good',
    short: m.shortTermDebtRatio === null ? 'none' : m.shortTermDebtRatio > 0.8 ? 'risk' : m.shortTermDebtRatio > 0.5 ? 'warn' : 'good',
    save: m.netSavingRate < 0 ? 'risk' : m.netSavingRate < 0.1 ? 'warn' : m.totalIncome > 0 ? 'good' : 'none',
    liq: m.liquidityMonths === null ? 'none' : m.liquidityMonths < 1 ? 'risk' : m.liquidityMonths < 3 ? 'warn' : 'good',
  };
}

const DIAG_ICON = {
  good: CheckCircle2,
  warn: AlertTriangle,
  risk: XCircle,
};

/** 财务体检：按「家庭财务四张表」九项指标体检 + 同比 + 诊断结论 */
export default function FinancialCheckup() {
  const [ym, setYm] = useState(dayjs().format('YYYY-MM'));
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['stats', 'checkup', ym],
    queryFn: () => getFinancialCheckup(ym),
  });

  // 保单列表（保障覆盖配置）：页面直接读写 settings/kv，保存后需刷新体检数据重新计算覆盖率
  const [policies, setPolicies] = useState<InsurancePolicy[]>([]);
  const [policyModal, setPolicyModal] = useState<{ open: boolean; editing: InsurancePolicy | null }>({ open: false, editing: null });
  // 待删除保单（非空时弹出确认弹窗）
  const [deleteTarget, setDeleteTarget] = useState<InsurancePolicy | null>(null);

  // 进入页面时从本机设置载入保单列表
  useEffect(() => {
    setPolicies(getInsurancePolicies());
  }, []);

  /** 保存保单（新增/编辑）：落库成功后刷新本地列表与覆盖率 */
  const handleSavePolicy = async (p: Omit<InsurancePolicy, 'id'>, editingId?: string) => {
    const ok = editingId ? await updateInsurancePolicy(editingId, p) : await addInsurancePolicy(p);
    if (ok) {
      setPolicies(getInsurancePolicies());
      await queryClient.invalidateQueries({ queryKey: ['stats', 'checkup', ym] });
      // 关键位置日志：保单保存结果，便于排查覆盖率不刷新的问题
      // eslint-disable-next-line no-console
      console.log(`[checkup] 保单${editingId ? '更新' : '新增'}成功：`, p.name);
    }
    setPolicyModal({ open: false, editing: null });
  };

  /** 删除保单（由确认弹窗触发）：落库成功后刷新本地列表与覆盖率 */
  const handleDeletePolicy = async (id: string) => {
    const ok = await deleteInsurancePolicy(id);
    if (ok) {
      setPolicies(getInsurancePolicies());
      await queryClient.invalidateQueries({ queryKey: ['stats', 'checkup', ym] });
    }
    setDeleteTarget(null);
  };

  const m = data?.metrics;
  const diagnosis: CheckupDiagnosisItem[] = data?.diagnosis ?? [];
  const lastYear = data?.lastYearIncome ?? 0;
  const cf = data?.cashFlow;
  const ds = data?.debtStructure;
  const ic = data?.incomeConcentration;
  const dp = data?.debtPayoff;
  const ins = data?.insurance;
  const sp = data?.spendingStructure;
  const ng = data?.netAssetGrowth;
  const ef = data?.emergencyFund;
  // 支出总金额（刚性 + 可选 + 未分类），用于未分类占比
  const spTotal = sp ? sp.byNature.essential + sp.byNature.discretionary + sp.byNature.uncategorized : 0;

  // 总收入同比：较去年同期（无去年同期数据时不显示）
  const yoyPct = m && lastYear > 0 ? (m.totalIncome - lastYear) / lastYear : null;

  const lv = m ? metricLevel(m) : null;

  return (
    <div className="space-y-6">
      {/* 顶部：标题 + 月份选择 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">财务体检</h2>
          <p className="mt-1 text-sm text-muted">按「家庭财务四张表」十一项指标做年度体检，先看储蓄率，再看债务与流动性</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          体检月份
          <input
            type="month"
            value={ym}
            onChange={(e) => e.target.value && setYm(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm text-[var(--fg)] outline-none focus:border-[var(--color-primary)]"
          />
        </label>
      </div>

      {isLoading || !m ? (
        <div className="flex items-center justify-center py-24 text-sm text-muted">体检数据计算中…</div>
      ) : (
        <>
          {/* 收入同比总览 */}
          <Card className="p-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-sm text-muted">① 总收入（{data?.ym}）</div>
                <div className="mt-1 text-3xl font-bold" style={{ color: lv!.income === 'good' ? LEVEL_COLOR.good : LEVEL_COLOR.none }}>
                  {formatMoney(m.totalIncome)}
                </div>
              </div>
              {yoyPct !== null && (
                <div className={`flex items-center gap-1.5 text-sm font-medium ${yoyPct >= 0 ? 'text-[var(--color-primary)]' : 'text-[var(--color-danger)]'}`}>
                  {yoyPct >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
                  较去年同期 {formatMoney(lastYear)} 变化 {(yoyPct * 100).toFixed(1)}%
                </div>
              )}
            </div>
          </Card>

          {/* 九项指标卡片 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <CheckupCard
              title="② 劳动收入占比"
              value={m.totalIncome > 0 ? `${(m.laborIncomeRatio * 100).toFixed(1)}%` : '暂无数据'}
              hint="工资/奖金/兼职等主动劳动所得占收入比例，低于 50% 时注意收入稳定性"
              level={lv!.labor}
            />
            <CheckupCard
              title="③ 收入来源数量"
              value={`${m.incomeSourceCount}`}
              unit="个"
              hint="当月有收入的分类数量，来源越多元抗风险能力越强"
              level={lv!.sources}
            />
            <CheckupCard
              title="④ 总负债"
              value={formatMoney(m.totalDebt)}
              hint="借入且未结清的剩余本金合计（借出不计入负债）"
              level={lv!.debt}
            />
            <CheckupCard
              title="⑤ 债务收入比"
              value={m.dsr !== null ? `${(m.dsr * 100).toFixed(1)}%` : '无法估算'}
              hint="估算月供 ÷ 月均收入；参考线 36%，警戒线 43%"
              level={lv!.dsr}
            />
            <CheckupCard
              title="⑥ 短期负债占比"
              value={m.shortTermDebtRatio !== null ? `${(m.shortTermDebtRatio * 100).toFixed(1)}%` : '暂无数据'}
              hint="剩余期数 ≤ 12 期或剩余期限 ≤ 1 年的负债占总负债比例"
              level={lv!.short}
            />
            <CheckupCard
              title="⑦ 净储蓄率"
              value={m.totalIncome > 0 ? `${(m.netSavingRate * 100).toFixed(1)}%` : '暂无数据'}
              hint="（收入 − 支出）÷ 收入；建议不低于 10%，为负说明入不敷出"
              level={lv!.save}
            />
            <CheckupCard
              title="⑧ 流动性覆盖月数"
              value={m.liquidityMonths !== null ? m.liquidityMonths.toFixed(1) : '暂无数据'}
              unit="个月"
              hint="流动资产（现金/银行/电子钱包）÷ 近 6 个月月均支出；建议 3-6 个月"
              level={lv!.liq}
            />
            <CheckupCard
              title="⑨ 保障覆盖率"
              value={m.insuranceCoverage !== null ? `${(m.insuranceCoverage * 100).toFixed(1)}%` : '暂无数据'}
              hint="责任缺口法：Σ已配置保额 ÷ Σ建议保额（寿险/意外=年收入×10、重疾=年收入×5、医疗=100万）；可在下方保障覆盖区录入保单"
              level={ins?.level ?? 'none'}
            />
            <CheckupCard
              title="⑩ 净资产成长率"
              value={ng?.growthRate !== null && ng?.growthRate !== undefined ? `${(ng.growthRate >= 0 ? '+' : '')}${(ng.growthRate * 100).toFixed(1)}%` : ng && ng.currentNet < 0 ? '净资产为负' : '暂无数据'}
              hint="净资产（总资产 − 总负债）较参考时点的变化率；参考时点优先去年同期，记账不足一年时按最早记录估算"
              level={ng?.level ?? 'none'}
            />
            <CheckupCard
              title="⑪ 应急储备进度"
              value={ef?.progress !== null && ef?.progress !== undefined ? `${(ef.progress * 100).toFixed(1)}%` : '暂无数据'}
              hint={`流动资产 ÷ ${ef?.targetMonths ?? 6} 个月目标储备金额；可覆盖 ${ef?.coverageMonths !== null && ef?.coverageMonths !== undefined ? ef.coverageMonths.toFixed(1) : '—'} 个月开销，缺口 ${formatMoney(ef?.shortfall ?? 0)}`}
              level={ef?.level ?? 'none'}
            />
          </div>

          {/* 现金流三分 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">现金流三分</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-4 gap-2 text-xs text-muted">
                <span>活动</span>
                <span className="text-right">流入（收入）</span>
                <span className="text-right">流出（支出）</span>
                <span className="text-right">净额</span>
              </div>
              {CASH_FLOW_META.map(({ kind, label, color }) => {
                const net = cf?.net[kind] ?? 0;
                return (
                  <div key={kind} className="grid grid-cols-4 items-center gap-2 text-sm">
                    <span className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                      {label}
                    </span>
                    <span className="text-right">{formatMoney(cf?.income[kind] ?? 0)}</span>
                    <span className="text-right">{formatMoney(cf?.expense[kind] ?? 0)}</span>
                    <span className={`text-right font-medium ${net >= 0 ? 'text-[var(--color-primary)]' : 'text-[var(--color-danger)]'}`}>
                      {net >= 0 ? '+' : ''}{formatMoney(net)}
                    </span>
                  </div>
                );
              })}
              <p className="text-xs text-muted">经营性净额反映日常收支结余；投资性含理财/利息等资本活动；融资性主要由借贷/还款类交易体现，转账不计入。</p>
            </CardContent>
          </Card>

          {/* 负债结构：性质分类 + 还款到期分布 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">负债结构</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-3">
                <div className="text-xs font-medium text-muted">负债性质（按借贷对象/备注识别）</div>
                {NATURE_META.map(({ kind, label, color }) => {
                  const natureTotal = Object.values(ds?.nature ?? {}).reduce((a, b) => a + b, 0);
                  return (
                    <RatioBar
                      key={kind}
                      label={label}
                      amount={ds?.nature[kind] ?? 0}
                      ratio={natureTotal > 0 ? (ds?.nature[kind] ?? 0) / natureTotal : null}
                      color={color}
                    />
                  );
                })}
                <p className="text-xs text-muted">消费贷通常利率较高，建议优先清偿；识别不到的借贷归入「其他」。</p>
              </div>
              <div className="space-y-3">
                <div className="text-xs font-medium text-muted">还款到期分布（剩余期限）</div>
                {(ds?.maturity ?? []).map((b) => (
                  <RatioBar
                    key={b.label}
                    label={b.label}
                    amount={b.total}
                    ratio={b.ratio}
                    color={b.label === '12个月内' ? '#EF4444' : b.label === '1-3年' ? '#F59E0B' : '#3B82F6'}
                    count={b.count}
                  />
                ))}
                <p className="text-xs text-muted">12 个月内到期的短期还款压力最大，需预留足够流动性。</p>
              </div>
            </CardContent>
          </Card>

          {/* 负债清偿周期：总负债 / 估算月供 / 月均结余 / 预计还清 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                <span>负债清偿周期</span>
                <span className="text-sm font-normal" style={{ color: PAYOFF_COLOR[dp?.status ?? 'clear'] }}>
                  {dp?.status === 'stuck' ? '难以清偿' : dp?.status === 'slow' ? '周期较长' : dp?.status === 'good' ? '一年内可还清' : dp?.status === 'clear' ? '无负债' : '—'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="text-xs text-muted">负债总额</div>
                <div className="mt-1 text-lg font-bold">{formatMoney(dp?.totalDebt ?? 0)}</div>
              </div>
              <div>
                <div className="text-xs text-muted">估算月供</div>
                <div className="mt-1 text-lg font-bold">{dp && dp.monthlyPayment > 0 ? formatMoney(dp.monthlyPayment) : '—'}</div>
              </div>
              <div>
                <div className="text-xs text-muted">月均结余</div>
                <div className={`mt-1 text-lg font-bold ${(dp?.monthlySurplus ?? 0) < 0 ? 'text-[var(--color-danger)]' : ''}`}>{formatMoney(dp?.monthlySurplus ?? 0)}</div>
              </div>
              <div>
                <div className="text-xs text-muted">预计还清</div>
                <div className="mt-1 text-lg font-bold">
                  {dp?.payoffMonths !== null && dp?.payoffMonths !== undefined
                    ? dp.payoffMonths === 0 ? '—' : `${dp.payoffMonths} 个月`
                    : '难以估算'}
                </div>
                {dp?.payoffDate && dp.payoffMonths !== 0 && <div className="mt-0.5 text-xs text-muted">约 {dp.payoffDate}</div>}
              </div>
            </CardContent>
            {dp?.status === 'stuck' && (
              <CardContent className="pt-0">
                <p className="text-xs text-muted">按当前节奏，月均结余不足以覆盖估算月供，负债会持续累积；建议先提高结余或优化债务结构。</p>
              </CardContent>
            )}
          </Card>

          {/* 收入集中度 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                <span>收入集中度</span>
                <span className="text-sm font-normal text-muted">集中度指数 {(ic?.hhi ?? 0).toFixed(2)}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium" style={{ color: LEVEL_COLOR[ic?.level ?? 'none'] }}>
                {ic?.level === 'risk' ? '收入高度集中于单一类别' : ic?.level === 'warn' ? '收入集中度偏高' : '收入来源分布均衡'}
                {m.totalIncome > 0 && <span className="text-xs font-normal text-muted">（最大类别占比 {((ic?.maxRatio ?? 0) * 100).toFixed(1)}%）</span>}
              </div>
              {(ic?.shares ?? []).map((s) => (
                <RatioBar
                  key={s.kind}
                  label={INCOME_KIND_META[s.kind]?.label ?? s.kind}
                  amount={s.total}
                  ratio={s.ratio}
                  color={INCOME_KIND_META[s.kind]?.color ?? '#94A3B8'}
                />
              ))}
              <p className="text-xs text-muted">劳动/资本/转移三大类占比；单一类别超 70% 预警。集中度指数（赫芬达尔）越接近 1 越依赖单一收入来源。</p>
            </CardContent>
          </Card>

          {/* 支出结构体检：刚性 / 可选 / 恩格尔系数 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                <span>支出结构体检</span>
                {sp?.engelCoefficient !== null && sp?.engelCoefficient !== undefined && (
                  <span className="text-sm font-normal text-muted">
                    恩格尔系数 {(sp.engelCoefficient * 100).toFixed(1)}%（{engelLabel(sp.engelCoefficient)}）
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <RatioBar label="刚性支出" amount={sp?.byNature.essential ?? 0} ratio={sp?.essentialRatio ?? null} color="#3B82F6" />
                <RatioBar label="可选支出" amount={sp?.byNature.discretionary ?? 0} ratio={sp?.discretionaryRatio ?? null} color="#F59E0B" />
                <RatioBar
                  label="未分类"
                  amount={sp?.byNature.uncategorized ?? 0}
                  ratio={spTotal > 0 ? (sp?.byNature.uncategorized ?? 0) / spTotal : null}
                  color="#94A3B8"
                />
              </div>
              <p className="text-xs text-muted">刚性支出 = 住房/餐饮/通勤/通讯/医疗/教育/保险等生活必需；恩格尔系数为食品支出占总支出比例，&gt;0.5 说明支出主要满足基本生活。分类按名称关键词识别，未命中归「未分类」，可调整分类名改进识别。</p>
            </CardContent>
          </Card>

          {/* 净资产成长性：当前净资产 / 参考时点 / 成长率 / 数据覆盖 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                <span>净资产成长性</span>
                <span className="text-sm font-normal" style={{ color: LEVEL_COLOR[ng?.level ?? 'none'] }}>
                  {ng?.level === 'risk' ? '净资产为负' : ng?.level === 'warn' ? '较参考时点缩水' : ng?.level === 'good' ? '稳步增长' : '暂无数据'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="text-xs text-muted">当前净资产</div>
                <div className={`mt-1 text-lg font-bold ${(ng?.currentNet ?? 0) < 0 ? 'text-[var(--color-danger)]' : ''}`}>{formatMoney(ng?.currentNet ?? 0)}</div>
                <div className="mt-0.5 text-xs text-muted">总资产（含持仓市值）− 总负债</div>
              </div>
              <div>
                <div className="text-xs text-muted">参考时点净资产</div>
                <div className="mt-1 text-lg font-bold">{ng && ng.monthsCovered > 0 ? formatMoney(ng.baseNet) : '—'}</div>
                {ng && ng.baseMonth && <div className="mt-0.5 text-xs text-muted">{ng.baseMonth}</div>}
              </div>
              <div>
                <div className="text-xs text-muted">成长率</div>
                <div className={`mt-1 text-lg font-bold ${(ng?.growthRate ?? 0) < 0 ? 'text-[var(--color-danger)]' : (ng?.growthRate ?? 0) > 0 ? 'text-[var(--color-primary)]' : ''}`}>
                  {ng?.growthRate !== null && ng?.growthRate !== undefined ? `${ng.growthRate >= 0 ? '+' : ''}${(ng.growthRate * 100).toFixed(1)}%` : '—'}
                </div>
                <div className="mt-0.5 text-xs text-muted">较参考时点变化</div>
              </div>
              <div>
                <div className="text-xs text-muted">数据覆盖</div>
                <div className="mt-1 text-lg font-bold">{ng && ng.monthsCovered > 0 ? `${ng.monthsCovered} 个月` : '—'}</div>
                <div className="mt-0.5 text-xs text-muted">参考时点到当前</div>
              </div>
            </CardContent>
            <CardContent className="pt-0">
              <p className="text-xs text-muted">
                {ng && ng.monthsCovered > 0 && ng.monthsCovered < 12
                  ? `记账数据不足 12 个月，参考时点取最早记录（${ng.baseMonth}），成长率按已有记录估算，会随记账完善而趋准。`
                  : '净资产 = 总资产（含持仓市值）− 总负债；成长率 =（当前净资产 ÷ 参考时点净资产）− 1，参考时点优先去年同期，衡量家庭财富积累速度；净资产为负或参考值约等于 0 时无法估算。'}
              </p>
            </CardContent>
          </Card>

          {/* 应急储备达成进度：流动资产 / 目标金额 / 覆盖月数 / 进度条与缺口 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                <span>应急储备达成进度</span>
                <span className="text-sm font-normal" style={{ color: LEVEL_COLOR[ef?.level ?? 'none'] }}>
                  {ef?.level === 'good' ? '目标已达成' : ef?.level === 'warn' ? '储备过半' : ef?.level === 'risk' ? '缺口较大' : '暂无数据'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <div className="text-xs text-muted">流动资产</div>
                  <div className="mt-1 text-lg font-bold">{formatMoney(ef?.liquidAssets ?? 0)}</div>
                  <div className="mt-0.5 text-xs text-muted">现金/银行/电子钱包</div>
                </div>
                <div>
                  <div className="text-xs text-muted">目标储备（{ef?.targetMonths ?? 6} 个月开销）</div>
                  <div className="mt-1 text-lg font-bold">{ef && ef.targetAmount > 0 ? formatMoney(ef.targetAmount) : '—'}</div>
                  <div className="mt-0.5 text-xs text-muted">近 6 个月月均支出 × {ef?.targetMonths ?? 6}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">当前可覆盖</div>
                  <div className="mt-1 text-lg font-bold">{ef?.coverageMonths !== null && ef?.coverageMonths !== undefined ? `${ef.coverageMonths.toFixed(1)} 个月` : '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">达成缺口</div>
                  <div className={`mt-1 text-lg font-bold ${(ef?.shortfall ?? 0) > 0 ? 'text-[var(--color-danger)]' : ''}`}>{ef && ef.shortfall > 0 ? formatMoney(ef.shortfall) : ef?.progress === null || ef?.progress === undefined ? '—' : '已达标'}</div>
                </div>
              </div>
              <RatioBar
                label="达成进度"
                amount={ef?.liquidAssets ?? 0}
                ratio={ef?.progress ?? null}
                color={ef?.level === 'good' ? '#10B981' : ef?.level === 'warn' ? '#F59E0B' : ef?.level === 'risk' ? '#EF4444' : '#94A3B8'}
              />
              <p className="text-xs text-muted">目标 = 近 6 个月月均支出 × {ef?.targetMonths ?? 6} 个月；进度 = 流动资产 ÷ 目标金额，≥100% 达标、50%-100% 过半、&lt;50% 缺口较大。与「⑧ 流动性覆盖月数」互补：覆盖月数看能撑几个月，本指标看距离 6 个月目标还差多少钱。</p>
            </CardContent>
          </Card>

          {/* 保障覆盖（人力资本） */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                <span>保障覆盖</span>
                <Button size="sm" variant="outline" onClick={() => setPolicyModal({ open: true, editing: null })}>
                  <Plus size={14} /> 添加保单
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* 综合覆盖率总览 */}
              <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border p-4">
                <div>
                  <div className="text-xs text-muted">综合保障覆盖率（责任缺口法）</div>
                  <div className="mt-1 text-2xl font-bold" style={{ color: LEVEL_COLOR[ins?.level ?? 'none'] }}>
                    {ins?.totalRatio !== null && ins?.totalRatio !== undefined ? `${(ins.totalRatio * 100).toFixed(1)}%` : '暂无数据'}
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {ins && ins.annualIncome > 0
                      ? `年收入基线 ${formatMoney(ins.annualIncome)}，建议保额合计 ${formatMoney(ins.suggested.life + ins.suggested.critical + ins.suggested.medical + ins.suggested.accident)}`
                      : '需先有近 12 个月收入记录才能估算建议保额'}
                  </div>
                </div>
                <div className="text-right text-xs text-muted">
                  {ins?.policyCount ?? 0} 份保单 · 年缴保费 {formatMoney(ins?.totalPremium ?? 0)}
                </div>
              </div>
              {/* 各险种覆盖情况 */}
              <div className="space-y-3">
                <div className="text-xs font-medium text-muted">各险种覆盖情况（已配置 / 建议保额）</div>
                {INSURANCE_KIND_META.map(({ kind, label, color }) => {
                  const cov = ins?.covered[kind] ?? 0;
                  const sug = ins?.suggested[kind] ?? 0;
                  return (
                    <RatioBar
                      key={kind}
                      label={label}
                      amount={cov}
                      ratio={sug > 0 ? cov / sug : null}
                      color={color}
                    />
                  );
                })}
              </div>
              {/* 保单列表 */}
              <div className="space-y-2">
                {policies.length === 0 ? (
                  <p className="text-xs text-muted">尚未录入保单，点击「添加保单」录入寿险/重疾/医疗/意外保障后自动计算覆盖率。</p>
                ) : (
                  policies.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <span className="font-medium">{p.name}</span>
                        <span className="ml-2 text-xs text-muted">{INSURANCE_KIND_LABELS[p.kind]}</span>
                        <span className="ml-2 text-xs text-muted">保额 {formatMoney(p.coverage)} · 年缴 {formatMoney(p.annualPremium)}</span>
                        {p.note && <span className="ml-2 text-xs text-muted">（{p.note}）</span>}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/5" title="编辑" onClick={() => setPolicyModal({ open: true, editing: p })}>
                          <Pencil size={14} />
                        </button>
                        <button className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/5" title="删除" onClick={() => setDeleteTarget(p)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <p className="text-xs text-muted">建议保额按责任缺口法估算：寿险/意外 = 年收入 × 10，重疾 = 年收入 × 5，医疗 = 100 万；同险种多份保单保额可累加。</p>
            </CardContent>
          </Card>

          {/* 保单编辑弹窗：key 随打开状态 + 编辑对象切换，保证每次打开表单重置 */}
          <PolicyFormModal
            key={policyModal.open ? (policyModal.editing?.id ?? 'new') : 'closed'}
            open={policyModal.open}
            editing={policyModal.editing}
            onClose={() => setPolicyModal({ open: false, editing: null })}
            onSave={handleSavePolicy}
          />

          {/* 删除保单确认弹窗 */}
          <Modal open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="删除保单">
            <div className="space-y-4">
              <p className="text-sm text-[var(--fg)]">
                确定删除保单「{deleteTarget?.name}」吗？删除后综合保障覆盖率将立即重新计算。
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDeleteTarget(null)}>取消</Button>
                <Button variant="danger" onClick={() => deleteTarget && handleDeletePolicy(deleteTarget.id)}>删除</Button>
              </div>
            </div>
          </Modal>

          {/* 诊断结论 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">体检结论</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {diagnosis.length === 0 ? (
                <div className="text-sm text-muted">当前月份尚无收支记录，记入收支与借贷后可自动生成体检结论。</div>
              ) : (
                diagnosis.map((d, i) => {
                  const Icon = DIAG_ICON[d.level];
                  const color = LEVEL_COLOR[d.level];
                  return (
                    <div key={i} className="flex items-start gap-3 rounded-lg border px-4 py-3" style={{ borderColor: `color-mix(in srgb, ${color} 35%, transparent)`, background: `color-mix(in srgb, ${color} 8%, transparent)` }}>
                      <Icon size={18} className="mt-0.5 shrink-0" style={{ color }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium" style={{ color }}>{d.title}</div>
                        <div className="mt-0.5 text-xs leading-relaxed text-muted">{d.detail}</div>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          {/* 口径说明 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">口径说明</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-xs leading-relaxed text-muted">
              <p>· 收入类指标按「体检月份」统计；债务收入比分母取近 12 个月有收入月份的平均值，流动性分母取近 6 个月有支出月份的平均值。</p>
              <p>· 总负债 = 借入且未结清的剩余本金；月供估算：分期贷款按剩余本金 ÷ 剩余期数，到期一次按剩余本金 ÷ 剩余月数折算；既无期数也无到期日的借贷无法估算月供。</p>
              <p>· 短期负债 = 剩余期数 ≤ 12 期或剩余期限 ≤ 1 年的借入负债；到期分布按剩余期限分「12 个月内 / 1-3 年 / 3 年以上」三桶，无法估算归「期限未知」。</p>
              <p>· 现金流三分：按收支分类名映射为经营性/投资性/融资性；转账不产生现金流不计入，融资性主要由借贷/还款类交易体现。</p>
              <p>· 负债性质按借贷对象与备注关键词识别（房贷/车贷/消费贷/经营贷），未命中归「其他」，可手动调整借贷备注以改进识别。</p>
              <p>· 支出结构体检：按分类名把当月支出映射为刚性（住房/餐饮/通勤/通讯/医疗/教育/保险等必需）与可选（娱乐/旅行/购物/游戏等非必需），未命中归「未分类」；恩格尔系数 = 食品餐饮类支出 ÷ 总支出，&gt;0.6 贫困、0.5-0.6 温饱、0.4-0.5 小康、&lt;0.4 富裕。</p>
              <p>· 负债清偿周期：按「月均结余（近 12 个月月均收入 − 近 6 个月月均支出）全部用于还债」估算还清全部借入负债所需月数，忽略利息；结余不足以覆盖估算月供或无结余时视为难以清偿。无期数且无到期日的借贷不参与月供合计。</p>
              <p>· 收入集中度：收入分劳动/资本/转移三大类，单一类别超 70% 预警；集中度指数为赫芬达尔指数（各占比平方和）。</p>
              <p>· 净资产成长性：净资产 = 总资产（含持仓市值）− 总负债；成长率 =（当前净资产 ÷ 参考时点净资产）− 1，参考时点优先去年同期月份，记账不足 12 个月时按最早记录估算，会随记账完善而趋准；净资产为负或参考值约等于 0 时无法估算。</p>
              <p>· 应急储备达成进度：目标 = 近 6 个月月均支出 × 6 个月；进度 = 流动资产 ÷ 目标金额，≥100% 达标、50%-100% 过半、&lt;50% 缺口较大；缺口 = max(0, 目标 − 流动资产)。与「⑧ 流动性覆盖月数」互补：覆盖月数看能撑几个月，本指标看距离 6 个月目标还差多少钱；近 6 个月无支出记录时无法估算。</p>
              <p>· 保障覆盖率（人力资本）：责任缺口法，建议保额 = 寿险/意外 年收入×10、重疾 年收入×5、医疗 100 万；综合覆盖率 = Σ已配置保额 ÷ Σ建议保额；年收入基线取近 12 个月有收入月份月均收入 × 12，保单保存在本机设置中。记账数据不足 12 个月时基线按已有月份平均估算，覆盖率会暂时偏低，属正常现象。</p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
