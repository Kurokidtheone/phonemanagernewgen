import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['*.cjs', '**/*.cjs', 'out/**', 'target/**', 'src-tauri/**', '**/dist/**', '**/node_modules/**', 'mobile/android/**', 'mobile/scripts/**', 'tools/**', 'scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'mobile/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: reactHooks.configs.recommended.rules,
  },
  { files: ['*.config.ts', 'scripts/**/*.mjs'], languageOptions: { globals: globals.node } },
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
);
