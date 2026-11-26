/**
 * Tailwind 配置（位于 config/）。
 *
 * content 用「项目根的绝对路径 + 正斜杠」：Windows 上 fast-glob 不接受反斜杠，
 * 而相对路径会随配置文件位置漂移。写死绝对路径既跨平台又不会因为 cwd 变化失效。
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const fromRoot = (rel) => path.join(projectRoot, rel).replace(/\\/g, '/')

/** @type {import('tailwindcss').Config} */
export default {
  content: [fromRoot('index.html'), fromRoot('src/**/*.{js,ts,jsx,tsx}')],
  theme: {
    extend: {
      colors: {
        ink: '#101828',
        muted: '#667085',
        line: '#E4E7EC',
        canvas: '#F7F8FA',
        brand: {
          50: '#EEF4FF',
          100: '#DCE8FF',
          500: '#2E6BE6',
          600: '#1E54C4',
          700: '#1843A0',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.06)',
        drawer: '-12px 0 40px rgba(16,24,40,.12)',
      },
      fontFamily: {
        sans: ['"Segoe UI"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
