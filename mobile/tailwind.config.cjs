/** Same tokens as the desktop app (see src/renderer/src/styles.css). */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)', card: 'var(--card)', ink: 'var(--ink)', muted: 'var(--muted)', line: 'var(--line)',
        accent: 'var(--accent)', 'accent-soft': 'var(--accent-soft)', 'accent-faint': 'var(--accent-faint)',
        ok: 'var(--ok)', danger: 'var(--danger)', action: 'var(--action)',
      },
      fontFamily: { sans: ['system-ui', '"Noto Sans Arabic"', 'Roboto', 'sans-serif'] },
      minHeight: { touch: '48px' },
      minWidth: { touch: '48px' },
    },
  },
  plugins: [],
};
