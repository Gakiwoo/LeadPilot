/**
 * ESLint 扁平配置（ESLint 9）。
 *
 * 分三层：
 *  1. TS/TSX：保留 hooks 规则与 no-explicit-any；`no-undef` 关闭（类型系统已覆盖）；
 *  2. Node 侧 .mjs（server / scripts / tests）：Node 全局，允许 console；
 *  3. 忽略构建产物与本地产物。
 *
 * 注意：`no-console` 在 Node 侧关闭 —— 服务端日志是刻意保留的；
 * 前端侧设为 warn，提醒改用 UI 提示而不是控制台。
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  // 全局忽略必须是「只有 ignores 的对象」，否则不生效
  {
    ignores: [
      'dist/**', 'node_modules/**', 'data/**', 'coverage/**',
      'public/**', '.tmp/**', '.evidence/**', 'docs/**',
    ],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['server/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.{ts,mjs}', 'vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-undef': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['tests/**/*.{ts,mjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
)
