/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)',
        card: 'var(--card)',
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        line: 'var(--line)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
        'accent-faint': 'var(--accent-faint)',
        ok: 'var(--ok)',
        danger: 'var(--danger)',
        action: 'var(--action)',
      },
      fontFamily: { sans: ['"IBM Plex Sans Arabic"', 'system-ui', 'Segoe UI', 'sans-serif'] },
    },
  },
  plugins: [],
};
