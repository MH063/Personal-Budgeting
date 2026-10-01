import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * vitest 配置：仅为单元测试服务，独立于 vite.config.ts（不引入 react/tailwind 插件），
 * 通过 alias 复用 @ → src 路径，并挂载 setup.ts 为存储与加密提供 Node 环境夹具。
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    globals: false,
  },
});