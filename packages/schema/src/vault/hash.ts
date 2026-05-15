/**
 * Dedup hash for vs_token_index.
 *
 * HMAC-SHA-256 keyed by the tenant's DEK over ``sessionId || cleartext``.
 * Properties:
 *
 *   - Same cleartext + same session + same DEK → same hash. This is what
 *     makes ``vs_token_index`` deduplicate within a session.
 *   - Same cleartext, different session → different hash (sessionId is
 *     part of the message). Cross-session correlation by hash equality is
 *     impossible.
 *   - Same cleartext, different tenant → different hash (DEK differs per
 *     tenant). An attacker with read access to ``vs_token_index`` cannot
 *     stitch hashes across tenants either.
 *   - Without the DEK, an attacker cannot precompute hashes for common
 *     PII values (e.g., a rainbow table of likely SSNs). Plain SHA-256
 *     would be vulnerable to that attack.
 */

import { createHmac } from 'node:crypto';

export const HASH_LENGTH = 32 as const; // SHA-256 output size in bytes

const SESSION_SEPARATOR = Buffer.from(':vs:', 'utf8');

export function tokenDedupeHash(dek: Buffer, sessionId: string, cleartext: string): Buffer {
  const hmac = createHmac('sha256', dek);
  hmac.update(Buffer.from(sessionId, 'utf8'));
  hmac.update(SESSION_SEPARATOR);
  hmac.update(Buffer.from(cleartext, 'utf8'));
  return hmac.digest();
}
