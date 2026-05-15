/**
 * AES-256-GCM authenticated encryption.
 *
 * Layout on the wire / in bytea storage:
 *
 *   ┌─────────┬────────────┬──────┐
 *   │  nonce  │ ciphertext │  tag │
 *   │ 12 bytes│   N bytes  │16 b. │
 *   └─────────┴────────────┴──────┘
 *
 * The 12-byte nonce is GCM's recommended size (96 bits). Anything larger
 * forces an extra GHASH round; anything smaller weakens security.
 *
 * The 16-byte tag is GCM's full-strength tag (128 bits). We never use a
 * shorter tag — truncation lets a single 2^32 brute force forge against
 * 96-bit tags, NIST SP 800-38D §5.2.1.2.
 *
 * Nonce policy: a fresh random nonce per ``encrypt`` call. GCM is
 * catastrophically insecure under nonce reuse (the keystream XORs out
 * and the auth key derives from the same H). 2^32 random 12-byte
 * nonces collide with non-trivial probability, so callers must rotate
 * the key well before that threshold — Phase 23 KEK rotation procedure
 * handles this.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const KEY_LENGTH = 32 as const; // 256 bits
export const NONCE_LENGTH = 12 as const; // 96 bits — GCM-recommended
export const TAG_LENGTH = 16 as const; // 128 bits — full

export class CryptoError extends Error {
  override readonly name = 'CryptoError';
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    throw new CryptoError(
      `key must be ${KEY_LENGTH.toString()} bytes; got ${key.length.toString()}`,
    );
  }
}

/**
 * Encrypt ``plaintext`` under ``key`` with optional Additional
 * Authenticated Data. AAD is not encrypted but is bound to the
 * ciphertext — any tampering with AAD makes ``decrypt`` throw.
 *
 * @returns ``nonce || ciphertext || tag`` as a single Buffer.
 */
export function encrypt(plaintext: Buffer, key: Buffer, aad?: Buffer): Buffer {
  assertKeyLength(key);
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, {
    authTagLength: TAG_LENGTH,
  });
  if (aad !== undefined) {
    cipher.setAAD(aad);
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

/**
 * Decrypt a blob produced by ``encrypt``. Throws ``CryptoError`` if
 * authentication fails — never returns garbage plaintext.
 */
export function decrypt(blob: Buffer, key: Buffer, aad?: Buffer): Buffer {
  assertKeyLength(key);
  if (blob.length < NONCE_LENGTH + TAG_LENGTH) {
    throw new CryptoError(
      `blob too short: ${blob.length.toString()} bytes (min ${(NONCE_LENGTH + TAG_LENGTH).toString()})`,
    );
  }
  const nonce = blob.subarray(0, NONCE_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ciphertext = blob.subarray(NONCE_LENGTH, blob.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  if (aad !== undefined) {
    decipher.setAAD(aad);
  }
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    // Node throws a plain Error here; surface it as our typed error so
    // callers can pattern-match without instanceof Node-version drift.
    throw new CryptoError('authentication failed', { cause });
  }
}

/**
 * Generate a random 256-bit key. Used for fresh DEKs at tenant creation.
 */
export function newKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}
