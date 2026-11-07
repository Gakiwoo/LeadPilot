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
  server: { port: 5180, strictPort: false },
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
