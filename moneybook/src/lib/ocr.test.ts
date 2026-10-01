/**
 * 本地 OCR 文本归一化纯函数单元测试。
 */
import { describe, it, expect } from 'vitest';
import { layoutCleanText, mergeOcrLinesByY, normalizeOcrText, cleanText, composeOcrText, ocrEmptyHint, ocrTargetSize, PADDLE_ASSET_ROOT, PPOCR_DET_URL, PPOCR_REC_URL, PPOCR_CLS_URL, PPOCR_DICT_URL, ORT_WASM_ROOT, needsServerReview, longestDigitRun, pickBestDigitText, consolidateVerifiedText, PPOCR_REC_SERVER_URL, REVIEW_PAD, LONG_DIGIT_RUN, shouldServerReview, SERVER_REVIEW_CONFIDENCE, isCompactDate, REVIEW_OCR_OPTIONS, SERVER_REVIEW_CONCURRENCY, throwIfAborted, ENGINE_RETRY_BACKOFF_MS, computeSha256Hex, verifyModelIntegrity, OCR_MODEL_VERSION, OCR_MODEL_MANIFEST, modelVerificationVerdict } from '@/lib/ocr';

describe('normalizeOcrText：OCR 原始文本清洗', () => {
  it('压缩连续（含全角/制表符）空白为单空格', () => {
    expect(normalizeOcrText('午餐   25元\u3000　\t打车')).toBe('午餐 25元 打车');
  });

  it('剔除控制字符与不可见字符', () => {
    expect(normalizeOcrText('a\u0000\u0007b')).toBe('ab');
  });

  it('压缩连续空行为单换行', () => {
    expect(normalizeOcrText('第一行\n\n\n第二行')).toBe('第一行\n第二行');
  });

  it('去掉行首行尾多余空白并收尾 trim', () => {
    expect(normalizeOcrText('  你好  \n 世界  ')).toBe('你好\n世界');
  });

  it('空串/undefined 返回空串', () => {
    expect(normalizeOcrText('')).toBe('');
    expect(normalizeOcrText(undefined as unknown as string)).toBe('');
    expect(normalizeOcrText(null as unknown as string)).toBe('');
  });

  it('金额净化：纠正数字紧贴人民币符号的误粘（如 3¥32.20 → ¥32.20）', () => {
    // 全角与半角人民币符号都应纠正
    expect(normalizeOcrText('3¥32.20')).toBe('¥32.20');
    expect(normalizeOcrText('3￥61.20')).toBe('￥61.20');
    // 行内正常金额不受影响
    expect(normalizeOcrText('农夫山泉矿泉水 ￥3.50')).toBe('农夫山泉矿泉水 ￥3.50');
    expect(normalizeOcrText('合计￥15.60')).toBe('合计￥15.60');
  });

  it('金额净化：不误伤合法数字衬在金额之前的情形', () => {
    // 数字与 ¥ 之间有空格（如"共4件"），不应被合并删除
    expect(normalizeOcrText('共4件 合计￥61.20')).toBe('共4件 合计￥61.20');
    // 金额带单位"元"而非紧跟人民币符号的两小数格式，不触发
    expect(normalizeOcrText('3元')).toBe('3元');
  });

  it('金额净化：前置边界保护，不误删订单号/编号里的数字（#2）', () => {
    // 订单号后紧跟金额：3¥ 前的 2 是数字，负向前瞻挡住，整串保留
    expect(normalizeOcrText('订单号123¥45.67')).toBe('订单号123¥45.67');
    // 字母结尾的编号：A4¥ 前的 A 挡住，保留
    expect(normalizeOcrText('A4¥19.90')).toBe('A4¥19.90');
    expect(normalizeOcrText('x3¥12.00')).toBe('x3¥12.00');
    // 行首孤立误粘仍被纠正：3¥32.20 → ¥32.20
    expect(normalizeOcrText('3¥32.20')).toBe('¥32.20');
  });

  it('金额净化边界 P0：长订单号/编号紧邻金额时整体保真，不误删数字', () => {
    // 长串订单号（≥8 位）后跟合计金额：订单号与金额都原样保留
    expect(normalizeOcrText('订单号20260928123456789 合计¥68.00')).toBe('订单号20260928123456789 合计¥68.00');
    // 编号后紧跟金额：紧贴 ¥ 的数字前仍是数字（1288），负向前瞻挡住，整串保留
    expect(normalizeOcrText('付款1288¥299.00')).toBe('付款1288¥299.00');
  });

  it('金额净化边界硬化：¥ 紧贴数字串尾部不删任何一位', () => {
    expect(normalizeOcrText('订单号12345678¥45.67')).toBe('订单号12345678¥45.67'); // 8 前是 7 → 挡住，整串保真
    expect(normalizeOcrText('订单号：20260928123456789')).toBe('订单号：20260928123456789'); // 全角冒号 + 长串，不涉金额
  });

  it('金额净化边界硬化：孤立主题幻觉仍修复 + 字母数字前缀不受影响 + 千分位不受影响', () => {
    expect(normalizeOcrText('3¥32.20')).toBe('¥32.20'); // 孤立 3¥ → 删前导（修复仍在）
    expect(normalizeOcrText('A4¥19.90')).toBe('A4¥19.90'); // 字母+数字+¥ → 不误伤
    expect(normalizeOcrText('x3¥12.00')).toBe('x3¥12.00'); // 同上
    expect(normalizeOcrText('¥1,234.56')).toBe('¥1,234.56'); // 千分位逗号 → 不触发净化
    expect(normalizeOcrText('金额:¥0.01')).toBe('金额:¥0.01'); // 最小金额、无整数部分 → 不删
  });
});

describe('mergeOcrLinesByY：按水平线合并被拆分的检测框', () => {
  // box 顺序为 [TL,TR,BR,BL]
  const quad = (x0: number, y0: number, x1: number, y1: number) =>
    [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][];

  it('同一 Y 的商品名与金额两框合并为一行，并按像素间距补空格', () => {
    const lines = [
      { text: '伊利安慕希酸奶', box: quad(10, 60, 70, 88), confidence: 0.9 },
      { text: '¥32.20', box: quad(100, 62, 160, 88), confidence: 0.9 },
    ];
    // 中文 7 字(有效宽 7)，¥32.20 半分宽(6 字符 × 0.5=3) → 总宽120/总有效宽10=12
    // 间隙 30px → round(30/12)=3 空格
    expect(mergeOcrLinesByY(lines as never)).toEqual(['伊利安慕希酸奶   ¥32.20']);
  });

  it('不同 Y 的多行各自独立、保持行序', () => {
    const lines = [
      { text: '快乐购超市', box: quad(50, 10, 98, 34), confidence: 0.9 },
      { text: '农夫山泉矿泉水', box: quad(10, 200, 50, 228), confidence: 0.9 },
      { text: '¥3.50', box: quad(100, 202, 160, 228), confidence: 0.9 },
    ];
    // 快乐购超市 5字(5)，农夫山泉矿泉水 7字(7)，¥3.50 半分宽(5×0.5=2.5)
    // 总宽148 / 总有效宽14.5 = 10.2；农夫与 ¥3.50 间隙 50 → round(50/10.2)=5 空格
    expect(mergeOcrLinesByY(lines as never)).toEqual(['快乐购超市', '农夫山泉矿泉水     ¥3.50']);
  });

  it('空数组返回空数组', () => {
    expect(mergeOcrLinesByY([])).toEqual([]);
  });
});

describe('layoutCleanText：版面感知清洗（保留连续空格）', () => {
  it('保留行内连续空格（右对齐版式），仅剔除控制字符', () => {
    expect(layoutCleanText('伊利安慕希酸奶     ¥32.20')).toBe('伊利安慕希酸奶     ¥32.20');
  });

  it('压缩空行并 trim，不影响行内空格', () => {
    expect(layoutCleanText('  快乐购超市  \n\n\n农夫山泉矿泉水  ¥3.50  ')).toBe('快乐购超市\n农夫山泉矿泉水  ¥3.50');
  });

  it('空串返回空串', () => {
    expect(layoutCleanText('')).toBe('');
  });

  it('日期与时分秒缺空格时补空格', () => {
    expect(layoutCleanText('2026-09-2719:02:40')).toBe('2026-09-27 19:02:40');
    expect(layoutCleanText('支付时间 2026-09-2719:02:40')).toBe('支付时间 2026-09-27 19:02:40');
  });

  it('日期粘连补空格：支持 / 与 . 分隔、不含秒的时间（#11）', () => {
    expect(layoutCleanText('2026/09/2719:02:40')).toBe('2026/09/27 19:02:40');
    expect(layoutCleanText('2026.09.2719:02')).toBe('2026.09.27 19:02');
    expect(layoutCleanText('2026-9-79:02')).toBe('2026-9-7 9:02');
  });

  it('清理行尾孤立箭头与重复右括号', () => {
    expect(layoutCleanText('付款方式 湖北农信储蓄卡(2440)>')).toBe('付款方式 湖北农信储蓄卡(2440)');
    expect(layoutCleanText('银行卡（2440））')).toBe('银行卡（2440）');
    // arrow 前带空格、虚线行尾也应清理
    expect(layoutCleanText('付款方式 湖北农信储蓄卡(2440) >')).toBe('付款方式 湖北农信储蓄卡(2440)');
    expect(layoutCleanText('金额 -----------')).toBe('金额');
  });

  it('清理行首孤立箭头，但不误删带文本前缀的箭头（#15）', () => {
    expect(layoutCleanText('> 商品名')).toBe('商品名');     // 行首孤立箭头+空格 → 剥离
    expect(layoutCleanText('  < 金额 12.5')).toBe('金额 12.5');
    expect(layoutCleanText('>商品名')).toBe('>商品名');     // 箭头紧贴文末无空格 → 视为有效前缀保留
  });
});

describe('ocrTargetSize：识别用目标尺寸（过大缩小 / 过小放大）', () => {
  it('超大图长边缩小到 maxDim', () => {
    expect(ocrTargetSize(2400, 1200, 1600)).toEqual({ width: 1600, height: 800 });
  });

  it('过小图长边放大到 upscaleMin（提升小字清晰度）', () => {
    // 800x600 → 长边放大到 1400
    expect(ocrTargetSize(800, 600, 1600, 1400)).toEqual({ width: 1400, height: 1050 });
  });

  it('尺寸适中（长边在 upscaleMin 与 maxDim 之间）时原样返回', () => {
    // 1450 在 [1400,1600] 之间，不缩小也不放大
    expect(ocrTargetSize(1450, 900, 1600, 1400)).toEqual({ width: 1450, height: 900 });
  });

  it('介于两者之间的边界值（长边==upscaleMin）原样返回', () => {
    expect(ocrTargetSize(1400, 1000, 1600, 1400)).toEqual({ width: 1400, height: 1000 });
  });

  it('非法尺寸原样返回，不崩溃', () => {
    expect(ocrTargetSize(0, 100)).toEqual({ width: 0, height: 100 });
    expect(ocrTargetSize(Number.NaN, 100).width).toBeNaN();
  });
});

describe('ocrEmptyHint：识别为空提示', () => {
  it('返回统一提示文案', () => {
    expect(ocrEmptyHint()).toContain('未识别到文字');
  });
});

describe('PP-OCR 静态资源路径：模型与字典已内嵌于 public/ 可离线加载', () => {
  it('PP-OCR 展开路径均指向本地 public/paddle 且带明确文件名', () => {
    expect(PPOCR_DET_URL).toContain(PADDLE_ASSET_ROOT);
    expect(PPOCR_DET_URL).toContain('ch_PP-OCRv4_det_infer.onnx');
    expect(PPOCR_REC_URL).toContain('ch_PP-OCRv4_rec_infer.onnx');
    expect(PPOCR_CLS_URL).toContain('ch_ppocr_mobile_v2.0_cls_infer.onnx');
    expect(PPOCR_DICT_URL).toContain('ppocr_keys_v1.txt');
  });

  it('PP-OCR wasm 运行时应从本地 public/ort 加载（离线）', () => {
    expect(ORT_WASM_ROOT).toContain('/ort/');
  });
});

describe('cleanText / composeOcrText（#17/#6 重构）', () => {
  it('cleanText 是 normalize 与 layout 的共同管道，二者行为互不串扰', () => {
    // compressSpaces + stripMoneyGlue = normalizeOcrText 语义
    expect(cleanText('午餐   25元\u3000　3¥32.20', { compressSpaces: true, stripMoneyGlue: true }))
      .toBe('午餐 25元 ¥32.20');
    // applyLayout = layoutCleanText 语义（保留空格 + 版面装饰）
    expect(cleanText('  > 支付时间 2026-09-2719:02:40 ', { applyLayout: true }))
      .toBe('支付时间 2026-09-27 19:02:40');
    // 默认（不启用任何项）只剔控制字符 + 压空行 + trim
    expect(cleanText('  a\n\n\nb  ')).toBe('a\nb');
  });

  it('normalizeOcrText 与 layoutCleanText 行为等价于 cleanText 对应模式（薄封装）', () => {
    const raw = '伊利安慕希酸奶     ¥32.20\n支付时间 2026-09-2719:02:40';
    expect(normalizeOcrText(raw)).toBe(cleanText(raw, { compressSpaces: true, stripMoneyGlue: true }));
    expect(layoutCleanText(raw)).toBe(cleanText(raw, { applyLayout: true }));
  });

  it('composeOcrText：把检测行合并并按版面清洗成最终文本', () => {
    const lines = [
      { text: '伊利安慕希酸奶', box: [[10, 60], [70, 60], [70, 88], [10, 88]] as [number, number][], confidence: 0.9 },
      { text: '¥32.20', box: [[100, 62], [160, 62], [160, 88], [100, 88]] as [number, number][], confidence: 0.9 },
    ];
    expect(composeOcrText(lines as never)).toContain('¥32.20');
    expect(composeOcrText([])).toBe('');
  });
});

describe('throwIfAborted：识别阶段间隙的取消检查（#13）', () => {
  it('signal 未中止时静默通过', () => {
    const ctrl = new AbortController();
    expect(() => throwIfAborted(ctrl.signal)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });

  it('signal 已中止时抛出 AbortError 并带阶段信息', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    try {
      throwIfAborted(ctrl.signal, '识别推理');
      expect.unreachable('应当抛出 AbortError');
    } catch (e) {
      expect((e as Error).name).toBe('AbortError');
      expect((e as Error).message).toContain('识别推理');
    }
  });

  it('引擎初始化失败熔断退避常量存在且为正（#19）', () => {
    expect(ENGINE_RETRY_BACKOFF_MS).toBeGreaterThan(0);
  });
});

describe('server 复核：长数字串检测与择优', () => {
  it('PPOCR_REC_SERVER_URL 指向本地 public/paddle 的 server 版 rec 模型', () => {
    expect(PPOCR_REC_SERVER_URL).toContain(PADDLE_ASSET_ROOT);
    expect(PPOCR_REC_SERVER_URL).toContain('ch_PP-OCRv4_rec_server.onnx');
  });

  it('needsServerReview：连续数字达到 8 位及以上才判定需复核', () => {
    expect(needsServerReview('订单号 20260928123456789')).toBe(true);
    expect(needsServerReview('单号 1234567')).toBe(false); // 7 位：不触发
    expect(needsServerReview('价格 32.50')).toBe(false); // 非长串
    expect(needsServerReview('')).toBe(false);
  });

  it('needsServerReview：整行为纯 8 位紧凑日期时不作为订单号触发（#12）', () => {
    expect(isCompactDate('20260927')).toBe(true);
    expect(isCompactDate('20261301')).toBe(false); // 月 13 非法
    expect(isCompactDate('20260928123456789')).toBe(false); // 过长非日期
    expect(needsServerReview('20260927')).toBe(false); // 纯日期 → 不拉 server 模型
    // 带上下文的长串仍是订单号 → 触发
    expect(needsServerReview('订单号2026092712345678')).toBe(true);
  });

  it('shouldServerReview：长数字串且 fast 置信度不足才复核', () => {
    // 长串 + 置信度不足 → 复核
    expect(shouldServerReview('订单号 20260928123456789', 0.2)).toBe(true);
    // 长串 + fast 已可信 → 跳过复核（避免白等）
    expect(shouldServerReview('订单号 20260928123456789', SERVER_REVIEW_CONFIDENCE)).toBe(false);
    expect(shouldServerReview('订单号 20260928123456789', 0.99)).toBe(false);
    // 非长串 → 不复核
    expect(shouldServerReview('价格 32.50', 0.1)).toBe(false);
    // 空文本 → 不复核
    expect(shouldServerReview('', 0.1)).toBe(false);
  });

  it('longestDigitRun：计算最长连续数字位数', () => {
    expect(longestDigitRun('20260928123456789')).toBe(17);
    expect(longestDigitRun('订单20261102号')).toBe(8);
    expect(longestDigitRun('AB12CD345DEF6789')).toBe(4);
    expect(longestDigitRun('纯文本')).toBe(0);
    expect(longestDigitRun('')).toBe(0);
  });

  it('pickBestDigitText：连续数字串更长的一版胜出', () => {
    // server 复核识别出更完整的订单号 → 采用 server 结果
    expect(pickBestDigitText('订单号2026981234567', '订单号20260928123456789')).toBe('订单号20260928123456789');
    // fast 已完全识别 → 数字串等长时不再回退错位结果
    expect(pickBestDigitText('20260928123456789', '20260928123456789')).toBe('20260928123456789');
    // server 更短（识别失败文本被拆散）→ 保留 fast
    expect(pickBestDigitText('订单号20260928123456789', '订单号2026')).toBe('订单号20260928123456789');
  });

  it('pickBestDigitText：合同步时优先保留非数字内容，避免丢中文（#14）', () => {
    // server 丢了中文"订单号"，只给了纯数字串 → 保留带上下文的 fast
    expect(pickBestDigitText('订单号12345678', '12345678')).toBe('订单号12345678');
    // 数字确实更长的一版仍胜出
    expect(pickBestDigitText('订单号12345678', '订单号20260928123456')).toBe('订单号20260928123456');
  });

  it('复核专用识别参数：禁角度分类、收紧 det/外扩，防止误裁相邻行（#7）', () => {
    expect(REVIEW_OCR_OPTIONS.useClassification).toBe(false);
    expect(REVIEW_OCR_OPTIONS.unclipRatio as number).toBeLessThanOrEqual(1.2);
    expect(REVIEW_OCR_OPTIONS.maxSideLen as number).toBeLessThanOrEqual(640);
  });

  it('复核并发上限为正小值，避免打爆单 worker（#4）', () => {
    expect(SERVER_REVIEW_CONCURRENCY).toBeGreaterThan(0);
    expect(SERVER_REVIEW_CONCURRENCY).toBeLessThanOrEqual(2);
  });

  it('consolidateVerifiedText：多条 server 结果拼接为单行文本', () => {
    expect(consolidateVerifiedText([
      { text: '订单号', box: [[0,0],[4,0],[4,4],[0,4]], confidence: 0.9 },
      { text: '20260928123456789', box: [[8,0],[28,0],[28,4],[8,4]], confidence: 0.99 },
    ])).toBe('订单号 20260928123456789');
    expect(consolidateVerifiedText([])).toBe('');
  });

  it('REVIEW_PAD / LONG_DIGIT_RUN 常量存在且合理', () => {
    expect(REVIEW_PAD).toBeGreaterThan(0);
    expect(LONG_DIGIT_RUN).toBe(8);
  });
});

describe('模型完整性校验（安全基线）', () => {
  it('computeSha256Hex 对已知输入算出稳定哈希', async () => {
    // SHA-256("abc") = ba7816bf...（已知向量）
    expect(await computeSha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('verifyModelIntegrity：未登记返回 null；登记相符 true / 不符 false', async () => {
    expect(await verifyModelIntegrity('not-in-manifest.onnx', 'anything')).toBeNull();
    // 临时登记一个文件名→期望哈希，验证正反例
    const bytes = 'model-bytes';
    const hash = await computeSha256Hex(bytes);
    OCR_MODEL_MANIFEST['fake.onnx'] = hash;
    try {
      expect(await verifyModelIntegrity('fake.onnx', bytes)).toBe(true);
      expect(await verifyModelIntegrity('fake.onnx', 'tampered')).toBe(false);
    } finally {
      delete OCR_MODEL_MANIFEST['fake.onnx']; // 恢复，避免污染其他用例
    }
  });

  it('OCR_MODEL_VERSION 存在以便运营标识', () => {
    expect(OCR_MODEL_VERSION.length).toBeGreaterThan(0);
  });

  it('OCR_MODEL_MANIFEST 已登记全部内置模型哈希，且为合法 64 位十六进制', () => {
    // 内置模型清单应覆盖 ocr 引用的所有模型/字典
    expect(OCR_MODEL_MANIFEST['ch_PP-OCRv4_det_infer.onnx']).toBeTruthy();
    expect(OCR_MODEL_MANIFEST['ch_PP-OCRv4_rec_infer.onnx']).toBeTruthy();
    expect(OCR_MODEL_MANIFEST['ch_PP-OCRv4_rec_server.onnx']).toBeTruthy();
    expect(OCR_MODEL_MANIFEST['ch_ppocr_mobile_v2.0_cls_infer.onnx']).toBeTruthy();
    expect(OCR_MODEL_MANIFEST['ppocr_keys_v1.txt']).toBeTruthy();
    for (const h of Object.values(OCR_MODEL_MANIFEST)) {
      expect(h).toMatch(/^[0-9a-f]{64}$/); // 小写 64 位 hex
    }
  });

  it('校验失败路径可判定：哈希不符→mismatch、模型缺失→missing、都不缺→ok', () => {
    expect(modelVerificationVerdict(true, [{ file: 'a', present: true, matched: true }]).status).toBe('ok');
    // 哈希不符（被篡改）→ mismatch
    const mismatch = modelVerificationVerdict(true, [{ file: 'a.onnx', present: true, matched: false }]);
    expect(mismatch.status).toBe('mismatch');
    expect(mismatch.bad.map((c) => c.file)).toEqual(['a.onnx']);
    // 文件缺失 → missing
    expect(modelVerificationVerdict(true, [{ file: 'b.onnx', present: false, matched: false }]).status).toBe('missing');
    // 资源目录不可用（开发模式）→ unavailable
    expect(modelVerificationVerdict(false, []).status).toBe('unavailable');
    // 有目录但无清单项 → not_configured
    expect(modelVerificationVerdict(true, []).status).toBe('not_configured');
  });
});