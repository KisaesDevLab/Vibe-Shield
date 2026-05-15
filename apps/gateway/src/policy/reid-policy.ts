/**
 * Re-identification policy.
 *
 * BUILD_PLAN §9: response scanner replaces tokens back to cleartext per
 * policy. Modes: ``full`` (every known token resolved), ``partial``
 * (per-entity-type allowlist), ``none`` (audit-only — tokens stay
 * tokens in the response).
 *
 * Phase 8 hard-coded ``full`` semantics. This module makes that
 * configurable; Phase 10's policy engine will load these from the
 * vs_policies table.
 */

import { z } from 'zod';

export const REID_MODES = ['full', 'partial', 'none'] as const;
export type ReidMode = (typeof REID_MODES)[number];

export const reidPolicySchema = z.object({
  mode: z.enum(REID_MODES).default('full'),
  /**
   * Only meaningful when mode === 'partial'. Entity types named here
   * are resolved; everything else stays tokenized.
   */
  allowed_entity_types: z.array(z.string()).default([]),
  /**
   * Per-user allowlist override. ``"partner"`` users see ``full``
   * regardless of the base mode; ``"junior"`` users get ``partial``;
   * everyone else uses the base mode. Tunable in v1.1; v1 maps role
   * names to overrides.
   */
  per_role_overrides: z.record(z.enum(REID_MODES)).default({}),
});

export type ReidPolicy = z.infer<typeof reidPolicySchema>;

export const FULL_POLICY: ReidPolicy = {
  mode: 'full',
  allowed_entity_types: [],
  per_role_overrides: {},
};

export const NONE_POLICY: ReidPolicy = {
  mode: 'none',
  allowed_entity_types: [],
  per_role_overrides: {},
};

/**
 * Special-case for Addendum 16.5: the Converter's output file IS the
 * audit-grade re-identification target. The materialize endpoint is the
 * sanctioned path; regular /v1/messages responses get ``none`` so
 * cleartext only crosses the boundary at output-file write time.
 */
export const CONVERTER_OUTPUT_POLICY: ReidPolicy = {
  mode: 'none',
  allowed_entity_types: [],
  per_role_overrides: {},
};

/**
 * Resolve the effective mode for a given user role, taking
 * per-role overrides into account.
 */
export function effectiveMode(policy: ReidPolicy, role: string | undefined): ReidMode {
  if (role !== undefined && policy.per_role_overrides[role] !== undefined) {
    return policy.per_role_overrides[role];
  }
  return policy.mode;
}

/**
 * Decide whether ``entityType`` should be re-identified under
 * ``policy`` for ``role``.
 */
export function shouldResolve(
  policy: ReidPolicy,
  role: string | undefined,
  entityType: string,
): boolean {
  const mode = effectiveMode(policy, role);
  if (mode === 'full') return true;
  if (mode === 'none') return false;
  return policy.allowed_entity_types.includes(entityType);
}
