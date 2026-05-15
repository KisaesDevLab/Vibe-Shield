/**
 * Token vault — encrypted-at-rest cleartext storage with deterministic
 * tokenization within a session.
 *
 * Allocation flow (BUILD_PLAN §6, transactional):
 *
 *   1. Open tx, lock the session row (FOR UPDATE) so concurrent
 *      allocations against the same session serialize and produce
 *      monotonic N values.
 *   2. Refuse if the session is missing or expired.
 *   3. Compute dedup hash = HMAC-SHA-256(DEK, sessionId || cleartext).
 *   4. SELECT vs_token_index by (session_id, hash). If present, return
 *      the existing token — same cleartext, same token, same session.
 *   5. Otherwise allocate a new token: ``<{entityType}_{N+1}>`` where
 *      N is the count of existing tokens for that (session, entity_type).
 *   6. Encrypt cleartext with the DEK; INSERT vs_tokens; INSERT
 *      vs_token_index. Commit.
 */

import { and, eq, sql } from 'drizzle-orm';
import { decrypt, encrypt } from '../crypto/aead.js';
import type { Database } from '../db/index.js';
import { sessions } from '../schema/sessions.js';
import { tokenIndex } from '../schema/token-index.js';
import { tokens } from '../schema/tokens.js';
import { tokenDedupeHash } from './hash.js';

export interface TenantKeyResolver {
  /**
   * Returns the cleartext per-tenant DEK. Implementations cache for the
   * request duration and never persist the unwrapped key. Phase 7+ wires
   * the gateway's tenant-key cache; tests inject a static map.
   */
  resolve(tenantId: string): Promise<Buffer>;
}

export class SessionUnavailableError extends Error {
  override readonly name = 'SessionUnavailableError';
}

export interface AllocateResult {
  token: string;
  reused: boolean;
}

export class TokenVault {
  constructor(
    private readonly db: Database,
    private readonly keys: TenantKeyResolver,
  ) {}

  /**
   * Return the existing token for ``cleartext`` in ``sessionId``, or
   * allocate a new one. Idempotent: calling repeatedly with the same
   * inputs always returns the same token.
   */
  async allocate(
    sessionId: string,
    entityType: string,
    cleartext: string,
  ): Promise<AllocateResult> {
    return this.db.transaction(async (tx) => {
      const session = await lockSession(tx, sessionId);
      const dek = await this.keys.resolve(session.tenantId);
      const hash = tokenDedupeHash(dek, sessionId, cleartext);

      const existing = await tx
        .select({ token: tokenIndex.token })
        .from(tokenIndex)
        .where(and(eq(tokenIndex.sessionId, sessionId), eq(tokenIndex.hash, hash)))
        .limit(1);
      const existingToken = existing[0]?.token;
      if (existingToken !== undefined) {
        return { token: existingToken, reused: true };
      }

      const next = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(tokens)
        .where(and(eq(tokens.sessionId, sessionId), eq(tokens.entityType, entityType)));
      const n = (next[0]?.n ?? 0) + 1;
      const token = `<${entityType}_${n.toString()}>`;

      const ciphertext = encrypt(Buffer.from(cleartext, 'utf8'), dek);
      await tx.insert(tokens).values({
        sessionId,
        token,
        entityType,
        cleartextEncrypted: ciphertext,
        hash,
      });
      await tx.insert(tokenIndex).values({
        sessionId,
        hash,
        token,
      });
      return { token, reused: false };
    });
  }

  /**
   * Decrypt and return the cleartext for ``token`` in ``sessionId``.
   * Returns ``null`` if the (session, token) pair is unknown — used by
   * the gateway's re-identification pass to leave hallucinated tokens
   * untouched.
   */
  async resolve(sessionId: string, token: string): Promise<string | null> {
    const session = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const sessionRow = session[0];
    if (sessionRow === undefined) {
      return null;
    }
    const dek = await this.keys.resolve(sessionRow.tenantId);

    const rows = await this.db
      .select({ ct: tokens.cleartextEncrypted })
      .from(tokens)
      .where(and(eq(tokens.sessionId, sessionId), eq(tokens.token, token)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return decrypt(row.ct, dek).toString('utf8');
  }
}

type Transaction = Parameters<Database['transaction']>[0] extends (tx: infer T) => unknown
  ? T
  : never;

async function lockSession(
  tx: Transaction,
  sessionId: string,
): Promise<{ id: string; tenantId: string; expiresAt: Date }> {
  const rows = await tx
    .select({
      id: sessions.id,
      tenantId: sessions.tenantId,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .for('update')
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new SessionUnavailableError(`session ${sessionId} not found`);
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new SessionUnavailableError(`session ${sessionId} expired`);
  }
  return row;
}
