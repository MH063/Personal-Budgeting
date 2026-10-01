/**
 * 修复 @ocr-web/core 与 PP-OCRv4 识别模型的输入高度不匹配
 * -----------------------------------------------------------------------------
 * 背景：@ocr-web/core 默认按 PP-OCRv5 设计，识别模型输入高度硬编码为 32；
 *      但我们内嵌的是 PP-OCRv4 识别模型，其输入期望高度为 48。
 *      若高度为 32 会导致 onnxruntime 抛
 *      "Got invalid dimensions for input x ... Got: 32 Expected: 48"。
 * 方案：在 npm install 后（postinstall）幂等地把 dist 内的两处 REC_HEIGHT_32 替换为 48，
 *      避免每次重装依赖后需手工改 node_modules。
 * 注意：不得改动其它逻辑，仅替换固定高度常量。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const chunkPath = resolve(
  fileURLToPath(new URL('..', import.meta.url)), // 以 scripts 目录为基准往上一级到项目根
  'node_modules/@ocr-web/core/dist/chunk-5MGQAOZE.js'
);

try {
  const code = readFileSync(chunkPath, 'utf8');
  const replaced = code.replace(/(var REC_HEIGHT = )32/g, '$148').replace(/(var REC_HEIGHT2 = )32/g, '$148');
  if (replaced !== code) {
    writeFileSync(chunkPath, replaced, 'utf8');
    console.log('[patch-ocrcore] 已将 @ocr-web/core 识别高度 32 -> 48（适配 PP-OCRv4 rec）');
  } else {
    console.log('[patch-ocrcore] @ocr-web/core 无需补丁或已打补丁');
  }
} catch (e) {
  // 文件缺失（未安装依赖）时静默，避免 postinstall 报错阻断安装
  console.warn('[patch-ocrcore] 跳过：未找到 @ocr-web/core（', e.message, '）');
  process.exit(0);
}