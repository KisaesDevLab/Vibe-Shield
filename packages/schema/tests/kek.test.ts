import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KEY_LENGTH } from '../src/crypto/aead.js';
import {
  KEK_ENV_VAR,
  KekUnavailableError,
  formatKekForEnv,
  loadKek,
} from '../src/crypto/kek.js';

describe('kek loading', () => {
  it('loads a valid base64 KEK from env', () => {
    const raw = randomBytes(KEY_LENGTH);
    const env = { [KEK_ENV_VAR]: formatKekForEnv(raw) };
    expect(loadKek(env)).toEqual(raw);
  });

  it('throws when env var is missing', () => {
    expect(() => loadKek({})).toThrow(KekUnavailableError);
  });

  it('throws when env var is empty string', () => {
    expect(() => loadKek({ [KEK_ENV_VAR]: '' })).toThrow(KekUnavailableError);
  });

  it('throws when KEK length is wrong', () => {
    const shorter = randomBytes(KEY_LENGTH - 4).toString('base64');
    expect(() => loadKek({ [KEK_ENV_VAR]: shorter })).toThrow(KekUnavailableError);
  });

  it('throws when KEK is one byte too long', () => {
    const longer = randomBytes(KEY_LENGTH + 1).toString('base64');
    expect(() => loadKek({ [KEK_ENV_VAR]: longer })).toThrow(KekUnavailableError);
  });

  it('error message mentions the env var name (for ops debugging)', () => {
    try {
      loadKek({});
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message).toContain('VS_KEK');
    }
  });
});
