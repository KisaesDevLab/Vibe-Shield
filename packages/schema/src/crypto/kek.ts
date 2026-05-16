/**
 * KEK loader.
 *
 * The Key Encryption Key (KEK) wraps per-tenant DEKs. It lives outside
 * the database (BUILD_PLAN §5: "KEK stored outside the database (env
 * var sourced from appliance secret manager)"). On the Vibe Appliance,
 * the secret manager populates ``VS_KEK`` at container start.
 *
 * Fail-closed: any failure to load — missing env, wrong length, bad
 * base64 — throws synchronously. There is no fallback / default key.
 */

import { CryptoError, KEY_LENGTH } from './aead.js';

export const KEK_ENV_VAR = 'VS_KEK' as const;

export class KekUnavailableError extends Error {
  override readonly name = 'KekUnavailableError';
}

/**
 * Read and validate the KEK from ``process.env.VS_KEK``.
 *
 * Expected format: base64 of exactly 32 random bytes. Generate one with:
 *
 *     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
export function loadKek(env: NodeJS.ProcessEnv = process.env): Buffer {
  const value = env[KEK_ENV_VAR];
  if (value === undefined || value === '') {
    throw new KekUnavailableError(
      `${KEK_ENV_VAR} is not set. Refusing to operate without a KEK.`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, 'base64');
  } catch {
    throw new KekUnavailableError(`${KEK_ENV_VAR} is not valid base64`);
  }
  if (bytes.length !== KEY_LENGTH) {
    throw new KekUnavailableError(
      `${KEK_ENV_VAR} must be ${KEY_LENGTH.toString()} bytes of base64; got ${bytes.length.toString()}`,
    );
  }
  // v1.1.3 §review (S8): remove the KEK from process.env after loading
  // so it can't be recovered via /proc/self/environ, accidental child
  // process spawn that inherits env, or debugging tools that dump env.
  // The in-memory Buffer is the canonical reference from this point.
  // Only delete from the same env object the caller passed in to keep
  // tests with custom envs predictable.
  if (env === process.env) {
    delete env[KEK_ENV_VAR];
  }
  return bytes;
}

/**
 * Test helper: format a buffer as a ``VS_KEK``-compatible env value.
 * Not exported from the public package surface — only used by tests
 * and the bootstrap scripts.
 */
export function formatKekForEnv(key: Buffer): string {
  if (key.length !== KEY_LENGTH) {
    throw new CryptoError(`key must be ${KEY_LENGTH.toString()} bytes`);
  }
  return key.toString('base64');
}
