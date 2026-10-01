/**
 * 正式发布：三段版本号按规则递增，渠道重置为 stable，并自动同步到各版本文件。
 * ---------------------------------------------------------------------------
 * 用法：npm run release:patch | release:minor | release:major
 * 递增规则（与《版本更新迭代设计》一致）：
 *   patch → x.y.z+1（Bug 修复，向后兼容）
 *   minor → x.(y+1).0（新增功能，向后兼容）
 *   major → (x+1).0.0（破坏性变更 / 架构重构）
 * 规则：BUILD 只增不减——正式发布不重置构建号，只是对外不再展示第四段；
 *       发布后建议按「Git 策略」打 tag（tag 与 package.json 版本一致）：
 *         git tag v1.0.1 && git push origin v1.0.1
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { syncAll } from './sync-version.mjs';

const PART = process.argv[2];
if (!['patch', 'minor', 'major'].includes(PART)) {
  console.error('[version] 用法：node scripts/release.mjs <patch|minor|major>');
  process.exit(1);
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(pkg.version ?? ''));
if (!m) {
  console.error(`[version] package.json 的 version 不是三段数字：${pkg.version}`);
  process.exit(1);
}
let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
if (PART === 'patch') patch += 1;
if (PART === 'minor') { minor += 1; patch = 0; }
if (PART === 'major') { major += 1; minor = 0; patch = 0; }

pkg.version = `${major}.${minor}.${patch}`;
pkg.channel = 'stable'; // 正式发布强制清掉测试标识

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`[version] 正式发布：V${pkg.version}（构建号保留为 build ${pkg.build ?? 0}，对外不展示）`);

syncAll();
console.log(`[version] 建议打 tag：git tag v${pkg.version} && git push origin v${pkg.version}`);