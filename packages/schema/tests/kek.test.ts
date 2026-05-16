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

  it('clears VS_KEK from process.env after loading (regression: review S8)', () => {
    // v1.1.3 §review (S8): the KEK env var should be removed from
    // process.env after loading so it can't be recovered via
    // /proc/self/environ or child-process env inheritance.
    const raw = randomBytes(KEY_LENGTH);
    const original = process.env[KEK_ENV_VAR];
    try {
      process.env[KEK_ENV_VAR] = formatKekForEnv(raw);
      loadKek(); // default: process.env
      expect(process.env[KEK_ENV_VAR]).toBeUndefined();
    } finally {
      if (original !== undefined) process.env[KEK_ENV_VAR] = original;
    }
  });

  it('does NOT mutate a caller-supplied env object', () => {
    // Symmetry: when callers pass their own env (e.g., tests), we
    // shouldn't delete from it — only the process.env singleton.
    const raw = randomBytes(KEY_LENGTH);
    const env: NodeJS.ProcessEnv = { [KEK_ENV_VAR]: formatKekForEnv(raw) };
    loadKek(env);
    expect(env[KEK_ENV_VAR]).toBeDefined();
  });
});
