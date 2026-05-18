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
  // Phase 25 G2.9: the Anthropic SDK must only be imported from the
  // gateway's egress wrapper. Any other importer (a future feature, a
  // scan-module helper, a test fixture) would short-circuit the
  // ZDR / probe / audit / spend-cap pipeline.
  //
  // Two layers:
  //   1. Broad ban across apps/gateway/src/**/*.ts (this rule block).
  //   2. Targeted exemption for the wrapper files (next block).
  // Plus scripts/check-anthropic-boundary.sh runs in CI as a belt-and-
  // braces check that survives even if ESLint is skipped.
  {
    files: ['apps/gateway/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/sdk',
              message:
                'Import Anthropic only from apps/gateway/src/anthropic/. The egress wrapper is the only path to api.anthropic.com.',
            },
          ],
          patterns: [
            {
              group: ['@anthropic-ai/sdk/*'],
              message:
                'Subpath imports of @anthropic-ai/sdk are also restricted to the egress wrapper.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/gateway/src/anthropic/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
