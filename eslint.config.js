// Flat config — root ESLint for the TypeScript workspaces (gateway, admin, packages/*).
// Per-workspace configs may extend this with framework-specific rules (React, etc.).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'apps/engine/**',
      'qa/corpus/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    rules: {
      // Hard rule #1: cleartext PII never in logs. We can't statically prove that,
      // but we can ban console.* in source — all logging goes through the structured
      // logger that strips payload bodies.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
