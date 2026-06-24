// ---------------------------------------------------------------------------
// ESLint flat config (ESLint 9+) for the @vectros-ai/react library.
//
// Aligned with the consuming apps' config (ui/admin-app, ui/app-vectros-ai) but
// trimmed for a LIBRARY rather than an HMR-served app:
//   - no `react-refresh` rule (the package isn't served by Vite HMR; its barrel
//     intentionally mixes component + non-component exports);
//   - no `no-restricted-globals` storage guard (that's an app-policy concern;
//     the package never touches browser storage — Amplify owns it).
// Keeps the substantive correctness/a11y rules: typescript-eslint recommended,
// react-hooks, jsx-a11y, consistent-type-imports, and the unused-vars guard.
// ---------------------------------------------------------------------------

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
    },
  },
  {
    // Tests have looser rules — console output, any-types in mocks, etc.
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
