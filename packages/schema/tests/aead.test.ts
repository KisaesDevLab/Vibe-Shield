import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  KEY_LENGTH,
  NONCE_LENGTH,
  TAG_LENGTH,
  decrypt,
  encrypt,
  newKey,
} from '../src/crypto/aead.js';

describe('aead', () => {
  it('roundtrips a string under a fresh key', () => {
    const key = newKey();
    const plaintext = Buffer.from('SSN 234-56-7890 belongs to Jane Doe', 'utf8');
    const blob = encrypt(plaintext, key);
    expect(decrypt(blob, key)).toEqual(plaintext);
  });

  it('roundtrips with AAD bound', () => {
    const key = newKey();
    const plaintext = Buffer.from('routing 011000015');
    const aad = Buffer.from('vs:tenant:acme');
    const blob = encrypt(plaintext, key, aad);
    expect(decrypt(blob, key, aad)).toEqual(plaintext);
  });

  it('produces distinct ciphertext for identical plaintext (random nonce)', () => {
    const key = newKey();
    const plaintext = Buffer.from('repeat me');
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a.equals(b)).toBe(false);
  });

  it('rejects wrong key', () => {
    const key = newKey();
    const wrongKey = newKey();
    const blob = encrypt(Buffer.from('secret'), key);
    expect(() => decrypt(blob, wrongKey)).toThrow(CryptoError);
  });

  it('rejects missing AAD when encrypted with AAD', () => {
    const key = newKey();
    const blob = encrypt(Buffer.from('secret'), key, Buffer.from('aad-A'));
    expect(() => decrypt(blob, key)).toThrow(CryptoError);
  });

  it('rejects swapped AAD', () => {
    const key = newKey();
    const blob = encrypt(Buffer.from('secret'), key, Buffer.from('aad-A'));
    expect(() => decrypt(blob, key, Buffer.from('aad-B'))).toThrow(CryptoError);
  });

  it('rejects ciphertext bit-flip (tag check)', () => {
    const key = newKey();
    const blob = encrypt(Buffer.from('secret'), key);
    blob[NONCE_LENGTH] = blob[NONCE_LENGTH]! ^ 0x01;
    expect(() => decrypt(blob, key)).toThrow(CryptoError);
  });

  it('rejects truncated blob', () => {
    const key = newKey();
    const blob = encrypt(Buffer.from('secret'), key);
    const truncated = blob.subarray(0, NONCE_LENGTH + TAG_LENGTH - 1);
    expect(() => decrypt(truncated, key)).toThrow(CryptoError);
  });

  it('rejects wrong key length', () => {
    const tooShort = randomBytes(KEY_LENGTH - 1);
    expect(() => encrypt(Buffer.from('x'), tooShort)).toThrow(CryptoError);
  });

  it('handles empty plaintext', () => {
    const key = newKey();
    const blob = encrypt(Buffer.alloc(0), key);
    expect(decrypt(blob, key)).toEqual(Buffer.alloc(0));
    expect(blob.length).toBe(NONCE_LENGTH + TAG_LENGTH);
  });
});
