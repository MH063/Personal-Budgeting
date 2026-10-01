/**
 * 暗色模式文字前景修复的回归测试。
 * -----------------------------------------------------------------------------
 * 背景：主色文字此前用深蓝 `#1e6fa9`（text-[var(--color-primary)]），在暗色深底
 * 上对比度不足导致按钮/链接文字看不清。修复方案：新增前景变量
 * `--color-primary-fg`——浅色沿用主色、暗色用更亮的 `#6fc0f0`，并将各文字按钮统一
 * 改用该前景变量。
 * 本测试属于「防回归」护网：断言暗色覆盖存在且更亮、以及相关组件未回退到旧的
 * 深蓝文字写法。纯源码文本校验，不依赖运行环境。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = process.cwd();
const OLD_TEXT_PRIMARY = 'text-[var(--color-primary)]';
const NEW_TEXT_PRIMARY_FG = 'text-[var(--color-primary-fg)]';
/** 浅色默认主色前景（与 @theme 中的 --color-primary-fg 一致） */
const LIGHT_FG = '#1e6fa9';
/** 暗色下的更亮前景 */
const DARK_FG = '#6fc0f0';

function readSource(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8');
}

/** 解析 #RRGGBB 为人眼近似亮度（0~255，越大越亮） */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return r * 0.299 + g * 0.587 + b * 0.114;
}

/** 已统一改用前景变量的组件/页面文件 */
const REPLACED_FILES = [
  'src/pages/Trash/TrashPage.tsx',
  'src/pages/Settings/TagManage.tsx',
  'src/components/layout/LedgerSwitcher.tsx',
  'src/components/transaction/OcrModal.tsx',
  'src/pages/Settings/AISetting.tsx',
  'src/components/transaction/TransactionList.tsx',
  'src/components/ui/select.tsx',
  'src/pages/Settings/ImportManage.tsx',
  'src/components/ui/button.tsx',
  'src/components/layout/CopyLedgerWizard.tsx',
  'src/components/account/AccountCard.tsx',
  'src/components/account/HoldingsModal.tsx',
];

describe('暗色模式文字前景变量（--color-primary-fg）定义', () => {
  it('浅色默认前景沿用主色', () => {
    const css = readSource('src/index.css');
    expect(css).toContain(`--color-primary-fg: ${LIGHT_FG};`);
  });

  it('暗色覆盖了更亮的前景，确保与深底对比充足', () => {
    const css = readSource('src/index.css');
    expect(css).toContain(`--color-primary-fg: ${DARK_FG};`);
    expect(DARK_FG).not.toBe(LIGHT_FG);
    // 暗色前景的亮度必须严格高于浅色默认，才足以在深色卡片上可读
    expect(luminance(DARK_FG)).toBeGreaterThan(luminance(LIGHT_FG));
  });
});

describe('文字按钮统一改用前景变量（防回退到旧的深蓝写法）', () => {
  it.each(REPLACED_FILES)('%s 不再使用深蓝文字写法且已改用前景变量', (rel) => {
    const src = readSource(rel);
    expect(src).not.toContain(OLD_TEXT_PRIMARY);
    expect(src).toContain(NEW_TEXT_PRIMARY_FG);
  });
});