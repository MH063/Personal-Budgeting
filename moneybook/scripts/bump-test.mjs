/**
 * 内部测试构建：第四段（BUILD）+1，渠道标记为 test，并自动同步到各版本文件。
 * ---------------------------------------------------------------------------
 * 用法：npm run version:test
 * 结果：package.json → version 不变、build+1、channel='test'；
 *       应用内显示「V1.0.0.1（测试）」这样的四段版本（第三段仍是最近一次正式发布号）。
 * 规则：BUILD 只增不减、永不回退（与《版本更新迭代设计》一致）；
 *       测试版永不进 stable 渠道（正式发布时 channel 会被 release 脚本强制清掉）。
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { syncAll } from './sync-version.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const build = Number(pkg.build ?? 0) + 1;
pkg.build = build;
pkg.channel = 'test';

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`[version] 内部测试构建：V${pkg.version}.${build}（测试）`);

// 立即同步到 Cargo / tauri.conf / appVersion.ts，避免应用内显示旧版本
syncAll();