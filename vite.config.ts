import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  // 相对路径：便于后续作为 Tauri 2 的 frontendDist 直接复用
  base: './',
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  // 安全：dev server 只绑定回环。Vite 5 / esbuild 的已知开发服务器漏洞
  // （任意站点可发请求读响应、optimized deps .map 路径穿越）影响范围是「可被访问到的 dev server」，
  // 绑定 127.0.0.1 后外部站点无法直连；生产构建产物 dist/ 不包含 dev server（见 ADR-017）。
  server: { host: '127.0.0.1', port: 5180, strictPort: false },
  preview: { host: '127.0.0.1', port: 5180, strictPort: false },
  // 把构建/测试缓存留在项目内，避免写入系统临时目录时被沙箱拒绝
  cacheDir: './node_modules/.vite-cache',
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.mjs'],
    // 当前环境的 fs 代理不允许多个 worker 同时写 SSR 转换缓存，改为顺序执行
    fileParallelism: false,
  },
})
