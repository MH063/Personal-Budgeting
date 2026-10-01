import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import fs from 'node:fs';

// vite.config.ts 以 ESM 加载，用 process.cwd()（运行 vite 的目录即项目根）定位 ort 目录
const ortDir = path.resolve(process.cwd(), 'ort');

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  // onnxruntime-web 运行时会对 ort 目录下的 .mjs 做动态 import（构造 /ort/x.mjs 后 import()）。
  // 这类 .mjs 若放 public 会被 Vite 改写为 `?import` 请求而 ERR_ABORTED，放构建根则被 SPA fallback
  // 劫持成 HTML。故用 configureServer 中间件在 history fallback 之前直接以文件内容 + JS 类型返回，
  // 保证 onnxruntime 能拿到真实模块用于本地 WASM 推理（完全离线，走 /ort/ 路径）。
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '').split('?')[0];
      if (url.startsWith('/ort/')) {
        const name = url.slice('/ort/'.length);
        const file = path.join(ortDir, name);
        // 仅放行白名单文件，避免中间件劫持其它 /ort/ 请求
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.setHeader('Content-Type', name.endsWith('.mjs') ? 'application/javascript' : 'application/wasm');
          fs.createReadStream(file).pipe(res);
          return;
        }
      }
      next();
    });
  },
  // onnxruntime-web / @ocr-web/core 内部会按运行模式动态 import wasm 后端的 .mjs 壳，
  // 保持其为预打包排除对象，确保 Vite 不额外改写其加载逻辑。
  optimizeDeps: { exclude: ['onnxruntime-web', '@ocr-web/core'] },
  assetsInclude: ['**/*.onnx', '**/*.wasm'],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // host: true 监听全部网卡（0.0.0.0），本机 IP 不固定时任意可达；用网卡 IP 访问避免回环被代理接管
    host: true,
    // 忽略 OCR 临时解压目录与语言包资源，避免 Vite 监视被锁文件（.gz）抛 EBUSY 导致 dev server 崩溃
    // 忽略 src-tauri：Rust 编译产物（moneybook_lib.dll 等）写入时被进程锁定，
    // Vite 监视会抛 EBUSY 崩溃并使 tauri dev 中断（Tauri 官方模板同款处理）
    watch: {
      ignored: ['**/.tess_tmp/**', '**/public/tess/**', '**/src-tauri/**'],
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
});