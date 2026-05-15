import { describe, expect, it } from 'vitest';
import {
  CONVERTER_OUTPUT_POLICY,
  FULL_POLICY,
  NONE_POLICY,
  effectiveMode,
  reidPolicySchema,
  shouldResolve,
} from '../src/policy/reid-policy.js';

describe('ReidPolicy schema', () => {
  it('parses default to full', () => {
    const p = reidPolicySchema.parse({});
    expect(p.mode).toBe('full');
  });

  it('accepts partial mode with allowlist', () => {
    const p = reidPolicySchema.parse({
      mode: 'partial',
      allowed_entity_types: ['EMAIL_ADDRESS'],
    });
    expect(p.mode).toBe('partial');
    expect(p.allowed_entity_types).toEqual(['EMAIL_ADDRESS']);
  });

  it('rejects unknown mode', () => {
    expect(() => reidPolicySchema.parse({ mode: 'maximum' })).toThrow();
  });
});

describe('effectiveMode', () => {
  it('returns base mode when no role override', () => {
    expect(effectiveMode(FULL_POLICY, 'partner')).toBe('full');
  });
  it('honors per-role override', () => {
    const p = reidPolicySchema.parse({
      mode: 'partial',
      per_role_overrides: { partner: 'full', junior: 'none' },
    });
    expect(effectiveMode(p, 'partner')).toBe('full');
    expect(effectiveMode(p, 'junior')).toBe('none');
    expect(effectiveMode(p, 'unknown')).toBe('partial');
  });
});

describe('shouldResolve', () => {
  it('full resolves any entity type', () => {
    expect(shouldResolve(FULL_POLICY, undefined, 'US_SSN')).toBe(true);
    expect(shouldResolve(FULL_POLICY, undefined, 'EMAIL_ADDRESS')).toBe(true);
  });
  it('none resolves nothing', () => {
    expect(shouldResolve(NONE_POLICY, undefined, 'US_SSN')).toBe(false);
  });
  it('converter-output resolves nothing — materialize is the only path', () => {
    expect(shouldResolve(CONVERTER_OUTPUT_POLICY, undefined, 'US_BANK_ACCOUNT')).toBe(
      false,
    );
  });
  it('partial resolves only allowed entity types', () => {
    const p = reidPolicySchema.parse({
      mode: 'partial',
      allowed_entity_types: ['EMAIL_ADDRESS'],
    });
    expect(shouldResolve(p, undefined, 'EMAIL_ADDRESS')).toBe(true);
    expect(shouldResolve(p, undefined, 'US_SSN')).toBe(false);
  });
  it('per-role override flips behavior', () => {
    const p = reidPolicySchema.parse({
      mode: 'partial',
      allowed_entity_types: ['EMAIL_ADDRESS'],
      per_role_overrides: { partner: 'full' },
    });
    expect(shouldResolve(p, 'partner', 'US_SSN')).toBe(true);
    expect(shouldResolve(p, undefined, 'US_SSN')).toBe(false);
  });
});
