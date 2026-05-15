import { describe, expect, it } from 'vitest';
import { PUBLIC_BANK_NAMES, isPublicBank } from '../src/policy/bank-whitelist.js';

describe('public bank whitelist (addendum 16.5.8)', () => {
  it('matches case-insensitively', () => {
    expect(isPublicBank('Chase')).toBe(true);
    expect(isPublicBank('chase')).toBe(true);
    expect(isPublicBank('CHASE')).toBe(true);
  });

  it('matches multi-word brands', () => {
    expect(isPublicBank('Bank of America')).toBe(true);
    expect(isPublicBank('Wells Fargo')).toBe(true);
    expect(isPublicBank('American Express')).toBe(true);
    expect(isPublicBank('Navy Federal Credit Union')).toBe(true);
  });

  it('rejects names that look bank-y but aren\'t on the list', () => {
    expect(isPublicBank('Some Random Bank')).toBe(false);
    expect(isPublicBank('My Local Credit Union')).toBe(false);
  });

  it('trims whitespace', () => {
    expect(isPublicBank('  Chase  ')).toBe(true);
  });

  it('covers the top 5 money-center banks', () => {
    for (const name of ['Chase', 'Bank of America', 'Wells Fargo', 'Citi', 'PNC']) {
      expect(isPublicBank(name)).toBe(true);
    }
  });

  it('exports a non-trivial list', () => {
    expect(PUBLIC_BANK_NAMES.length).toBeGreaterThan(20);
  });
});
