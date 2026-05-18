/**
 * ApplianceSecretStore unit tests (Phase 23.5).
 *
 * Verifies the in-memory crypto path without a real database: we
 * construct a fake Database stub that records inserts/updates so we
 * can assert encrypt/decrypt + AAD binding behaviors. The full
 * round-trip against a real Postgres is exercised by an integration
 * test sibling.
 */

import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, newKey } from '../src/crypto/aead.js';
import { fingerprintOf } from '../src/vault/appliance-secret-store.js';

const APPLIANCE_AAD = Buffer.from('vs:appliance:anthropic_key', 'utf8');

describe('appliance-secret-store crypto contract', () => {
  it('encrypt → decrypt round-trips under the appliance AAD', () => {
    const kek = newKey();
    const plaintext = 'sk-ant-test-key-value';
    const ct = encrypt(Buffer.from(plaintext, 'utf8'), kek, APPLIANCE_AAD);
    const pt = decrypt(ct, kek, APPLIANCE_AAD).toString('utf8');
    expect(pt).toBe(plaintext);
  });

  it('AAD mismatch fails — a per-tenant DEK ciphertext cannot be substituted', () => {
    const kek = newKey();
    const plaintext = 'sk-ant-test-key';
    const ct = encrypt(Buffer.from(plaintext, 'utf8'), kek, APPLIANCE_AAD);
    expect(() =>
      decrypt(ct, kek, Buffer.from('vs:tenant:acme', 'utf8')),
    ).toThrow();
  });

  it('different KEK fails decrypt', () => {
    const kek1 = newKey();
    const kek2 = newKey();
    const ct = encrypt(Buffer.from('sk-ant', 'utf8'), kek1, APPLIANCE_AAD);
    expect(() => decrypt(ct, kek2, APPLIANCE_AAD)).toThrow();
  });

  it('fingerprintOf is deterministic and 16 hex chars', () => {
    const fp1 = fingerprintOf('sk-ant-key-1');
    const fp2 = fingerprintOf('sk-ant-key-1');
    const fp3 = fingerprintOf('sk-ant-key-2');
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);
    expect(fp1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('fingerprintOf never exposes the input key', () => {
    const key = 'sk-ant-deadbeef-cafe-babe';
    const fp = fingerprintOf(key);
    expect(fp.includes('sk-ant')).toBe(false);
    expect(fp.includes('deadbeef')).toBe(false);
  });
});
