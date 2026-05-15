/**
 * Built-in policies. BUILD_PLAN §10 names four:
 *   - cpa-bookkeeping-strict
 *   - cpa-bookkeeping-balanced
 *   - tax-research
 *   - internal-only
 *
 * Plus the addendum's:
 *   - cpa-converter-output
 *
 * These are seeded into vs_policies on first boot and are read-only
 * from the admin UI (clones with new names are how operators
 * customize).
 */

import type { PolicyConfig } from './schema.js';

export const STRICT_BOOKKEEPING: PolicyConfig = {
  name: 'cpa-bookkeeping-strict',
  reid: {
    mode: 'partial',
    allowed_entity_types: ['EMAIL_ADDRESS', 'PHONE_NUMBER'],
    per_role_overrides: { partner: 'full' },
  },
  allowed_models: [
    'claude-sonnet-4-6',
    'claude-sonnet-4-6-20251001',
    'claude-haiku-4-5-20251001',
  ],
  allowed_apps: ['mybooks', 'trial-balance'],
  zdr_required: true,
  max_tokens_ceiling: 4096,
};

export const BALANCED_BOOKKEEPING: PolicyConfig = {
  name: 'cpa-bookkeeping-balanced',
  reid: {
    mode: 'full',
    allowed_entity_types: [],
    per_role_overrides: {},
  },
  allowed_models: [],
  allowed_apps: ['mybooks', 'trial-balance'],
  zdr_required: false,
  max_tokens_ceiling: 8192,
};

export const TAX_RESEARCH: PolicyConfig = {
  name: 'tax-research',
  reid: {
    mode: 'full',
    allowed_entity_types: [],
    per_role_overrides: {},
  },
  allowed_models: [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-sonnet-4-6-20251001',
  ],
  allowed_apps: ['tax-research'],
  zdr_required: true,
};

export const INTERNAL_ONLY: PolicyConfig = {
  name: 'internal-only',
  reid: {
    mode: 'full',
    allowed_entity_types: [],
    per_role_overrides: {},
  },
  allowed_models: [],
  allowed_apps: [],
  zdr_required: false,
};

/** Addendum 16.5 — Converter output flow. Inverted re-id; only the
 *  materialize endpoint produces cleartext. */
export const CONVERTER_OUTPUT: PolicyConfig = {
  name: 'cpa-converter-output',
  reid: {
    mode: 'none',
    allowed_entity_types: [],
    per_role_overrides: {},
  },
  allowed_models: [
    'claude-sonnet-4-6',
    'claude-sonnet-4-6-20251001',
    'claude-haiku-4-5-20251001',
  ],
  allowed_apps: ['converter'],
  zdr_required: true,
  max_tokens_ceiling: 8192,
};

export const BUILT_IN_POLICIES: readonly PolicyConfig[] = [
  STRICT_BOOKKEEPING,
  BALANCED_BOOKKEEPING,
  TAX_RESEARCH,
  INTERNAL_ONLY,
  CONVERTER_OUTPUT,
];

export const DEFAULT_POLICY: PolicyConfig = BALANCED_BOOKKEEPING;
