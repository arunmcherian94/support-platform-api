// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'coverage/', 'data/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // `any` needs a justification comment (CLAUDE.md §10), so the rule stays on.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Unused parameters are allowed when prefixed with `_` (e.g. interface-shaped handlers).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Time comes from the injected clock (src/clock.ts), never the system (S1-6).
    ignores: ['src/clock.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Use the injected Clock (src/clock.ts).' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Use the injected Clock (src/clock.ts).',
        },
        {
          // Date() without `new` returns the current time as a string.
          selector: "CallExpression[callee.name='Date']",
          message: 'Use the injected Clock (src/clock.ts).',
        },
        {
          // globalThis.Date.now() / window.Date.now() bypass the property rule above.
          selector: "MemberExpression[object.property.name='Date'][property.name='now']",
          message: 'Use the injected Clock (src/clock.ts).',
        },
      ],
    },
  },
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
);
