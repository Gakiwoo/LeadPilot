/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
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
