/**
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
export const APP_VERSION = '1.2.2';
export const APP_BUILD = 0;
export const APP_CHANNEL: 'stable' | 'test' = 'stable';

/** 用户可见版本号：正式版 V1.0.0；测试版 V1.0.0.1（测试） */
export function formatAppVersion(): string {
  return APP_CHANNEL === 'test' ? `V${APP_VERSION}.${APP_BUILD}（测试）` : `V${APP_VERSION}`;
}

/** 诊断/日志用完整版本（含渠道与构建号，仅在开发者可见处使用） */
export function fullAppVersion(): string {
  return `V${APP_VERSION}+build.${APP_BUILD}（${APP_CHANNEL}）`;
}
