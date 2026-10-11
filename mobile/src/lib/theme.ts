// light / dark / follow the phone. The colour tokens switch on a `.dark` class (desktop styles) and `.light` forces light.
export type Theme = 'light' | 'dark' | 'system';

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
}
