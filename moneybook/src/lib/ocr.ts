/**
 * 本地 OCR 识别模块（票据 / 截图文字提取）
 * -----------------------------------------------------------------------------
 * 引擎：ONNX Runtime Web + PP-OCRv4（检测 det + 角度分类 cls + 识别 rec），
 *       模型与中文字典、wasm 运行时全部随应用打入 public/，完全本地离线推理。
 *
 * 隐私铁律（调用方必须遵守）：
 *  1. 图片只在本机由 PP-OCR 引擎处理，绝不将图片上传统计到任何外部地址。
 *  2. 识别得到的文本在交给 AI 解析之前，必须先经 maskSensitive 脱敏（见 ocrBook.ts），
 *     避免票据中的手机号 / 证件号 / 银行卡等个人敏感信息外泄。
 *  3. 模型、字典、wasm 均为静态本地资源，识别不发起任何外部网络请求。
 *
 * 纯函数（normalizeOcrText / ocrTargetSize / mergeOcrLinesByY）与引擎副作用部分（recognizeImage）分离，便于单元测试。
 */
import { OcrEngineWorker, type OcrEngineOptions, type RecognizeOptions, type OcrLine, type Quad } from '@ocr-web/core';

/** 开发/测试环境标志：仅开发环境输出耗时分解等调试日志，生产不刷屏、不透出内部信息 */
const IS_DEV = import.meta.env?.DEV ?? false;

/** PP-OCR 识别不区分语言参数（内置中英混合），保留兼容旧签名但忽略 lang。 */
export const OCR_DEFAULT_LANG = 'ch';

/** PP-OCR 静态模型资源根目录（相对 import.meta.env.BASE_URL，随 public/ 打包） */
export const PADDLE_ASSET_ROOT = `${import.meta.env.BASE_URL ?? '/'}paddle`;
/** 检测（det）模型路径 */
export const PPOCR_DET_URL = `${PADDLE_ASSET_ROOT}/det/ch_PP-OCRv4_det_infer.onnx`;
/** 识别（rec）模型路径 */
export const PPOCR_REC_URL = `${PADDLE_ASSET_ROOT}/rec/ch_PP-OCRv4_rec_infer.onnx`;
/** server 版 rec 模型路径（ch_PP-OCRv4_rec_server.onnx，约 90MB，长数字串识别更准）。
 *  仅用于"server 复核"：对含长数字串（订单号/单号）的行按检测框裁剪后二次复核，
 *  不参与全图识别，兼顾 mobile 的快速与 server 的长串准确率。 */
export const PPOCR_REC_SERVER_URL = `${PADDLE_ASSET_ROOT}/rec/ch_PP-OCRv4_rec_server.onnx`;
/** 角度分类（cls）模型路径 */
export const PPOCR_CLS_URL = `${PADDLE_ASSET_ROOT}/cls/ch_ppocr_mobile_v2.0_cls_infer.onnx`;
/** 中文字典路径（PP-OCR ppocr_keys_v1.txt，一行一字符） */
export const PPOCR_DICT_URL = `${PADDLE_ASSET_ROOT}/dict/ppocr_keys_v1.txt`;
/** ONNX Runtime wasm 运行时根目录（ort-wasm-simd-threaded.wasm 等） */
export const ORT_WASM_ROOT = `${import.meta.env.BASE_URL ?? '/'}ort/`;

/** OCR 模型版本号（模型更新时递增）。用于运营侧记录"本版本用哪套模型"，可在设备信息/关于页展示。 */
export const OCR_MODEL_VERSION = 'ppocr-v4.1';

/**
 * OCR 模型完整性清单（模型文件 → 期望 SHA-256，十六进制小写）。
 * 用于启动/预热时校验所加载的模型未被篡改或损坏（对安全基线的"模型哈希校验"兜底）。
 * 哈希于本地打包时用 `Get-FileHash -Algorithm SHA256` 计算并登记；模型更新时须同步重算。
 */
export const OCR_MODEL_MANIFEST: Record<string, string> = {
  'ch_PP-OCRv4_det_infer.onnx': 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
  'ch_PP-OCRv4_rec_infer.onnx': 'a41b9e79b60be6314ab0db1a0920b1650a710489020e2de2b452821f4b5adec9',
  'ch_PP-OCRv4_rec_server.onnx': '6a2676219be9907c7fc9cf61ebaa843bf2898777def567925b78886fcd90c07a',
  'ch_ppocr_mobile_v2.0_cls_infer.onnx': 'cf443393df5e23f068c113f2ee5ee286918da7c386535a4ccd8c9c815d808445',
  'ppocr_keys_v1.txt': 'a1c84d9bdb9ab29043c58896224d32941783eb821629618416dcb08f12886492',
};

/** 是否运行在 Tauri 桌面（存在 IPC 全局）；Worker/浏览器预览返回 false。 */
function isTauriRuntime(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (window as any)?.__TAURI_INTERNALS__ !== 'undefined';
}

interface ModelCheckLite { file: string; present: boolean; matched: boolean }

/**
 * 根据校验结果给出判定（纯函数，可单测）。
 * 覆盖失败路径：模型缺失 / 哈希不匹配 → 明确结论（不静默忽略），供 UI/日志提示用户。
 */
export function modelVerificationVerdict(
  available: boolean,
  checks: ModelCheckLite[]
): { status: 'ok' | 'unavailable' | 'missing' | 'mismatch' | 'not_configured'; bad: ModelCheckLite[] } {
  if (!available) return { status: 'unavailable', bad: [] };
  if (!checks.length) return { status: 'not_configured', bad: [] };
  const bad = checks.filter((c) => !c.present || !c.matched);
  const missing = bad.some((c) => !c.present);
  return { status: bad.length === 0 ? 'ok' : missing ? 'missing' : 'mismatch', bad };
}

/**
 * 在 Tauri 桌面端做 OCR 模型运行时完整性校验：调用后端 Rust command 读取磁盘模型文件
 * 计算 SHA-256 并与登记清单（OCR_MODEL_MANIFEST）比对。仅执行一次，校验结论写日志。
 * - 浏览器预览 / 非 Tauri：静默跳过，不阻断识别。
 * - 开发 dev 模式资源目录可能无 paddle：后端返回 available=false，仅提示。
 * - 模型缺失或哈希不符：告警但不阻断（识别仍可用，避免误伤）。
 */
let ocrModelsVerified = false;
export async function verifyOcrModelsInTauri(): Promise<void> {
  if (ocrModelsVerified || !isTauriRuntime()) return;
  ocrModelsVerified = true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const report = await invoke<{ available: boolean; allOk: boolean; checks: Array<{ file: string; present: boolean; matched: boolean }> }>(
      'verify_model_integrity',
      { expected: OCR_MODEL_MANIFEST }
    );
    const verdict = modelVerificationVerdict(report.available, report.checks);
    if (verdict.status === 'unavailable') {
      // 开发模式资源目录没有 paddle 属正常，仅提示
      console.warn('[ocr] 模型目录不可用，跳过运行时哈希校验（开发模式资源未打包）');
      return;
    }
    if (verdict.status === 'ok') { console.info(`[ocr] 模型完整性校验通过（${report.checks.length} 个文件）`); return; }
    const bad = verdict.bad.map((c) => `${c.file}(${c.present ? '哈希不符' : '缺失'})`);
    console.warn(`[ocr] 模型完整性校验未通过（${verdict.status}）：${bad.join('、')}。模型可能被篡改/损坏，但为保障可用性仍继续识别，请核实模型文件。`);
  } catch (e) {
    console.warn('[ocr] 模型完整性校验不可用：', (e as Error)?.message);
  }
}

/** 计算字节数组/字符串的 SHA-256 十六进制（纯函数；依赖 WebCrypto subtle，Node≥18 / 浏览器均全局可用）。 */
export async function computeSha256Hex(data: ArrayBuffer | string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持 WebCrypto SHA-256');
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 校验模型文件哈希（纯函数）：文件内容哈希与登记值一致才算通过。
 * notAnotated（清单未登记）时返回 null 表示"未配置校验"；不符返回 false（应告警，不阻断识别）。
 */
export async function verifyModelIntegrity(filename: string, modelBytes: ArrayBuffer | string): Promise<boolean | null> {
  const expected = OCR_MODEL_MANIFEST[filename];
  if (!expected) return null; // 未登记哈希 → 跳过校验（log 已知）
  const actual = await computeSha256Hex(modelBytes);
  return actual.toLowerCase() === expected.toLowerCase();
}

/* 兼容旧 tesseract 导出名：PP-OCR 已完全替代 tesseract，语言包目录/路径解析不再需要，
 * 此处不再提供垫片（避免调用方误依赖返回 undefined 的假路径）。 */

/** 若给定 signal 已中止，抛出 AbortError（DOMException('OCR 已取消','AbortError')）。
 *  用于识别各阶段间隙尽早响应取消，避免已弃用的识别结果继续覆盖 UI。纯函数，可单测。 */
export function throwIfAborted(signal: AbortSignal | undefined, stage: string = '识别'): void {
  if (signal?.aborted) throw new DOMException(`OCR 已取消（${stage}）`, 'AbortError');
}

/** 文本清洗的可组合选项（#17 合并 normalizeOcrText / layoutCleanText 的公共管道） */
interface CleanOptions {
  /** 压缩行内连续空白为单个空格；false 则保留行内空格以还原票据"名称…金额"右对齐版面 */
  compressSpaces?: boolean;
  /** 行内"¥"前数字误粘净化（3¥32.20 → ¥32.20） */
  stripMoneyGlue?: boolean;
  /** 版面装饰：日期与时间补空格 + 逐行剥离首尾孤立箭头/压缩重复右括号/清理行尾虚线 */
  applyLayout?: boolean;
}

/**
 * OCR 文本统一清洗管道：剔除控制字符、压缩空行、按需压缩行内空白 / 金额误粘净化 / 版面装饰。
 * normalizeOcrText（压缩空白+净化金额，供脱敏/AI 解析）与 layoutCleanText（保留空格+还原版面，
 * 供识别结果展示）都是它的薄封装，二者共享同一套底部规则，避免逻辑漂移。纯函数，可单测。
 */
export function cleanText(raw: string, opts: CleanOptions = {}): string {
  if (!raw) return '';
  const { compressSpaces = false, stripMoneyGlue = false, applyLayout = false } = opts;
  let s = String(raw)
    // 剔除控制字符与不可见字符（保留换行 \n 与制表符以便分行）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // 空行压缩为单换行（两种模式都需要）
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n');
  if (compressSpaces) {
    // 行内连续空白（含空格、全角空格、制表符）压缩为单个空格，去掉行尾多余空白
    s = s
      .replace(/[ \t\u00A0\u3000]+/g, ' ')
      .replace(/[ \t]+$/gm, '');
  }
  if (applyLayout) {
    // 日期与时间粘连补空格：2026-09-2719:02:40 → 2026-09-27 19:02:40
    // 支持 - / . 分隔（如 2026/09/27、2026.09.27）以及不含秒的时间（19:02）。
    s = s.replace(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(\d{1,2}:\d{2}(?::\d{2})?)/g, '$1 $2');
    // 逐行清理冗余字符：行首/行尾孤立箭头、连续右括号压缩、行尾虚线
    s = s
      .split('\n')
      .map((line) => line
        .replace(/^\s*[><]+\s+/, '')                  // 行首孤立箭头（后随空白）剥离
        .replace(/\s*[><]\s*$/g, '')                  // 行尾孤立箭头（允许前面有空格）
        .replace(/([\)）]{2,})$/g, (m) => m[m.length - 1]) // 连续右括号压成一个
        .replace(/[-\s]{3,}$/g, '')                   // 行尾虚线
      )
      .join('\n');
  }
  if (stripMoneyGlue) {
    // 金额净化：纠正 PP-OCR 把人民币符号"¥"误识别为"3¥"的粘连误粘。
    // 仅当数字紧贴 ¥/￥ 且其后为合法两位小数金额时删除；用负向前瞻要求被删数字前一位不是数字/字母
    //（`订单号123¥45.67` 中 3¥ 前的 2 会挡住，不误删订单号里的数字）。
    s = s.replace(/(?<![\da-zA-Z])(\d)([￥¥]\d+\.\d{2})/g, '$2');
  }
  return s.trim();
}

/**
 * 归一化 OCR 识别出的原始文本：压缩行内空白 + 金额误粘净化，供脱敏与 AI 解析得到干净输入。
 * （#17）薄封装 cleanText。
 */
export function normalizeOcrText(raw: string): string {
  return cleanText(raw, { compressSpaces: true, stripMoneyGlue: true });
}

/** OCR 识别图的边长上限（像素）。超过的等比例压缩后再识别，显著降低计算量 */
export const OCR_MAX_DIM = 1600;
/** 低分辨率截图放大阈值：长边小于该值会被等比放大，使小字（长数字串等）更清晰，利于 rec */
export const OCR_UPSCALE_MIN_DIM = 1400;

/** 运行环境是否支持离屏解码位图（Tauri / 现代浏览器支持；Node 单测环境不支持则跳过压缩）。
 *  同时要求存在 document：SSR / 纯 Worker / Node 下没有 document，避免 createElement 抛错 */
export const CAN_OFFSCREEN =
  typeof createImageBitmap === 'function' && typeof document !== 'undefined';

/**
 * 计算识别用目标尺寸：既防止超大图（长边>maxDim）过大，又对低分辨率小图（长边<upscaleMin）
 * 等比放大，使小字（长数字串、日期、金额）更清晰、利于 PP-OCR rec。
 * 纯函数，可单测。
 */
export function ocrTargetSize(
  width: number,
  height: number,
  maxDim: number = OCR_MAX_DIM,
  upscaleMin: number = OCR_UPSCALE_MIN_DIM
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width, height };
  }
  const long = Math.max(width, height);
  // 缩放到上限（图片过大时缩小）
  let scale = Math.min(1, maxDim / long);
  // 过小则放大到 upscaleMin（提升小字清晰度）
  if (long < upscaleMin) {
    scale = Math.max(scale, upscaleMin / long);
  }
  if (scale === 1) return { width, height };
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * 将图片处理到适合识别的尺寸（过大缩小、过小放大）后返回 Blob。
 * 低分辨率小图会被等比放大（双三次近似的平滑重采样），使订单号等小字更清晰。
 * 图片数据始终只在本机处理、不出设备；不支持离屏解码时原样返回。
 */
export async function downscaleImage(file: Blob, maxDim: number = OCR_MAX_DIM): Promise<Blob> {
  if (!CAN_OFFSCREEN) return file;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const { width, height } = ocrTargetSize(bitmap.width, bitmap.height, maxDim);
    if (width === bitmap.width && height === bitmap.height) return file;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    // 高质量平滑重采样：放大（低分辨率小图）时保留边缘锐度，避免放大后字迹发虚
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    // 输出格式：PNG/webP 为无损源，保留为 PNG 以免文字细节有损；其余（如 JPEG）原样用 JPEG。
    // 关键：长数字串（订单号等）对压缩很敏感，JPEG 有损会削边丢位，故 webp 不走 JPEG 重编码。
    const isLossless = file.type === 'image/png' || file.type === 'image/webp';
    const type = isLossless ? 'image/png' : 'image/jpeg';
    return await new Promise<Blob>((resolve) => {
      canvas.toBlob((b) => resolve(b ?? file), type, isLossless ? undefined : 0.92);
    });
  } catch {
    return file; // 解码/压缩失败时退回原图，不阻断识别
  } finally {
    bitmap?.close();
  }
}

/** 合并同一水平行的 OCR 检测框并还原版式：票据中"商品名左对齐 + 金额右对齐"常被拆成两个框，
 *  按 Y 中心接近度归并同一逻辑行，再按 X 排序、按相邻框的像素间距估算空格数拼接，
 *  使"伊利安慕希酸奶      ¥32.20"这类左右对齐的版面在文本中得到保留。
 *  纯函数，可单元测试。box 为四个 [x,y] 角点（TL/TR/BR/BL）。 */
export function mergeOcrLinesByY(
  lines: OcrLine[],
  yToleranceRatio = 0.5
): string[] {
  if (!lines || lines.length === 0) return [];
  interface B { text: string; x0: number; x1: number; yc: number; h: number; }
  const boxes: B[] = lines
    .map((l) => {
      const xs = l.box.map((p) => p[0]);
      const ys = l.box.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      return { text: (l.text ?? '').trim(), x0, x1, yc: (y0 + y1) / 2, h: y1 - y0 };
    })
    .filter((b) => b.text.length > 0);
  if (boxes.length === 0) return [];
  // 估算单个"有效字符"的平均像素宽度，用于把框间距换算成空格数（#3）。
  // 中文/全角字符约占 1 个有效字宽，ASCII/半角（数字、字母、¥、. 等)约占 0.5；
  // 直接用 text.length 会高估半角数字/符号的字数、低估其单字宽，导致金额与名称之间
  // 的换算空格数失真。改为"总框宽 / 总有效字宽"，大框贡献更大、尺寸更稳定。
  const isWideChar = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/;
  const effLen = (t: string) => {
    let n = 0;
    for (const ch of t) n += isWideChar.test(ch) ? 1 : 0.5;
    return n;
  };
  let totalW = 0;
  let totalEff = 0;
  for (const b of boxes) {
    totalW += b.x1 - b.x0;
    totalEff += effLen(b.text);
  }
  const avgCharW = totalEff > 0 ? totalW / totalEff : 1;
  const avgH = boxes.reduce((s, b) => s + b.h, 0) / boxes.length || 1;
  const tolerance = Math.max(avgH * yToleranceRatio, 2);
  // 按 Y 中心排序，逐行归并：Y 中心相近 → 同一逻辑行
  const sorted = [...boxes].sort((a, b) => a.yc - b.yc);
  const rows: B[][] = [];
  for (const b of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(b.yc - last[0].yc) <= tolerance) last.push(b);
    else rows.push([b]);
  }
  // 每行内按 X 排序；相邻框间距越大补的空格越多，还原"左名称右金额"的版面
  return rows
    .map((row) => {
      row.sort((a, b) => a.x0 - b.x0);
      let out = row[0].text;
      for (let i = 1; i < row.length; i++) {
        const gap = Math.max(0, row[i].x0 - row[i - 1].x1);
        const spaces = Math.max(1, Math.round(gap / (avgCharW || 1)));
        out += ' '.repeat(spaces) + row[i].text;
      }
      return out;
    })
    .filter((t) => t.length > 0);
}

/** 识别层面的可组合选项（供 recognizeImage 透传给 PP-OCR 引擎） */
export interface PaddleOcrOptions {
  /** 是否启用角度分类（默认 true：自动矫正 0/180° 文本） */
  useClassification?: boolean;
  /** 检测概率二值化阈值（默认 0.3） */
  detThreshold?: number;
  /** 检测框平均概率过滤阈值（默认 0.6） */
  detBoxThreshold?: number;
  /** 检测输入最长边（默认 960） */
  maxSideLen?: number;
  /** 检测框扩张系数（默认 1.6；不宜调大以免价格框外扩写入行首噪声污染金额） */
  unclipRatio?: number;
}

/** 默认透传参数。针对票据/小字截图调优：
 *  - detThreshold 略降：更灵敏地检出小字号文本区域
 *  - detBoxThreshold 略降：保留置信度稍低但可能有效的文本框
 *  - maxSideLen 保持 960：官方稳定值
 *  - unclipRatio 1.6：禁过大外扩。曾试点 2.0 修错字，但会令价格检测框向左过度外扩，
 *    把行首分隔符/噪声一起裁进识别框，导致金额被污染（如 ¥32.20 误识别成 3¥32.20→332.20），
 *    金额污染比个别错字危害更大，故保持官方默认 1.6。
 */
const DEFAULT_PPOCR_OPTIONS: Required<PaddleOcrOptions> = {
  useClassification: true,
  detThreshold: 0.25,
  detBoxThreshold: 0.5,
  // det 输入最长边。实测低分辨率截图的订单号长串识别不随 maxSideLen(960/1280) 变化（逐字一致），
  // 说明根因在 rec 对长串的切分能力而非图像分辨率，故保持官方默认 960 以控制耗时/内存。
  maxSideLen: 960,
  unclipRatio: 1.6,
};

/** 引擎初始化失败的熔断退避（毫秒）：最近失败过则短时间内直接拒绝，不再反复完整重载
 *  （wasm/模型下载每次数秒，若为确定性失败反复重试只会白耗）。 */
export const ENGINE_RETRY_BACKOFF_MS = 10_000;

/** 惰性单例：首次识别才加载引擎（含三模型 + 字典），后续复用，避免反复初始化慢 */
let enginePromise: Promise<OcrEngineWorker> | null = null;
let engineFailAt = 0;

/**
 * 创建（复用的）PP-OCR 引擎单例，运行在后台 Web Worker，避免主线程被密集推理阻塞。
 * 模型 / 字典 / wasm 均从本地 public 资源加载，识别全程离线。
 */
export async function getPaddleEngine(): Promise<OcrEngineWorker> {
  // 失败熔断：短时间内不重试，直接拒绝并抛出可读信息，避免每次识别都重载失败（#19）
  if (!enginePromise && engineFailAt && Date.now() - engineFailAt < ENGINE_RETRY_BACKOFF_MS) {
    throw new Error('OCR 引擎初始化刚失败，请稍后再试');
  }
  if (!enginePromise) {
    // 首次建引擎时顺带做一次 Tauri 端模型哈希校验（尽力而为，失败不阻断）
    void verifyOcrModelsInTauri();
    const opts: OcrEngineOptions = {
      models: {
        detection: PPOCR_DET_URL,
        recognition: PPOCR_REC_URL,
        classification: PPOCR_CLS_URL,
      },
      dictionary: PPOCR_DICT_URL,
      runtime: 'wasm',
      wasmPaths: ORT_WASM_ROOT,
      // 多线程需 crossOriginIsolated（SharedArrayBuffer）。仅 Tauri 生产（tauri:// 同源）可用；
      // 浏览器 dev 用局域网 IP http 访问时不可信源，多线程不可用。这里按环境显式降为 1，
      // 既避免 onnxruntime 无谓地申请 4 线程又拿不到（控制台不再刷多线程警告），也保证功能可用。
      numThreads: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? 4 : 1,
    };
    if (IS_DEV) console.log(`[ocr] 初始化 PP-OCR 引擎（后台 Worker；${
      typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? '多线程 x4' : '单线程（浏览器非隔离源，Tauri 桌面自动启用多线程）'
    }）…`);
    enginePromise = (async () => {
      // 用原生 new URL 让 Vite 打包 @ocr-web/core 的 worker 入口为独立 Worker。
      // 注意 specifier 是 exports 暴露的 "./worker"（对应 dist/worker.js），非原始文件路径。
      const worker = new Worker(new URL('@ocr-web/core/worker', import.meta.url), { type: 'module' });
      return OcrEngineWorker.create({ worker, ...opts });
    })().catch((e) => {
      console.error('[ocr] PP-OCR 引擎初始化失败', e);
      engineFailAt = Date.now(); // 记录失败时间用于熔断退避
      enginePromise = null;       // 冷却期过后允许再次重试
      throw e;
    });
  }
  return enginePromise;
}

/** server 复核引擎空闲 TTL（毫秒）：最后一次使用该时长后自动释放 90MB 模型，
 *  避免低内存设备常驻大模型导致 OOM；下次复核需要时再按需重建。 */
export const SERVER_ENGINE_TTL_MS = 60_000;
/** server 复核裁剪图使用的识别参数：单行小图无需角度分类，也不再走整图 det 阈值。
 *  detThreshold 略抬、unclipRatio 调小，避免裁剪后外扩把相邻行/噪声裁进复核区（#7）。 */
export const REVIEW_OCR_OPTIONS: RecognizeOptions = {
  useClassification: false,
  detThreshold: 0.3,
  detBoxThreshold: 0.5,
  maxSideLen: 640,
  unclipRatio: 1.2,
};
/** server 复核识别并发上限：OcrEngineWorker 底层为单 worker 串行处理，并发过高无收益，
 *  限制在 2 以控制 wasm 线程与内存峰值（#4）。 */
export const SERVER_REVIEW_CONCURRENCY = 2;

/** server 复核引擎状态：惰性创建 + 空闲 TTL 自动释放（#5） */
let serverEngineState: { engine: OcrEngineWorker; lastUsed: number } | null = null;
let serverEngineTimer: ReturnType<typeof setTimeout> | null = null;
let serverEngineFailAt = 0;

/** 若引擎空闲超时，立即释放 worker 与其 90MB 模型（幂等）。 */
export async function disposeServerEngine(): Promise<void> {
  if (serverEngineTimer) {
    clearTimeout(serverEngineTimer);
    serverEngineTimer = null;
  }
  const state = serverEngineState;
  serverEngineState = null;
  if (state) {
    try {
      await state.engine.dispose();
      if (IS_DEV) console.log('[ocr] server rec 复核引擎空闲超时，已释放(90MB)');
    } catch {
      /* 释放失败不影响业务，忽略 */
    }
  }
}

/**
 * 获取（复用）server rec 复核引擎，运行在后台 Web Worker。
 * 与 getPaddleEngine 的唯一区别：recognition 指向 server 版 rec 模型（长数字串识别更准），
 * det / cls 复用 mobile。惰性加载 + 空闲 TTL 释放：只在"含长数字串且 fast 置信度不足"时创建，
 * 并在 SERVER_ENGINE_TTL_MS 无调用后自动 terminate，避免 90MB 模型长期驻留。
 */
export async function getServerRecEngine(): Promise<OcrEngineWorker> {
  // 失败熔断：创建刚失败过则冷却期内直接拒绝，避免反复重载 90MB 模型（#19）
  if (!serverEngineState && serverEngineFailAt && Date.now() - serverEngineFailAt < ENGINE_RETRY_BACKOFF_MS) {
    throw new Error('server 复核引擎初始化刚失败，请稍后再试');
  }
  // 上次使用已超时 → 先释放再按需重建
  if (serverEngineState && Date.now() - serverEngineState.lastUsed > SERVER_ENGINE_TTL_MS) {
    await disposeServerEngine();
  }
  if (!serverEngineState) {
    const opts: OcrEngineOptions = {
      models: {
        detection: PPOCR_DET_URL,
        recognition: PPOCR_REC_SERVER_URL,
        classification: PPOCR_CLS_URL,
      },
      dictionary: PPOCR_DICT_URL,
      runtime: 'wasm',
      wasmPaths: ORT_WASM_ROOT,
      numThreads: 4,
    };
    if (IS_DEV) console.log('[ocr] 初始化 server rec 复核引擎（后台 Worker，本地加载 server 版 rec 模型）…');
    const engine = await (async () => {
      const worker = new Worker(new URL('@ocr-web/core/worker', import.meta.url), { type: 'module' });
      return OcrEngineWorker.create({ worker, ...opts });
    })().catch((e) => {
      console.error('[ocr] server rec 复核引擎初始化失败', e);
      serverEngineFailAt = Date.now(); // 记录失败时间用于熔断退避
      throw e;
    });
    serverEngineState = { engine, lastUsed: Date.now() };
  }
  serverEngineState.lastUsed = Date.now();
  // 刷新空闲释放计时器
  if (serverEngineTimer) clearTimeout(serverEngineTimer);
  serverEngineTimer = setTimeout(() => {
    void disposeServerEngine();
  }, SERVER_ENGINE_TTL_MS);
  return serverEngineState.engine;
}

/**
 * 以限流并发方式对 items 依次调用 fn（并发上限限制为 limit）。
 * 不依赖底层 worker 线程安全的假设，温和并行使多行长数字串复核整体更快（#4）。
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 视为"长数字串待复核"的最小连续位数（覆盖订单号 / 流水号 / 单号等场景） */
export const LONG_DIGIT_RUN = 8;
/** 裁剪复核区域时的四周外扩像素，给 server rec 足够的上下文避免裁到字边 */
export const REVIEW_PAD = 6;

/** 判断一行文本是否恰好是整个为纯 8 位紧凑日期（如 20260927 → 2026-09-27）。
 *  这类串更可能是日期而非订单号，排除后可避免误拉 90MB server 复核模型。纯函数，可单测。 */
export function isCompactDate(text: string): boolean {
  return /^\d{4}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(String(text));
}

/** 判断一行文本是否含有需 server 复核的长数字串（连续 ≥LONG_DIGIT_RUN 位）。纯函数，可单测。
 *  若整行恰为纯 8 位紧凑日期（如 20260927）则视为日期而非订单号，不触发复核。 */
export function needsServerReview(text: string): boolean {
  const s = String(text);
  if (!/\d{8,}/.test(s)) return false;
  // 纯 8 位 YYYYMMDD：多属日期，跳过复核，避免为它白白加载 90MB server 模型
  if (isCompactDate(s)) return false;
  return true;
}

/**
 * fast(mobile) 行置信度阈值：fast 识别置信度 ≥ 该值视为"可信，不触发 server 复核"。
 * 理由：mobile 对常规票据已足够准确（实测 28 位订单号可完整识别），若每行长数字串都复核，
 * 每次识别都会白等 ~5-8s 的 server 推理；仅当 fast 置信度不足（疑似识别不可靠/错位）时才用
 * server 兜底，兼顾「常用图片快速」与「疑难长串准确」。
 */
export const SERVER_REVIEW_CONFIDENCE = 0.6;

/**
 * 判断某行是否需要 server 复核：含长数字串（≥8 位）且 fast 识别置信度不足。
 * 只有当 fast 对长串把握不足时才复核，避免"已识别正确却仍白跑一次 server"的无效等待。
 * 纯函数，可单测。
 */
export function shouldServerReview(text: string, confidence: number): boolean {
  return needsServerReview(text) && confidence < SERVER_REVIEW_CONFIDENCE;
}

/** 计算文本中最长的连续数字位数（用于对比 fast 结果与 server 复核结果哪个数字串更完整）。纯函数，可单测。 */
export function longestDigitRun(text: string): number {
  const s = String(text);
  let best = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

/**
 * 在 fast(mobile) 与 server 复核两版文本间择优：server rec 对长数字串更可靠，
 * 故优先采纳"连续数字位更长"的版本；等长时优先保留"非数字内容更完整"的一方——
 * 避免 server 把一个带上下文的订单号（如 订单号12345678）识别成纯串（12345678）导致丢中文；
 * 非数字部分仍相持则保留总长更长、信息更全者；最后默认保留 fast 结果（保守不回退）。
 * 纯函数，可单测。
 */
export function pickBestDigitText(mobile: string, server: string): string {
  const mRun = longestDigitRun(mobile);
  const sRun = longestDigitRun(server);
  if (sRun > mRun) return server;
  if (mRun > sRun) return mobile;
  const nonDigitLen = (t: string) => {
    let n = 0;
    for (const ch of String(t)) if (ch < '0' || ch > '9') n += 1;
    return n;
  };
  const mND = nonDigitLen(mobile);
  const sND = nonDigitLen(server);
  if (sND > mND) return server;
  if (mND > sND) return mobile;
  // 非数字内容一样多：保留总长更长的一版；仍相持则保留 fast（更偏向带上下文的原结果）
  return mobile.length >= server.length ? mobile : server;
}

/** 把 server 复核结果的多条 line 合并成单行文本（复核区域通常是单行，按序拼接）。纯函数，可单测。 */
export function consolidateVerifiedText(lines: OcrLine[]): string {
  if (!lines || lines.length === 0) return '';
  return lines.map((l) => String(l.text ?? '').trim()).filter(Boolean).join(' ');
}

/** 把各类 image 输入统一解码为"全尺寸像素 canvas"（识别框坐标为相对该原图的坐标） */
async function fullSizeCanvas(
  image: Blob | ImageData | ImageBitmap | HTMLCanvasElement | OffscreenCanvas
): Promise<HTMLCanvasElement | null> {
  let bmp: ImageBitmap | null = null;
  let drawable: unknown = null;
  let w = 0;
  let h = 0;
  if (image instanceof Blob) {
    if (typeof createImageBitmap !== 'function') return null;
    bmp = await createImageBitmap(image);
    drawable = bmp;
    w = bmp.width;
    h = bmp.height;
  } else if (image instanceof ImageData) {
    drawable = image;
    w = image.width;
    h = image.height;
  } else if (image instanceof HTMLCanvasElement || (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas)) {
    drawable = image;
    w = image.width;
    h = image.height;
  } else if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
    drawable = image;
    w = image.width;
    h = image.height;
  } else {
    return null;
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(drawable as CanvasImageSource, 0, 0);
    return canvas;
  } finally {
    bmp?.close();
  }
}

/**
 * 从识别源图按检测框（原图像素坐标）裁剪出复核区域，四周外扩 REVIEW_PAD 像素并夹取在图像范围内。
 * 返回裁剪后的 canvas（可直接喂给 server 复核引擎）；任一环节失败返回 null，不阻断流程。
 */
export async function extractRegion(
  image: Blob | ImageData | ImageBitmap | HTMLCanvasElement | OffscreenCanvas,
  box: Quad,
  padding: number = REVIEW_PAD
): Promise<HTMLCanvasElement | null> {
  try {
    const src = await fullSizeCanvas(image);
    if (!src) return null;
    const xs = box.map((p) => p[0]);
    const ys = box.map((p) => p[1]);
    const minX = Math.max(0, Math.floor(Math.min(...xs)) - padding);
    const minY = Math.max(0, Math.floor(Math.min(...ys)) - padding);
    const maxX = Math.min(src.width, Math.ceil(Math.max(...xs)) + padding);
    const maxY = Math.min(src.height, Math.ceil(Math.max(...ys)) + padding);
    const w = maxX - minX;
    const h = maxY - minY;
    if (w < 1 || h < 1) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // 平滑重采样，避免裁剪/缩放时字迹发虚
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, minX, minY, w, h, 0, 0, w, h);
    return canvas;
  } catch (e) {
    console.error('[ocr] 裁剪复核区域失败', e);
    return null;
  }
}

/**
 * server 复核二次增强：mobile 全图识别后，仅对「含长数字串（订单号/单号）且 fast 置信度不足」的行，
 * 按检测框从原图裁剪出该区域，再用 server rec 模型复核，择优替换该行文本。
 * fast 已可靠的常规行不做改动；常见图片（fast 均已可信）甚至不会加载 server 引擎，
 * 从而避免"每次识别都白等 5-8s 复核"的无效开销（底线约定 1.5 分钟内完成）。
 * 返回复核（替换）后的行数组。
 */
async function reviewLongDigitLines(
  image: Blob | ImageData | ImageBitmap | HTMLCanvasElement | OffscreenCanvas,
  lines: OcrLine[]
): Promise<OcrLine[]> {
  // 仅长数字串且 fast 置信度不足的行才需要复核
  const targets = lines.filter((l) => shouldServerReview(l.text ?? '', l.confidence));
  if (targets.length === 0) return lines;
  const serverEngine = await getServerRecEngine();
  const out = [...lines];
  const tA = performance.now();
  // 并行复核（限流 SERVER_REVIEW_CONCURRENCY）：裁剪 + server 推理对每个目标行独立，
  // 用 mapLimit 温和并发（不依赖 worker 线程安全假设），比逐行串行更快（#4）。
  const results = await mapLimit(targets, SERVER_REVIEW_CONCURRENCY, async (line) => {
    const crop = await extractRegion(image, line.box);
    if (!crop) return null;
    let verify;
    try {
      verify = await serverEngine.recognize(crop, REVIEW_OCR_OPTIONS);
    } catch (e) {
      console.error('[ocr] server 复核该行失败，保留 fast 结果', e);
      return null;
    }
    const serverText = consolidateVerifiedText(verify.lines);
    // 仅当复核结果确实包含长数字串才替换，避免用空/拆散文本覆盖 fast 结果
    if (!needsServerReview(serverText)) return null;
    const better = pickBestDigitText(line.text ?? '', serverText);
    if (better === line.text) return null;
    return {
      better,
      conf: verify.lines.length ? Math.max(...verify.lines.map((l) => l.confidence)) : line.confidence,
    };
  });
  // 按原有行序回写替换结果
  let reviewed = 0;
  results.forEach((res, k) => {
    if (!res) return;
    const line = targets[k];
    const idx = lines.indexOf(line);
    out[idx] = {
      ...line,
      text: res.better,
      confidence: Math.max(line.confidence, res.conf),
    };
    reviewed += 1;
  });
  const tB = performance.now();
  if (IS_DEV) console.log(`[ocr] server 复核完成，共 ${targets.length} 行长数字串待复核（均 fast 置信度不足），实际替换 ${reviewed} 行，耗时 ${Math.round(tB - tA)}ms`);
  return out;
}

/** 按版面合并同水平行 + 版面清洗，把检测行数组组合成最终识别文本（纯函数，可单测）。 */
export function composeOcrText(lines: OcrLine[]): string {
  if (!lines || lines.length === 0) return '';
  return layoutCleanText(mergeOcrLinesByY(lines).join('\n'));
}

/** recognizeImage 的可选参数 */
export interface RecognizeOptionsEx {
  /** 在各阶段间中止（连续拖入多张图时取消上一次识别）。底层 recognize 单次不可中断。 */
  signal?: AbortSignal;
  /** 异步补发复核（#6）：为 true 时立即返回 fast 文本，server 复核在后台进行，
   *  完成后通过 onRefined 补发精化文本；默认 false 保持同步（等复核完成才返回）。
   *  用于尝试缓解 server 引擎冷启动对首张图识别耗时的等待。 */
  deferReview?: boolean;
  /** 配合 deferReview 使用：后台复核结束后（若非空差异）回调补发精化文本。 */
  onRefined?: (refinedText: string) => void;
}

/**
 * 对本机图片执行 OCR，返回归一化后的识别文本。
 * @param image 本地图片文件（Blob）或可被识别的二进制数据；lang 参数兼容旧签名但被忽略
 * @param options 可选参数，见 RecognizeOptionsEx。默认同步返回含复核的完整文本，调用方行为不变。
 * @returns 识别出的纯文本（已过 layoutCleanText 清洗，但尚未脱敏）
 */
export function recognizeImage(
  image: Blob | ImageData | ImageBitmap | HTMLCanvasElement | OffscreenCanvas,
  _lang?: string,
  options?: RecognizeOptionsEx
): Promise<string> {
  return (async () => {
    const { signal, deferReview = false, onRefined } = options ?? {};
    const t0 = performance.now();
    throwIfAborted(signal, '等待引擎');
    const engine = await getPaddleEngine();
    const t1 = performance.now();
    throwIfAborted(signal, '识别推理');
    const result = await engine.recognize(image, DEFAULT_PPOCR_OPTIONS);
    const t2 = performance.now();
    // fast 文本（按版面合并 + 清洗，尚未做 server 复核）
    const fastText = composeOcrText(result.lines);

    if (deferReview) {
      // 异步补发模式：先返回 fast，复核完成后再用 onRefined 补发精化文本（#6）
      if (IS_DEV) console.log(`[ocr] 快速识别完成（复核异步补发），识别推理 ${Math.round(t2 - t1)}ms，文本长度 ${fastText.length}`);
      if (onRefined) {
        void (async () => {
          try {
            throwIfAborted(signal, 'server复核');
            const reviewedLines = await reviewLongDigitLines(image, result.lines);
            throwIfAborted(signal, '后处理合并');
            const refined = composeOcrText(reviewedLines);
            if (refined !== fastText) onRefined(refined);
          } catch (e) {
            // 异步复核失败或被取消：静默保留 fast 结果，不打扰用户
            if (IS_DEV) console.log('[ocr] 异步 server 复核未补发', (e as Error)?.message ?? e);
          }
        })();
      }
      return fastText;
    }

    // 默认同步：等 server 复核完成后再返回（调用方行为不变）
    throwIfAborted(signal, 'server复核');
    const reviewedLines = await reviewLongDigitLines(image, result.lines);
    const tR = performance.now();
    throwIfAborted(signal, '后处理合并');
    const text = composeOcrText(reviewedLines);
    const t3 = performance.now();
    // 仅在开发/测试环境输出耗时分解，生产不刷屏、不透出内部推理细节（#8）
    if (IS_DEV) console.log('[ocr] PP-OCR 识别完成，耗时分解 ms:', {
      等待引擎: Math.round(t1 - t0),
      识别推理: Math.round(t2 - t1),
      server复核: Math.round(tR - t2),
      后处理合并: Math.round(t3 - tR),
      总计: Math.round(t3 - t0),
      行数: result.lines.length,
      合并后行数: text.split('\n').length,
      文本长度: text.length,
    });
    return text;
  })();
}

/** 识别非空判空/用错误信息组装统一提示（供 UI 直接展示） */
export function ocrEmptyHint(): string {
  return '未识别到文字，请更换更清晰的图片重试';
}

/**
 * 版面感知清洗：保留连续空格（还原右对齐版式），仅剔除控制字符与冗余空行。
 * 与 normalizeOcrText（压缩行内空白）不同——识别结果需要保留
 * "伊利安慕希酸奶      ¥32.20"这类由 mergeOcrLinesByY 还原的左右对齐版面。
 * （#17）薄封装 cleanText{applyLayout}。
 */
export function layoutCleanText(raw: string): string {
  return cleanText(raw, { applyLayout: true });
}