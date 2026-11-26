/**
 * ESLint 扁平配置（ESLint 9）· 位于 config/，由 `npm run lint` 用 --config 指定。
 *
 * 分三层：
 *  1. TS/TSX：保留 hooks 规则与 no-explicit-any；`no-undef` 关闭（类型系统已覆盖）；
 *  2. Node 侧 .mjs（server / scripts / tests / config）：Node 全局，允许 console；
 *  3. 忽略构建产物与本地产物。
 *
 * 配置搬进子目录后，glob 的相对基准会随 cwd 与文件位置漂移：
 * 这里统一用 `basePath` 把基准钉在项目根，所有 `files` / `ignores` 都写相对项目根的路径。
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

export default tseslint.config(
  // 全局忽略必须是「只有 ignores 的对象」，否则不生效
  {
    basePath: projectRoot,
    ignores: ['dist/**', 'node_modules/**', 'data/**', 'coverage/**', 'public/**', '.tmp/**', '.evidence/**', 'docs/**'],
  },
  {
    basePath: projectRoot,
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  { ...js.configs.recommended, basePath: projectRoot },
  ...tseslint.configs.recommended.map((c) => ({ ...c, basePath: projectRoot })),
  {
    basePath: projectRoot,
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
    basePath: projectRoot,
    files: ['server/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.{ts,mjs}', 'config/**/*.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-undef': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    basePath: projectRoot,
    files: ['tests/**/*.{ts,mjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
)
