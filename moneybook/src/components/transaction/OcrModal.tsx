/**
 * 拍照录入 / 票据 OCR 弹窗组件
 * -----------------------------------------------------------------------------
 * 流程：选图 → 本地 OCR（PP-OCRv4 / ONNX Runtime Web，图片不出本机）→ 脱敏文本预览 →
 *       AI 解析成账（可选项）→ 把识别结果填回记账表单。
 * 隐私：图片与脱敏文本均只在本机处理；仅脱敏后文本在用户配置 AI 时才会发送
 * 到用户自填的接口，未配置 AI 时也能本地识别并手动填写（不阻断）。
 */
import { useRef, useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { downscaleImage, recognizeImage, getPaddleEngine } from '@/lib/ocr';
import { ocrTextToItems, heuristicExtractOcrItems } from '@/api/ocrBook';
import type { AiBookItem } from '@/api/aiBook';
import { readAIConfig } from '@/stores/useAIStore';

/** OCR 识别超时阈值（毫秒）：PP-OCR server 模型（90MB）冷启动 + 图片放大重采样耗时可达数十秒，
 *  故放宽到 3 分钟；同时打开弹窗即预热引擎，避免首张图卡超时。 */
const OCR_TIMEOUT_MS = 180000;

/**
 * 给 Promise 加超时：超过 ms 后 reject；先完成则正常 resolve。用于防住 OCR 意外挂起。
 */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export default function OcrModal({ open, onClose, onApply, onApplyMany }: {
  open: boolean;
  onClose: () => void;
  /** 将识别出的记账项回填到交易表单（单条） */
  onApply: (item: AiBookItem) => void;
  /** 批量入账：把账户已匹配的多条一次写入（多商品小票） */
  onApplyMany?: (items: AiBookItem[]) => void;
}) {
  const { data: accounts = [], isFetched } = useAccounts(false);
  const { data: cats = [] } = useCategories();
  const fileRef = useRef<HTMLInputElement>(null);
  // 识别取消：连续拖入多张图/关闭弹窗时中止上一次识别，避免旧结果覆盖 UI
  const abortRef = useRef<AbortController | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [text, setText] = useState('');
  const [items, setItems] = useState<AiBookItem[]>([]);
  const [aiParsed, setAiParsed] = useState(false);
  const [imgUrl, setImgUrl] = useState('');
  // AI 是否已配置可用凭证（enabled 且活动凭证含 API Key），用于决定展示哪些引导提示
  const aiReady = (() => {
    const cfg = readAIConfig();
    return cfg.enabled && !!cfg.apiKey && !!cfg.baseURL;
  })();

  // 打开弹窗即预热 PP-OCR 引擎：fast（mobile）引擎为必用，提前在后台加载，
  // 用户选图识别时引擎已就绪，避免首张图超时。
  // 注意：server rec 复核引擎【不在弹窗预热】——它只在"含长数字串且 fast 置信度不足"时才懒加载，
  // 避免每次打开弹窗都常驻 90MB server 模型、白占内存与启动耗时。
  useEffect(() => {
    if (!open) return;
    getPaddleEngine().catch(() => { /* 预热失败不阻断，识别时会再尝试 */ });
    return () => { abortRef.current?.abort(); abortRef.current = null; }; // 关闭/卸载时中止进行中的识别
  }, [open]);

  async function handleFile(file: File) {
    // 本地 OCR：识别直接从文件读取，图片不离开本机
    // 若上一次识别仍在进行，先中止它（#13）
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRecognizing(true);
    setText(''); setItems([]); setAiParsed(false); setParsing(false);
    // 生成本地预览图（仅用于展示，不会上传统计）
    setImgUrl(URL.createObjectURL(file));
    try {
      // 识别前先等比例压缩大图，避免超大原图导致长时间"识别中"；压缩仍在本机完成
      const down = await downscaleImage(file);
      // 加超时保护：压缩后通常数秒出结果，超时则提示重试，不再无限卡在识别中
      const recognized = await withTimeout(
        recognizeImage(down, undefined, { signal: controller.signal }),
        OCR_TIMEOUT_MS,
        '识别超时，请换一张更清晰的图片重试'
      );
      if (!recognized) { toast.info('未识别到文字，请更换更清晰的图片'); return; }
      setText(recognized);
      console.log('[ocr] 本地识别完成，文本长度:', recognized.length);
      await parseText(recognized);
    } catch (e) {
      // 被新选择/关闭中止的识别是预期取消，不提示错误
      if ((e as Error).name === 'AbortError') return;
      toast.error((e as Error).message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRecognizing(false);
      setParsing(false);
    }
  }

  /**
   * 用给定文本（识别结果或用户编辑后的文本）走脱敏 + AI 解析，更新文本与账目条目。
   * 抽出以便「识别后自动解析」与「用户修正文本后重新解析」复用同一逻辑。
   */
  async function parseText(raw: string) {
    setParsing(true); setItems([]); setAiParsed(false);
    try {
      // 脱敏后交给 AI 解析；AI 未配置时也能返回脱敏文本
      const res = await ocrTextToItems(raw, accounts, cats);
      setText(res.text); setItems(res.items); setAiParsed(res.aiParsed);
    } catch (e) {
      toast.error(`解析失败：${(e as Error).message}`);
      // 解析失败不阻断：仍保留已识别/已编辑的文本，供用户手动填写
      setText(raw);
    } finally {
      setParsing(false);
    }
  }

  /** 用户手动修正脱敏文本后，用新文本重新解析成账目条目 */
  function handleReparse() {
    const edited = text.trim();
    if (!edited) { toast.warning('识别内容为空，请先在文本框中填写内容'); return; }
    void parseText(edited);
  }

  function handleApply() {
    // 已识别出文本但 AI 未产出条目时，用本地启发式解析兜底，仍可一键填表（无需配置 AI）
    const first = items[0] ?? (text.trim() ? heuristicExtractOcrItems(text, accounts, cats)[0] : undefined);
    if (!first) { toast.warning('暂无可填写的记账项，请先识别或手动填写识别内容'); return; }
    if (items.length > 1) toast.info(`已识别 ${items.length} 条，本次填入第 1 条，其余可「批量入账」或逐条填写`);
    onApply(first);
    onClose();
  }

  function handleApplyMany() {
    if (!onApplyMany) { toast.warning('当前入口不支持批量入账，请逐条填入'); return; }
    const bookable = items.filter((it) => it.amount > 0 && it.accountId != null);
    if (!bookable.length) { toast.warning('没有账户已匹配的条目可批量入账，请逐条填入后手动选择账户'); return; }
    onApplyMany(bookable);
    onClose();
  }

  function handleClose() {
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    setImgUrl(''); setText(''); setItems([]); setAiParsed(false);
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title="拍照录入 / 票据记账" wide>
      <div className="space-y-4">
        {/* 选图区域 */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" disabled={recognizing || !isFetched}
            onClick={() => fileRef.current?.click()}>
            {recognizing ? '识别中…' : '选择图片'}
          </Button>
          <span className="text-xs text-muted">支持小票、账单截图；图片仅在本机识别，不会上传</span>
        </div>

        {imgUrl && (
          <div className="flex justify-center rounded-lg border border-[var(--border)] p-2">
            <img src={imgUrl} alt="票据预览" className="max-h-44 rounded object-contain" />
          </div>
        )}

        {/* 识别文本预览（已脱敏） */}
        {text && (
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <label className="text-sm text-muted">识别内容（可编辑，修改后可重新解析）</label>
              {parsing && <span className="text-xs text-[var(--color-primary-fg)]">AI 解析中…</span>}
              {!parsing && aiParsed && <span className="text-xs text-[var(--color-success)]">已解析 {items.length} 条</span>}
              {!parsing && !aiParsed && items.length === 0 && text && (
                <span className="text-xs text-muted">
                  {aiReady
                    ? 'AI 暂未解析出账目，可直接填入上方识别内容或修改文本后重新解析'
                    : '无需 AI 也可直接一键填入上方识别内容（本地解析）'}
                </span>
              )}
              {/* 用户修正识别文本后手动重新解析 */}
              {!parsing && (
                <Button type="button" variant="outline" className="ml-auto px-2 py-0.5 text-xs"
                  onClick={handleReparse}>重新解析</Button>
              )}
            </div>
            {/* 可编辑文本：识别结果脱敏后可人工修正，再点"重新解析"让修改生效 */}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              disabled={recognizing || parsing}
              className="max-h-60 w-full resize-y rounded-lg border border-[var(--border)] bg-black/2 p-3 text-xs leading-relaxed"
            />
          </div>
        )}

        {/* 解析出的账目条目 */}
        {items.length > 0 && (
          <div className="space-y-2">
            <label className="text-sm text-muted">解析结果</label>
            {items.slice(0, 5).map((it, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] p-2 text-sm">
                <span>{['支出', '收入', '转账', '借出', '借入'][['expense', 'income', 'transfer', 'lend', 'borrow'].indexOf(it.type)] ?? it.type}</span>
                <span className="font-semibold">¥{it.amount.toFixed(2)}</span>
                {it.categoryId ? <span className="text-muted">分类 #{it.categoryId}</span> : <span className="text-xs text-orange-500">分类待选</span>}
                {it.accountId ? <span className="text-muted">账户 #{it.accountId}</span> : <span className="text-xs text-orange-500">账户待选</span>}
                {it.date && <span className="text-muted text-xs">{it.date}</span>}
                {it.note && <span className="truncate text-xs text-muted">{it.note}</span>}
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={handleClose}>关闭</Button>
          {onApplyMany && (
            <Button type="button" variant="outline"
              disabled={recognizing || parsing || !items.some((it) => it.amount > 0 && it.accountId != null)}
              onClick={handleApplyMany} title="把账户已匹配的多条一次入账（多商品小票）">
              批量入账
            </Button>
          )}
          <Button type="button" disabled={recognizing || parsing || (!items.length && !text.trim())} onClick={handleApply}>填入表单</Button>
        </div>
        {/* 未识别到文本时给出引导；已识别文本即可一键填入（AI 优先、本地启发式兜底，无需配置 AI） */}
        {!items.length && !parsing && !recognizing && !text.trim() && (
          <span className="text-right text-xs text-muted">
            请先选择图片完成本地识别，识别到文本后即可一键填入表单（无需配置 AI）
          </span>
        )}
      </div>
      </div>
    </Modal>
  );
}