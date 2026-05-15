import { describe, expect, it } from 'vitest';
import { CryptoError, newKey } from '../src/crypto/aead.js';
import { createWrappedDek, rewrapDek, unwrapDek } from '../src/crypto/dek.js';

describe('DEK wrap / unwrap', () => {
  it('roundtrips: createWrappedDek then unwrapDek', () => {
    const kek = newKey();
    const { wrappedDek, dek } = createWrappedDek(kek, 'tenant-acme');
    expect(unwrapDek(wrappedDek, kek, 'tenant-acme')).toEqual(dek);
  });

  it('produces distinct DEKs across tenants', () => {
    const kek = newKey();
    const a = createWrappedDek(kek, 'tenant-a');
    const b = createWrappedDek(kek, 'tenant-b');
    expect(a.dek.equals(b.dek)).toBe(false);
  });

  it('rejects unwrap with the wrong tenant_id (AAD binding)', () => {
    const kek = newKey();
    const { wrappedDek } = createWrappedDek(kek, 'tenant-acme');
    expect(() => unwrapDek(wrappedDek, kek, 'tenant-someone-else')).toThrow(CryptoError);
  });

  it('rejects unwrap with the wrong KEK', () => {
    const kek = newKey();
    const otherKek = newKey();
    const { wrappedDek } = createWrappedDek(kek, 'tenant-acme');
    expect(() => unwrapDek(wrappedDek, otherKek, 'tenant-acme')).toThrow(CryptoError);
  });

  it('rewrapDek preserves the underlying DEK across KEK rotation', () => {
    const oldKek = newKey();
    const newKek = newKey();
    const { wrappedDek, dek } = createWrappedDek(oldKek, 'tenant-acme');
    const rewrapped = rewrapDek(wrappedDek, oldKek, newKek, 'tenant-acme');
    expect(unwrapDek(rewrapped, newKek, 'tenant-acme')).toEqual(dek);
  });

  it('after rewrap, the old KEK cannot decrypt the new wrapped blob', () => {
    const oldKek = newKey();
    const newKekVal = newKey();
    const { wrappedDek } = createWrappedDek(oldKek, 'tenant-acme');
    const rewrapped = rewrapDek(wrappedDek, oldKek, newKekVal, 'tenant-acme');
    expect(() => unwrapDek(rewrapped, oldKek, 'tenant-acme')).toThrow(CryptoError);
  });
});
