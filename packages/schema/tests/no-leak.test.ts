/**
 * Hard rule #1 enforcement at the crypto layer.
 *
 * If anyone refactors the crypto module to log keys / cleartext for
 * debugging, this test catches it before merge. We capture every stdout
 * / stderr write during a full encrypt → wrap → unwrap → decrypt cycle
 * and assert that none of the sensitive material appears in the capture.
 */

import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  decrypt,
  encrypt,
  newKey,
} from '../src/crypto/aead.js';
import { createWrappedDek, unwrapDek } from '../src/crypto/dek.js';

describe('no-leak — crypto produces no console output', () => {
  it('does not write secrets to stdout / stderr during a full roundtrip', () => {
    const captured: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown): boolean => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown): boolean => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let plaintext: Buffer;
    let kek: Buffer;
    let dek: Buffer;
    try {
      plaintext = Buffer.from('SSN 234-56-7890 routing 011000015 PAN 4111-1111-1111-1111');
      kek = newKey();
      const wrap = createWrappedDek(kek, 'tenant-acme');
      dek = wrap.dek;
      const blob = encrypt(plaintext, dek);
      const got = decrypt(blob, dek);
      expect(got).toEqual(plaintext);
      // Force an error path too — make sure the error message is clean.
      try {
        decrypt(blob, newKey());
        expect.fail('decrypt with wrong key should throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoError);
        expect((err as Error).message).not.toContain('234-56-7890');
        expect((err as Error).message).not.toContain('011000015');
      }
      unwrapDek(wrap.wrappedDek, kek, 'tenant-acme');
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }

    const joined = captured.join('');
    expect(joined).not.toContain('234-56-7890');
    expect(joined).not.toContain('011000015');
    expect(joined).not.toContain('4111-1111-1111-1111');
    // Also assert the raw key bytes do not appear as base64 (a common
    // accidental-log shape).
    expect(joined).not.toContain(kek.toString('base64'));
    expect(joined).not.toContain(dek.toString('base64'));
  });
});
