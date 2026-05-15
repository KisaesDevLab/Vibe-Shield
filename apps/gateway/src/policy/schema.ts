/**
 * Full policy schema. Composed of the re-id policy plus orchestration
 * config (allowed models, ZDR requirement, max context, allowed apps,
 * per-tenant rate / spend overrides).
 *
 * Policies are stored as ``vs_policies.json_config`` and resolved per
 * request by the PolicyResolver.
 */

import { z } from 'zod';
import { reidPolicySchema, type ReidMode } from './reid-policy.js';

export const policyConfigSchema = z.object({
  /** Logical name; matches vs_policies.name. */
  name: z.string().min(1),
  /** Re-identification policy nested. */
  reid: reidPolicySchema,
  /** Models the tenant is allowed to call. Empty = unrestricted. */
  allowed_models: z.array(z.string()).default([]),
  /** Apps allowed to use this policy. Empty = unrestricted. */
  allowed_apps: z.array(z.string()).default([]),
  /** Whether ZDR header must be sent. If true and the gateway is not
   *  configured with ZDR, the request fails closed. */
  zdr_required: z.boolean().default(false),
  /** Per-tenant rate cap override; absent = inherit gateway default. */
  rate_limit_per_minute: z.number().int().positive().optional(),
  /** Per-tenant monthly spend cap override (micro-dollars). */
  spend_cap_microdollars: z.number().int().nonnegative().optional(),
  /** Hard ceiling on max_tokens the tenant can request. */
  max_tokens_ceiling: z.number().int().positive().optional(),
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;
export type { ReidMode };
