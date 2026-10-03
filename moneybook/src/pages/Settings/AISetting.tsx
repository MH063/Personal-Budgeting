import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAIStore } from '@/stores/useAIStore';
import { validateConfigWith, loadAiUsage, type AiUsageStat } from '@/api/llm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Modal } from '@/components/ui/modal';
import { Hint } from '@/components/ui/hint';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { maskKey } from '@/api/encrypt';
import { openInAppBrowser } from '@/lib/browser';
import {
  fetchModels,
  getPreset,
  getBaseUrlVariants,
  detectProviderId,
  PROVIDER_PRESETS,
  type ProviderConfig,
  type ProviderPreset,
} from '@/api/providers';
import {
  isDeepSeekHost,
  fetchBalance,
  type DeepSeekBalance,
} from '@/api/deepseek';

const presetOptions: SelectOption[] = PROVIDER_PRESETS.map((p) => ({
  value: p.id,
  label: p.name,
}));

function StatusDot({ status }: { status: ProviderConfig['status'] }) {
  if (status === 'testing') {
    return <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" title="正在测试" />;
  }
  const color = status === 'ok' ? 'var(--color-success)' : status === 'error' ? '#ef4444' : 'var(--muted)';
  const label = status === 'ok' ? '配置成功' : status === 'error' ? '测试失败' : '未配置';
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} title={label} />;
}

/**
 * Key 指纹：仅用于「测试结果 ↔ 表单」的绑定比对。
 * 不含完整 Key（只取长度与首尾字符），避免敏感串进入任何中间字符串。
 */
function keyFingerprint(k: string): string {
  if (!k) return '';
  return `${k.length}:${k.slice(0, 2)}…${k.slice(-2)}`;
}

/**
 * 模型列表拉取结果的提示文案与样式级别。
 * 区分三类场景：实时拉取成功（无提示）/ 回退官方固定清单（warn，注明"非实时获取"）/
 * 未获取到模型（error；自定义接口地址下官方清单不适用，引导手动填写模型名）。
 */
function describeModelFetch(
  list: string[],
  fallback: boolean | undefined,
  customUrl: boolean
): { text: string; kind: 'warn' | 'error' } {
  if (!list.length) {
    return {
      text: customUrl
        ? '未获取到模型列表：当前为自定义接口地址，官方清单不适用，请手动填写模型名。'
        : '未获取到可用模型，请检查接口地址与 Key，或手动填写模型名。',
      kind: 'error',
    };
  }
  if (fallback) {
    return {
      text: customUrl
        ? '实时拉取失败：下方为官方固定清单（非实时获取），自定义接口地址下可能不适用，请以手动填写的模型名为准。'
        : '实时拉取失败，已回退展示官方固定清单（非实时获取）；也可手动输入清单外的模型名。',
      kind: 'warn',
    };
  }
  return { text: '', kind: 'warn' };
}

export default function AISetting() {
  const enabled = useAIStore((s) => s.enabled);
  const allowDetail = useAIStore((s) => s.allowDetail);
  const providers = useAIStore((s) => s.providers);
  const activeProviderId = useAIStore((s) => s.activeProviderId);
  const setEnabled = useAIStore((s) => s.setEnabled);
  const setAllowDetail = useAIStore((s) => s.setAllowDetail);
  const addProvider = useAIStore((s) => s.addProvider);
  const updateProvider = useAIStore((s) => s.updateProvider);
  const removeProvider = useAIStore((s) => s.removeProvider);
  const setActiveProvider = useAIStore((s) => s.setActiveProvider);
  const temperature = useAIStore((s) => s.temperature);
  const topP = useAIStore((s) => s.topP);
  const maxTokens = useAIStore((s) => s.maxTokens);
  const setAiParams = useAIStore((s) => s.setAiParams);
  const reset = useAIStore((s) => s.reset);
  // 「重置全部 AI 配置」二次确认：将清除本机全部 AI 凭证/Key，不可恢复
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  // 「关闭编辑弹窗时存在未保存修改」的拦截确认（保存并关闭 / 不保存并关闭 / 继续编辑）
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  // ---- 编辑表单状态 ----
  const [selId, setSelId] = useState<string | null>(activeProviderId || providers[0]?.id || null);
  const [presetId, setPresetId] = useState('deepseek');
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelMsg, setModelMsg] = useState('');
  // 提示级别：warn=回退固定清单等非致命提示（橙）；error=获取失败（红）
  const [modelMsgKind, setModelMsgKind] = useState<'warn' | 'error'>('warn');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [errors, setErrors] = useState<{ baseURL?: string; apiKey?: string }>({});
  /**
   * 「测试连接」的即时结果（只测不写入：不落库、不改凭证状态）。
   * sig 把结果绑定到「当时那份表单」，表单任一连接字段变动后旧结果自动失效；
   * 点「保存」时若签名仍匹配且测试通过，则把「连接成功」一并带入保存。
   */
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string; sig: string } | null>(null);

  // 新增提供商时选择的预设
  const [addPresetId, setAddPresetId] = useState('deepseek');

  // 编辑表单是否以弹窗展示（用户要求：添加/编辑凭证不得扩展整个设置页面，必须以弹窗呈现）
  const [editOpen, setEditOpen] = useState(false);

  // 记录“进入编辑”时的真实 Key 与密文，用于保存时判断是否被用户修改
  const originalKeyRef = useRef<{ id: string; key: string; enc: string }>({ id: '', key: '', enc: '' });
  /**
   * 「新增后尚未保存过」的草稿凭证 id（历史 Bug 修复）。
   * 由来：新增凭证会先落库以获得弹窗内的可编辑实体；若用户随后选择「不保存并关闭」，
   * 这条未配置的空壳会残留在凭证目录（多模型切换）里——用户明确反馈过此问题。
   * 口径：点新增时记录 id；点「保存」成功后清除；关闭弹窗（未保存路径）时统一清理。
   */
  const pendingDraftIdRef = useRef<string | null>(null);

  const sel = providers.find((p) => p.id === selId) ?? null;
  const preset: ProviderPreset | undefined = getPreset(presetId);
  const needKey = !!(preset && preset.authHeaderPrefix);
  /**
   * 真正生效的凭证 id：显式激活指针优先，未显式选择时回退到目录中最早创建的一条
   * （与 readAIConfig 的取值口径完全一致）。余额面板、知识库、凭证「当前」标签
   * 都以它为准，避免「指针为空时界面无法说明哪条在生效」。
   */
  const effectiveActiveId = activeProviderId || providers[0]?.id || '';

  // ---- 服务商变体 base_url 计算 ----
  const baseUrlVariants = getBaseUrlVariants(preset);
  const variantOptions: SelectOption[] = baseUrlVariants.map((v) => ({ value: v.url, label: v.label }));
  const activeVariant = baseUrlVariants.find((v) => baseURL.trim() === v.url);
  // 反向识别当前 base_url 归属；偏离所选服务商或无法识别时给出轻提示
  const detectedProviderId = detectProviderId(baseURL);
  const deviatedFromPreset = detectedProviderId !== null && presetId !== 'unknown' && detectedProviderId !== presetId;
  const isCustomUrl = presetId === 'unknown' || detectedProviderId === null;

  // 维持 selId 有效
  useEffect(() => {
    if (providers.length === 0) {
      setSelId(null);
      return;
    }
    if (!selId || !providers.find((p) => p.id === selId)) setSelId(providers[0].id);
  }, [providers, selId]);

  // 切换编辑对象 → 加载表单
  useEffect(() => {
    const p = providers.find((x) => x.id === selId);
    if (!p) return;
    const pre = getPreset(p.providerId) ?? PROVIDER_PRESETS[0];
    originalKeyRef.current = { id: p.id, key: p.apiKey ?? '', enc: p.apiKeyEnc ?? '' };
    const initMasked = p.apiKey ? maskKey(p.apiKey) : '';
    setPresetId(presetIdStillValid(p.providerId) ? p.providerId : pre.id);
    setBaseURL(p.baseURL);
    setDisplayNameInput(p.displayName || p.name || '');
    setApiKeyInput(initMasked);
    setModel(p.model);
    setModels([]);
    setModelMsg('');
    setErrors({});
  }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps

  function presetIdStillValid(pid: string): boolean {
    return !!getPreset(pid);
  }

  // 实际用于请求/保存的 Key（未被用户改动时回退到已保存的真实 Key）
  function effectiveKey(): string {
    const orig = originalKeyRef.current;
    if (orig.id === selId) {
      const initMasked = orig.key ? maskKey(orig.key) : '';
      if (apiKeyInput === '' || (initMasked && apiKeyInput === initMasked)) return orig.key;
    }
    return apiKeyInput;
  }

  /** 「测试结果 ↔ 表单」绑定签名：覆盖全部连接关键字段，任一变动旧结果即失效 */
  function currentTestSig(): string {
    return `${presetId}|${baseURL.trim()}|${model || preset?.defaultModel || ''}|${keyFingerprint(effectiveKey())}`;
  }

  /** 表单校验（「测试连接」与「保存」共用同一口径，避免两处规则不一致） */
  function validateForm(): { errs: { baseURL?: string; apiKey?: string }; eff: string } {
    const errs: { baseURL?: string; apiKey?: string } = {};
    if (!/^https?:\/\/.*/.test(baseURL.trim())) errs.baseURL = 'Base URL 需以 http:// 或 https:// 开头';
    const eff = effectiveKey();
    if (needKey && !(eff.length > 10)) errs.apiKey = 'API Key 需超过 10 个字符';
    return { errs, eff };
  }

  /**
   * 编辑表单是否存在未保存的修改。
   * 判定口径与 onSave 实际写入的字段一致（显示名/服务商/地址/模型/Key），
   * 仅用于关闭弹窗前的误丢数据拦截，不参与保存逻辑。
   */
  function isEditDirty(): boolean {
    if (!sel) return false;
    const orig = originalKeyRef.current;
    const nextModel = model || preset?.defaultModel || '';
    const nextDisplayName = (displayNameInput.trim() || preset?.name) ?? '自定义凭证';
    const initMasked = orig.key ? maskKey(orig.key) : '';
    const keyChanged = !(apiKeyInput === '' || (initMasked && apiKeyInput === initMasked));
    return (
      (sel.displayName || sel.name || '') !== nextDisplayName ||
      sel.providerId !== presetId ||
      sel.baseURL !== baseURL.trim() ||
      sel.model !== nextModel ||
      keyChanged
    );
  }

  /**
   * 放弃「新增后从未保存」的草稿凭证（历史 Bug 修复）。
   * 用户点「不保存并关闭」时，弹窗里的修改不保留；同理，新增时落库的初始空壳也不应保留。
   * 若本次弹窗期间点过「保存」，ref 已被清除，这里不做任何处理。
   * 删除受 store 的「生效凭证保护」约束：若该条已成为当前使用且存在其它凭证，
   * removeProvider 会拒绝（返回 false），此时保留不删（提示用户可手动删除）。
   */
  function discardDraftIfNeeded() {
    const draftId = pendingDraftIdRef.current;
    if (!draftId) return;
    pendingDraftIdRef.current = null;
    if (removeProvider(draftId)) toast.success('已放弃未保存的凭证');
  }

  /** 关闭编辑弹窗入口：有未保存修改时先弹确认，避免「误点关闭 → 表单内容丢失」 */
  function requestCloseEdit() {
    if (isEditDirty()) {
      setCloseConfirmOpen(true);
      return;
    }
    // 新增后未填任何内容即关闭：清掉落库的初始空壳，目录不残留
    discardDraftIfNeeded();
    setEditOpen(false);
  }

  // 模型列表：字段变化时 [500ms 防抖] 自动拉取
  useEffect(() => {
    if (!preset) return;
    const baseOk = /^https?:\/\/.+/.test(baseURL.trim());
    const keyOk = !needKey || effectiveKey().length > 10;
    if (!baseOk || !keyOk) {
      setModels([]);
      setModelMsg('');
      return;
    }
    setLoadingModels(true);
    setModelMsg('');
    const t = setTimeout(async () => {
      try {
        const { models: list, fallback } = await fetchModels(baseURL.trim(), needKey ? effectiveKey() : '', preset);
        const msg = describeModelFetch(list, fallback, isCustomUrl);
        setModels(list);
        setModelMsg(msg.text);
        setModelMsgKind(msg.kind);
        if (list.length && !list.includes(model)) setModel(model);
      } catch (e) {
        setModels([]);
        setModelMsg((e as Error).message);
        setModelMsgKind('error');
      } finally {
        setLoadingModels(false);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [baseURL, apiKeyInput, presetId, selId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 手动刷新模型（立即）
  async function runFetch() {
    if (!preset) return;
    setLoadingModels(true);
    setModelMsg('');
    try {
      const { models: list, fallback } = await fetchModels(baseURL.trim(), needKey ? effectiveKey() : '', preset);
      const msg = describeModelFetch(list, fallback, isCustomUrl);
      setModels(list);
      setModelMsg(msg.text);
      setModelMsgKind(msg.kind);
      if (list.length && !list.includes(model)) setModel(model);
    } catch (e) {
      setModels([]);
      setModelMsg((e as Error).message);
      setModelMsgKind('error');
    } finally {
      setLoadingModels(false);
    }
  }

  async function onSave(): Promise<boolean> {
    if (!sel) return false;
    const { errs, eff } = validateForm();
    setErrors(errs);
    if (Object.keys(errs).length) {
      toast.error('请先修正表单中的错误');
      return false;
    }

    setSaving(true);
    const orig = originalKeyRef.current;
    const nextModel = model || preset?.defaultModel || '';
    const nextDisplayName = (displayNameInput.trim() || preset?.name) ?? '自定义凭证';
    // 保存会重置状态的历史缺陷修复：仅当「连接关键字段」发生变化时才把测试状态重置为未配置
    // （旧测试结果已随配置变化而失效）；配置未变的普通保存应保留上次「连接成功 / 测试失败」结果
    const keyChanged = !(apiKeyInput === '' || (orig.key ? apiKeyInput === maskKey(orig.key) : false));
    const connChanged = !!sel && (
      sel.providerId !== presetId ||
      sel.baseURL !== baseURL.trim() ||
      sel.model !== nextModel ||
      keyChanged
    );
    // 保存前点过「测试连接」且表单未再变动 → 把该测试结果一并带入保存，
    // 状态直接落为「连接成功」，不再重复发起一次请求（测试只测不写，保存才写）
    const testedOk = !!testResult?.ok && testResult.sig === currentTestSig();
    const statusPatch: Partial<ProviderConfig> = testedOk
      ? { status: 'ok', statusText: '连接成功' }
      : connChanged
        ? { status: 'unconfigured', statusText: '' }
        : {};
    const patch: Partial<ProviderConfig> = {
      name: preset?.name ?? '自定义',
      displayName: nextDisplayName,
      providerId: presetId,
      baseURL: baseURL.trim(),
      model: nextModel,
      ...statusPatch,
    };
    // 未改动 Key 且仅有密文（解密未完成）时保留密文；否则写入明文（由 store 加密）
    if ((eff === '' || (orig.enc && !orig.key && apiKeyInput === '')) && orig.enc) {
      patch.apiKeyEnc = orig.enc;
    } else {
      patch.apiKey = eff;
    }
    await updateProvider(sel.id, patch);
    pendingDraftIdRef.current = null; // 已保存：草稿转正，后续关闭不再清理
    // 保存成功后以「当前表单」为新基线（历史 Bug 修复）：
    // 1) originalKeyRef 同步为保存后的明文 Key 与密文；
    // 2) Key 输入框归位为掩码显示。
    // 否则关闭弹窗时 isEditDirty 会把「已保存的 Key/字段」与旧基线比较，
    // 将已保存的内容误判为未保存修改，弹出多余的拦截确认。
    const savedKeyPlain = eff || orig.key;
    originalKeyRef.current = { id: sel.id, key: savedKeyPlain, enc: patch.apiKeyEnc ?? '' };
    setApiKeyInput(savedKeyPlain ? maskKey(savedKeyPlain) : '');
    setSaving(false);
    toast.success('已保存（Key 已加密存储）');
    return true;
  }

  /**
   * 「测试连接」= 只测试、不写入（用户要求）：
   * 用表单当前值直接向服务商发起一次最小请求，不落库、不改凭证状态、不动激活指针；
   * 点「保存」时才真正写入本机。测试通过后若表单未再变动，保存会带入「连接成功」。
   */
  async function onTest() {
    if (!sel) return;
    const { errs, eff } = validateForm();
    setErrors(errs);
    if (Object.keys(errs).length) {
      toast.error('请先修正表单中的错误');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const m = model || preset?.defaultModel || '';
      await validateConfigWith({ baseURL: baseURL.trim(), apiKey: eff, model: m });
      setTestResult({ ok: true, text: '连接成功', sig: currentTestSig() });
      // 明确告知「未保存」：避免用户误以为已落库（保存按钮才是写入动作）
      toast.success('连接成功（尚未保存，点「保存」后才会写入本机）');
    } catch (e) {
      setTestResult({ ok: false, text: (e as Error).message, sig: currentTestSig() });
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  function onAddProvider() {
    const pre = getPreset(addPresetId) ?? PROVIDER_PRESETS[0];
    const id = addProvider(pre);
    pendingDraftIdRef.current = id; // 标记草稿：未保存关闭时一并清理，目录不留空壳
    setSelId(id);
    setEditOpen(true);
    toast.success(`已添加「${pre.name}」，请在弹窗中完成配置`);
  }

  // 仅在「表单与测试时完全一致」时展示测试结果，避免过期结果误导（签名已绑定全部连接字段）
  const activeTestResult = testResult && testResult.sig === currentTestSig() ? testResult : null;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold">
            启用 AI 助手
            <Hint text="关闭后所有 AI 功能隐藏，记账/统计等核心功能不受影响，可全程人工操作。" />
          </div>
          <Switch checked={enabled} onChange={setEnabled} />
        </div>
      </div>

      {/* 隐私说明默认折叠（用户反馈：整块文字影响页面美观），核心结论在摘要行可见，点击展开详情 */}
      <details className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm leading-relaxed">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 font-semibold text-amber-600 dark:text-amber-400 [&::-webkit-details-marker]:hidden">
          🔒 隐私与安全
          <span className="text-xs font-normal text-muted">API Key 仅存本机并加密 · 默认只发送统计汇总，不上传明细 · 点击展开详情</span>
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted">
          <li>API Key 仅保存在<b>本机</b>，不会上传到任何服务器，也不会出现在日志或对话内容中。</li>
          <li>API Key 以 AES-256-GCM 加密后存储，加密密钥仅在<b>本次会话</b>内存中存在（关闭窗口即清除）。</li>
          <li>AI 请求只会发送到你配置的接口地址，除此之外不会把数据发给任何第三方。</li>
          <li>默认仅发送<b>统计汇总</b>（收入/支出合计、分类 TOP、规则结论），<b>不发送</b>交易备注等明细。</li>
          <li>只有在下方向显式开启「允许发送明细」后才会涉及明细，且备注会<strong>强制脱敏</strong>后才上传：手机号、证件号、银行卡、邮箱、地址、网页链接等敏感信息一律被 ⚫ 遮罩，不会以原文上传。</li>
          <li>关闭 AI 或未配置时，所有原有功能（人工记账、导入、统计、预算、资金去向等）完全可用。</li>
          <li><strong>本地工具数据不受 AI 安全策略影响</strong>：你在本地看到的分类、账户、标签、图表与资金去向明细均为<b>完整原始数据</b>；「AI 安全防护（脱敏/隐私）」只针对<b>上传到云端由 AI 分析</b>的内容，两条路线完全分离。</li>
        </ul>
      </details>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold">
            允许发送明细数据
            <Hint text="开启后 AI 可参考交易明细；备注会经过强制脱敏（手机号/证件/银行卡/邮箱/地址等以 ⚫ 遮罩）后才上传。默认关闭以保护隐私。" />
          </div>
          <Switch checked={allowDetail} onChange={setAllowDetail} />
        </div>
      </div>

      {/* ===== 推理参数（全局） ===== */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
          推理参数（全局）
          <Hint text="随每次对话/补全请求发送到服务商；留空项交由服务端默认。更改即时生效并保存在本机。" />
        </div>
        <div className="space-y-4">
          <div>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5">
                Temperature（温度）
                <Hint text="越高越发散，越低越确定。推荐 0.3~0.7。" />
              </span>
              <span className="text-xs text-muted">{temperature.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={temperature}
              onChange={(e) => setAiParams({ temperature: Number(e.target.value) })}
              className="w-full"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5">
                Top-P（核采样）
                <Hint text="与 Temperature 二选一调整即可，一般将其设为服务端默认。" />
              </span>
              <span className="text-xs text-muted">{topP == null ? '服务端默认' : topP.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={topP ?? 1}
              onChange={(e) => setAiParams({ topP: Number(e.target.value) })}
              className="w-full"
            />
          </div>

          <div>
            <label className="mb-1 flex items-center gap-1.5 text-sm">
              Max Tokens（单次最大输出）
              <Hint text="限制模型单次生成的 token 数；留空使用服务端默认上限。" />
            </label>
            <Input
              type="number"
              min={1}
              value={maxTokens ?? ''}
              placeholder="留空 = 服务端默认"
              onChange={(e) => setAiParams({ maxTokens: e.target.value === '' ? null : Number(e.target.value) })}
              className="w-48"
            />
          </div>
        </div>
      </div>

      {/* ===== 凭证目录 ===== */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            凭证目录（多模型切换）
            <Hint text="每条凭证独立保存；切换模型只需改「当前」指针，历史凭证完整保留、随时可切回。激活中的凭证需先切换可删除。添加流程建议：填写接口地址与 API Key → 获取模型列表 → 测试连接 → 保存落库。" />
          </div>
          <div className="flex items-center gap-2">
            <div className="w-40">
              <Select value={addPresetId} onChange={setAddPresetId} options={presetOptions} />
            </div>
            <Button size="sm" onClick={onAddProvider}>+ 添加凭证</Button>
            {/* 重置全部 AI 配置：置于添加凭证右侧，便于就近发现；真正执行前有二次验证 */}
            <Button size="sm" variant="outline" onClick={() => setResetConfirmOpen(true)}>
              重置全部 AI 配置（清除 Key）
            </Button>
          </div>
        </div>

        {providers.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted">
            暂无凭证。请选择上方服务商后点击「添加凭证」，或参考下方说明创建多条凭证以支持多模型切换。
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {/* 凭证目录按创建时间排序；激活项为「激活指针」，切换只改指针、旧凭证完整保留 */}
            {[...providers].sort((a, b) => ((b.createdAt ?? '') < (a.createdAt ?? '') ? -1 : (b.createdAt ?? '') > (a.createdAt ?? '') ? 1 : 0)).map((p) => {
              // 「当前」以真正生效的凭证为准（显式激活指针优先，未选择时回退目录首条），
              // 与 readAIConfig 口径一致，避免界面上没有一条被标为「当前」
              const isActive = p.id === effectiveActiveId;
              const displayName = p.displayName || p.name || '未命名凭证';
              return (
                <li key={p.id} className="py-2.5">
                  <div className="flex items-center gap-3">
                    <StatusDot status={p.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {displayName}
                        {isActive && <span className="ml-2 rounded bg-[var(--color-primary)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-primary-fg)]">当前</span>}
                      </span>
                      {/* 精简展示：模型版本 + 服务商（不再展示 Key 密文，避免隐私冗余）；模型名为关键信息，
                          禁用 truncate 截断（用户反馈显示不全），超长时换行完整展示 */}
                      <span className="block break-words text-xs text-muted" title={`${p.model || '未选模型'} · ${p.name}`}>
                        {p.model || '未选模型'} · {p.name}
                      </span>
                    </span>
                    {/* 本地用量（零成本统计）：调用次数 / 累计 Tokens / 本月 Tokens */}
                    <span className="hidden shrink-0 text-right text-xs text-muted sm:block">
                      <UsageLine pid={p.id} />
                    </span>
                    <Button size="sm" variant="outline" onClick={() => { setSelId(p.id); setEditOpen(true); }}>
                      {editOpen && p.id === selId ? '编辑中' : '编辑'}
                    </Button>
                    {!isActive && (
                      <Button size="sm" variant="outline" onClick={() => { setActiveProvider(p.id); toast.success(`已切换到「${displayName}」`); }}>设为当前</Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={isActive && providers.length > 1}
                      onClick={() => {
                        const ok = removeProvider(p.id);
                        if (ok) toast.success('已删除该凭证');
                      }}
                    >
                      {isActive && providers.length > 1 ? '先切换再删' : '删除'}
                    </Button>
                  </div>
                  {/* 当前生效的 DeepSeek 凭证：余额自动查询（免费接口）+ 5 分钟自动刷新 */}
                  {isActive && isDeepSeekHost(p.baseURL) && <DeepSeekBalanceInline providerId={p.id} />}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ===== 编辑凭证弹窗（用户要求：编辑/添加不得扩展整个设置页，必须以弹窗呈现） ===== */}
      {editOpen && sel && (
        <Modal open onClose={requestCloseEdit} title={sel.displayName || sel.name || '编辑凭证'} wide>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <StatusDot status={sel.status} />
                {sel.statusText ? `状态：${sel.statusText}` : '状态：未测试'}
              </div>
            <div className="flex items-center gap-2">
              {/* 测试连接属于「配置凭证」环节，与全局启用开关无关：仅测试中禁用防重复点击 */}
              <Button size="sm" variant="outline" disabled={testing} onClick={onTest}>
                {testing ? '测试中…' : '测试连接'}
              </Button>
              <Button size="sm" disabled={saving || loadingModels} onClick={() => onSave()}>
                {saving ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>

          {/* 「测试连接」的即时结果（只测不写）：与表单签名绑定，表单任一连接字段变动后自动隐藏 */}
          {activeTestResult && (
            <p className={`text-xs ${activeTestResult.ok ? 'text-[var(--color-success)]' : 'text-red-500'}`}>
              {activeTestResult.ok ? '✓ 测试通过：' : '✗ 测试失败：'}
              {activeTestResult.text}
              {activeTestResult.ok && '（尚未保存，点「保存」后生效）'}
            </p>
          )}

          <div className="space-y-4">
            {/* 提供商预设选择 */}
            <div>
              <label className="mb-1 block text-sm font-medium">提供商</label>
              <div className="w-60">
                <Select
                  value={presetId}
                  onChange={(v) => {
                    setPresetId(v);
                    const pre = getPreset(v);
                    if (pre) {
                      // 自动填充首选变体地址（通常是 defaultBaseUrl）
                      const first = getBaseUrlVariants(pre)[0];
                      setBaseURL(first ? first.url : pre.defaultBaseUrl);
                      if (pre.defaultModel) setModel(pre.defaultModel);
                      console.log(`[AI设置] 已自动填充 ${pre.name} 镜像地址: ${first?.url ?? pre.defaultBaseUrl}`);
                    }
                  }}
                  options={presetOptions}
                />
              </div>
              <div className="mt-1.5 flex items-center gap-4 text-xs">
                {/* Tauri WebView 内原生 a[target=_blank] 无法唤起系统浏览器，统一走应用内置浏览器（失败自动回退系统浏览器） */}
                <a
                  href={preset?.apiKeyUrl ?? '#'}
                  onClick={(e) => {
                    e.preventDefault();
                    if (preset?.apiKeyUrl) void openInAppBrowser(preset.apiKeyUrl);
                  }}
                  className="text-[var(--color-primary-fg)] underline-offset-4 hover:underline"
                >
                  官方获取 Key 页面 ↗
                </a>
                <a
                  href={preset?.docUrl ?? '#'}
                  onClick={(e) => {
                    e.preventDefault();
                    if (preset?.docUrl) void openInAppBrowser(preset.docUrl);
                  }}
                  className="text-[var(--color-primary-fg)] underline-offset-4 hover:underline"
                >
                  查看文档 ↗
                </a>
              </div>
            </div>

            {/* 显示名称（同一服务商可建多条凭证时用于区分） */}
            <div>
              <label className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                凭证显示名称
                <Hint text="用于在凭证目录中区分同服务商的多条配置，仅本地展示。" />
              </label>
              <Input
                value={displayNameInput}
                onChange={(e) => setDisplayNameInput(e.target.value)}
                placeholder="例：DeepSeek Flash"
              />
            </div>

            {/* Base URL */}
            <div>
              <label className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                接口地址（Base URL）
                {baseUrlVariants.length > 1 && (
                  <Hint text="选择兼容形态会自动填充对应地址，仍可手动修改。" />
                )}
              </label>
              {baseUrlVariants.length > 1 && (
                <div className="mb-1.5">
                  <div className="w-full">
                    <Select
                      value={activeVariant?.url ?? ''}
                      onChange={(url) => {
                        setBaseURL(url);
                        console.log(`[AI设置] 切换为 ${preset?.name} 兼容形态: ${url}`);
                      }}
                      options={variantOptions}
                    />
                  </div>
                </div>
              )}
              <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://api.deepseek.com" />
              {errors.baseURL && <p className="mt-1 text-xs text-red-500">{errors.baseURL}</p>}
              {deviatedFromPreset && (
                <p className="mt-1 text-xs text-muted">已偏离 {preset?.name ?? '所选服务商'} 默认地址，将按其识别到的主体处理。</p>
              )}
              {isCustomUrl && !deviatedFromPreset && (
                <p className="mt-1 text-xs text-muted">将作为自定义地址处理（不识别为预设服务商）。</p>
              )}
            </div>

            {/* API Key */}
            <div>
              <label className="mb-1 block text-sm font-medium">API Key</label>
              <Input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={needKey ? 'sk-…（仅保存在本机，加密存储）' : '本地服务无需 Key'}
                autoComplete="off"
              />
              {errors.apiKey && <p className="mt-1 text-xs text-red-500">{errors.apiKey}</p>}
              {apiKeyInput && (
                <p className="mt-1 text-xs text-muted">当前显示：{maskKey(effectiveKey() || apiKeyInput)}</p>
              )}
            </div>

            {/* 模型选择 */}
            <div>
              <label className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                模型
                <Hint text="可从下拉点选，也可手动输入列表外的模型名。" />
              </label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Input
                    list="ai-model-options"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={models.length ? '选择或输入模型' : loadingModels ? '加载中…' : '先填写地址与 Key 后刷新'}
                  />
                  <datalist id="ai-model-options">
                    {models.map((m) => <option key={m} value={m} />)}
                  </datalist>
                </div>
                <Button
                  variant="outline"
                  onClick={runFetch}
                  disabled={loadingModels}
                >
                  {loadingModels ? '刷新中…' : '刷新模型'}
                </Button>
              </div>
              {modelMsg && (
                <p className={`mt-1 text-xs ${modelMsgKind === 'warn' ? 'text-[#F59E0B]' : 'text-red-500'}`}>{modelMsg}</p>
              )}
            </div>
          </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={resetConfirmOpen}
        title="重置全部 AI 配置"
        description="将清除本机保存的全部 AI 凭证（含各服务商 API Key，AES 密文一并移除），不可恢复。若其它功能当前依赖 AI（如财务问答、智能归类），重置后它们将回退为本地逻辑。确定重置吗？"
        confirmText="重置全部"
        danger
        onConfirm={() => {
          reset();
          setSelId(null);
          setResetConfirmOpen(false);
          toast.success('已重置 AI 配置，Key 已从本机清除');
        }}
        onClose={() => setResetConfirmOpen(false)}
      />

      {/* 未保存修改拦截：关闭编辑弹窗时若表单有改动，提供 保存并关闭 / 不保存并关闭 / 继续编辑 三条出路 */}
      <Modal open={closeConfirmOpen} onClose={() => setCloseConfirmOpen(false)} title="有未保存的修改">
        <p className="text-sm text-muted">当前凭证表单存在尚未保存的修改，请选择处理方式：</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setCloseConfirmOpen(false)}>
            继续编辑
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              // 不保存：若这是新增后从未保存过的草稿，一并从目录移除（否则会残留空壳）
              discardDraftIfNeeded();
              setCloseConfirmOpen(false);
              setEditOpen(false);
            }}
          >
            不保存并关闭
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              const ok = await onSave();
              setCloseConfirmOpen(false);
              if (ok) setEditOpen(false);
            }}
          >
            保存并关闭
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** Token 数量友好格式化：≥1 万时以「x.x万」展示，否则原样。 */
function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(1)}万` : String(n);
}

/**
 * 本地用量行：读取 kv.aiUsage（零成本本地统计，无网络请求、不产生任何费用）。
 * 展示「调用次数 / 累计 Tokens / 本月 Tokens」，10 秒轻量自刷新，无需人为刷新。
 */
function UsageLine({ pid }: { pid: string }) {
  const [stat, setStat] = useState<AiUsageStat | null>(null);
  useEffect(() => {
    const refresh = () => setStat(loadAiUsage(pid));
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [pid]);
  if (!stat || (stat.requests === 0 && stat.tokens === 0)) return null;
  return (
    <span className="block">
      调用 {stat.requests} 次 · 累计 {fmtTokens(stat.tokens)} · 本月 {fmtTokens(stat.monthTokens)}
    </span>
  );
}

/**
 * DeepSeek 账户余额行：GET /user/balance 真实拉取（免费接口，只读账户信息、不计费），
 * 挂载即自动查询并每 5 分钟自动刷新，无需用户手动点击。
 */
function DeepSeekBalanceInline({ providerId }: { providerId: string }) {
  const [data, setData] = useState<DeepSeekBalance | null>(null);
  const [err, setErr] = useState('');

  async function load() {
    setErr('');
    try {
      const res = await fetchBalance();
      if (!res) {
        setErr('未配置 Key');
        return;
      }
      setData(res);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5 * 60 * 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs">
      <span className="font-medium text-[var(--color-primary-fg)]">账户余额</span>
      {err && <span className="text-red-500">{err}</span>}
      {data && (
        <>
          <span className="text-muted">is_available：{data.is_available ? '是' : '否'}</span>
          {data.balance_infos.map((b) => (
            <span key={b.currency} className="flex flex-wrap items-center gap-x-3">
              <span className="font-medium">{b.currency}</span>
              <span>总余额：<b>{Number(b.total_balance).toFixed(2)}</b></span>
              <span>充值余额：{Number(b.topped_up_balance).toFixed(2)}</span>
              <span>赠送余额：{Number(b.granted_balance).toFixed(2)}</span>
            </span>
          ))}
        </>
      )}
    </div>
  );
}
