/**
 * 版本同步脚本（单一来源：package.json）
 * ---------------------------------------------------------------------------
 * 双轨制（用户确认的版本方案）：
 *   - 对外版本：V{MAJOR}.{MINOR}.{PATCH}        正式发布用（三段式）
 *   - 内部构建：V{MAJOR}.{MINOR}.{PATCH}.{BUILD}（测试）  每次构建递增，永不回退
 *
 * 唯一源：package.json 的 `version`（三段）+ `build`（构建号）+ `channel`（stable/test）。
 * 本脚本把版本同步到以下位置，保证「全应用只显示同一个版本」：
 *   1) src-tauri/Cargo.toml        → version = "x.y.z"（Cargo 只接受三段 SemVer）
 *   2) src-tauri/tauri.conf.json   → "version": "x.y.z"（安装包/关于页读取）
 *   3) src/lib/appVersion.ts       → 自动生成的应用内版本常量（前端展示的唯一来源）
 *
 * 用法：
 *   npm run version:sync            # 手动同步（改完 package.json 后）
 *   npm run version:test            # 内部测试构建：build+1、channel=test，并自动同步
 *   npm run release:patch|minor|major  # 正式发布：三段递增、channel=stable，并自动同步
 *
 * 铁律（与方案一致）：
 *   - BUILD 只增不减（正式发布不重置 BUILD，仅不展示）；
 *   - 测试渠道标识（channel=test）永不进正式发布（release 脚本会强制清掉）；
 *   - 版本号单一来源，任何其它文件都不允许手改版本。
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

/** 项目根目录（本脚本位于 <root>/scripts/ 下） */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CHANGE_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * 读取并校验 package.json 的版本三件套。
 * 任何非法值立即抛错终止——坏版本号一旦同步进安装包，排查成本极高。
 */
function readSource() {
  const pkgPath = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version = String(pkg.version ?? '');
  if (!CHANGE_RE.test(version)) {
    throw new Error(`package.json 的 version 必须是三段数字（x.y.z），当前为「${version}」`);
  }
  const build = Number(pkg.build ?? 0);
  if (!Number.isInteger(build) || build < 0) {
    throw new Error(`package.json 的 build 必须是非负整数，当前为「${pkg.build}」`);
  }
  const channel = String(pkg.channel ?? 'stable');
  if (channel !== 'stable' && channel !== 'test') {
    throw new Error(`package.json 的 channel 只能是 stable / test，当前为「${channel}」`);
  }
  return { pkg, pkgPath, version, build, channel };
}

/** 生成 src/lib/appVersion.ts 的内容（前端唯一版本来源） */
function renderAppVersionTs(version, build, channel) {
  return `/**
 * 应用版本（唯一来源：根目录 package.json 的 version / build / channel）
 * ---------------------------------------------------------------------------
 * 本文件由 scripts/sync-version.mjs 自动生成，请勿手改。
 * 修改版本请使用：
 *   npm run version:test             内部测试构建（第四段 +1，显示「（测试）」）
 *   npm run release:patch|minor|major 正式发布（三段递增，去掉第四段）
 *
 * 双轨制：对外版本 = V{MAJOR}.{MINOR}.{PATCH}；内部构建 = V{...}.{BUILD}（测试）。
 * 用户可见处只显示三段（测试版加「（测试）」标识，避免误用半成品）。
 */
export const APP_VERSION = '${version}';
export const APP_BUILD = ${build};
export const APP_CHANNEL: 'stable' | 'test' = '${channel}';

/** 用户可见版本号：正式版 V1.0.0；测试版 V1.0.0.1（测试） */
export function formatAppVersion(): string {
  return APP_CHANNEL === 'test' ? \`V\${APP_VERSION}.\${APP_BUILD}（测试）\` : \`V\${APP_VERSION}\`;
}

/** 诊断/日志用完整版本（含渠道与构建号，仅在开发者可见处使用） */
export function fullAppVersion(): string {
  return \`V\${APP_VERSION}+build.\${APP_BUILD}（\${APP_CHANNEL}）\`;
}
`;
}

/**
 * 把三段版本写入指定文件的第一个目标位置（文本级替换，不重排文件其它内容）。
 * pattern 必须精确匹配该文件中的版本声明行，未命中即抛错（宁可失败也不静默漏同步）。
 */
function replaceOnce(filePath, pattern, replacement, label) {
  const src = readFileSync(filePath, 'utf8');
  if (!pattern.test(src)) {
    throw new Error(`未在 ${filePath} 中找到可替换的${label}（版本声明可能被改动）`);
  }
  writeFileSync(filePath, src.replace(pattern, replacement));
}

/** 执行全部同步（供 bump-test / release 脚本复用） */
export function syncAll() {
  const { version, build, channel } = readSource();

  // 1) Cargo.toml：只写三段（Cargo 的 SemVer 不接受第四段）
  replaceOnce(
    join(ROOT, 'src-tauri', 'Cargo.toml'),
    /^(version\s*=\s*")[^"]+(")/m,
    `$1${version}$2`,
    'Cargo 版本'
  );

  // 2) tauri.conf.json：只写三段（安装包/关于页读取）
  replaceOnce(
    join(ROOT, 'src-tauri', 'tauri.conf.json'),
    /("version"\s*:\s*")[^"]+(")/,
    `$1${version}$2`,
    'Tauri 版本'
  );

  // 3) 前端版本常量文件（整文件生成）
  writeFileSync(join(ROOT, 'src', 'lib', 'appVersion.ts'), renderAppVersionTs(version, build, channel));

  const shown = channel === 'test' ? `V${version}.${build}（测试）` : `V${version}`;
  console.log(`[version] 同步完成：${shown}  → Cargo.toml / tauri.conf.json / src/lib/appVersion.ts`);
  return { version, build, channel };
}

// 直接运行（node scripts/sync-version.mjs）时执行；被 import 时不自动执行
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncAll();
}