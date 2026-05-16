/**
 * Canonical safeStringify (v1.1 §3.9).
 *
 * Pins the determinism contract: order of keys in the input object —
 * at any depth — must NOT change the output. Same for arrays-of-objects.
 * The audit-digest tamper evidence depends on this.
 */

import { describe, expect, it } from 'vitest';

import { safeStringify } from '../src/vault/audit-logger.js';

describe('safeStringify', () => {
  it('orders top-level keys lexicographically', () => {
    const a = safeStringify({ b: 1, a: 2, c: 3 });
    const b = safeStringify({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('orders nested-object keys lexicographically (v1.1 fix)', () => {
    const a = safeStringify({ outer: { z: 1, a: 2, m: 3 } });
    const b = safeStringify({ outer: { a: 2, m: 3, z: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"outer":{"a":2,"m":3,"z":1}}');
  });

  it('preserves array order (semantically meaningful)', () => {
    const a = safeStringify([3, 1, 2]);
    expect(a).toBe('[3,1,2]');
  });

  it('canonicalizes objects nested inside arrays', () => {
    const a = safeStringify([{ b: 1, a: 2 }, { d: 3, c: 4 }]);
    expect(a).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });

  it('drops undefined values from objects', () => {
    expect(safeStringify({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('preserves null values', () => {
    expect(safeStringify({ a: null })).toBe('{"a":null}');
  });

  it('serializes undefined in arrays as null (matches JSON.stringify)', () => {
    expect(safeStringify([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('serializes bigint with n suffix (JSON.stringify would throw)', () => {
    expect(safeStringify({ amount: 12345678901234567890n })).toBe(
      '{"amount":"12345678901234567890n"}',
    );
  });

  it('throws on cyclic references', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    expect(() => safeStringify(a)).toThrow(/cyclic/);
  });

  it('handles deeply-nested mixed structures deterministically', () => {
    const obj = {
      tenant: 'acme',
      events: [
        { kind: 'redact', meta: { z: 1, a: 2 } },
        { kind: 'reidentify', meta: { b: 3, y: 4 } },
      ],
    };
    const reordered = {
      events: [
        { meta: { a: 2, z: 1 }, kind: 'redact' },
        { meta: { y: 4, b: 3 }, kind: 'reidentify' },
      ],
      tenant: 'acme',
    };
    expect(safeStringify(obj)).toBe(safeStringify(reordered));
  });
});
