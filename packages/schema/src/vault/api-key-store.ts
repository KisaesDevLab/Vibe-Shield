/**
 * ApiKeyStore — gateway credential management.
 *
 * Key format: ``vs_live_<24 base62 chars>`` (32 chars total after the
 * prefix). Generation uses crypto.randomBytes mapped to base62; the
 * 24-char body gives ~143 bits of entropy, well past any practical
 * brute-force ceiling.
 *
 * Storage: only ``SHA-256(full_key)`` lands in the database. Lookup is
 * O(1) by hash. The cleartext key is returned to the caller exactly
 * once at issuance — there is no recovery path. Lost keys are revoked
 * and reissued via the admin UI (Phase 13).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { apiKeys } from '../schema/api-keys.js';

export const KEY_PREFIX = 'vs_live_' as const;
export const KEY_BODY_LENGTH = 24 as const;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export class ApiKeyInvalidError extends Error {
  override readonly name = 'ApiKeyInvalidError';
}

export class ApiKeyRevokedError extends Error {
  override readonly name = 'ApiKeyRevokedError';
}

export interface IssuedKey {
  /** Cleartext, shown to the operator exactly once. */
  key: string;
  /** Persisted row. */
  record: {
    keyHash: Buffer;
    tenantId: string;
    appId: string;
    name: string;
    createdAt: Date;
  };
}

export interface ResolvedKey {
  tenantId: string;
  appId: string;
  name: string;
  keyHash: Buffer;
}

export interface CreateApiKeyInput {
  tenantId: string;
  appId: string;
  name: string;
}

export class ApiKeyStore {
  constructor(private readonly db: Database) {}

  /**
   * Mint a new key for ``input.tenantId`` / ``input.appId``. The cleartext
   * is returned in ``IssuedKey.key`` — the caller is responsible for
   * relaying it to the operator and then dropping it from memory.
   */
  async issue(input: CreateApiKeyInput): Promise<IssuedKey> {
    const key = generateApiKey();
    const keyHash = hashKey(key);
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        keyHash,
        tenantId: input.tenantId,
        appId: input.appId,
        name: input.name,
      })
      .returning();
    if (row === undefined) {
      throw new Error('insert returned no rows');
    }
    return {
      key,
      record: {
        keyHash: row.keyHash,
        tenantId: row.tenantId,
        appId: row.appId,
        name: row.name,
        createdAt: row.createdAt,
      },
    };
  }

  /**
   * Validate a presented key and return its tenant / app.
   *
   * - Throws ``ApiKeyInvalidError`` if the format is wrong or no row matches.
   * - Throws ``ApiKeyRevokedError`` if the matching row has a revoked_at set.
   * - Bumps ``last_used_at`` as a side effect of a successful lookup.
   */
  async resolve(presented: string): Promise<ResolvedKey> {
    if (!isPlausibleKey(presented)) {
      throw new ApiKeyInvalidError('key format invalid');
    }
    const expectedHash = hashKey(presented);
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, expectedHash))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ApiKeyInvalidError('key not recognized');
    }
    // Constant-time compare on the hash itself defends against the
    // (already unlikely) timing attack on the bytea comparison path.
    if (!timingSafeEqual(row.keyHash, expectedHash)) {
      throw new ApiKeyInvalidError('key not recognized');
    }
    if (row.revokedAt !== null) {
      throw new ApiKeyRevokedError(`key revoked at ${row.revokedAt.toISOString()}`);
    }
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.keyHash, row.keyHash));
    return {
      tenantId: row.tenantId,
      appId: row.appId,
      name: row.name,
      keyHash: row.keyHash,
    };
  }

  /** Revoke a key by its hash. Idempotent: re-revoking is a no-op. */
  async revoke(keyHash: Buffer): Promise<boolean> {
    const result = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
      .returning({ keyHash: apiKeys.keyHash });
    return result.length > 0;
  }

  /** Look up the hash for a key string — useful for tests and admin tools. */
  static hash(key: string): Buffer {
    return hashKey(key);
  }

  /**
   * Admin UI helper (v1.1 §3.3): list every issued key with operational
   * metadata. The bytea key_hash is rendered as a hex string for use as
   * a public ID — the cleartext key is never present in the row.
   */
  async list(): Promise<AdminApiKeyView[]> {
    const rows = await this.db.select().from(apiKeys);
    return rows.map((r) => ({
      id: r.keyHash.toString('hex'),
      tenantId: r.tenantId,
      appId: r.appId,
      label: r.name,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt === null ? null : r.lastUsedAt.toISOString(),
      revokedAt: r.revokedAt === null ? null : r.revokedAt.toISOString(),
    }));
  }

  /**
   * Admin UI helper (v1.1 §3.3): revoke a key by hex-encoded hash.
   * Returns false if no row matched (already revoked, or wrong hash).
   */
  async revokeByHashHex(hex: string): Promise<boolean> {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
    return this.revoke(Buffer.from(hex, 'hex'));
  }
}

export interface AdminApiKeyView {
  /** Hex-encoded key_hash; opaque from the admin UI's perspective. */
  id: string;
  tenantId: string;
  appId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function generateApiKey(): string {
  const bytes = randomBytes(KEY_BODY_LENGTH);
  let body = '';
  for (const b of bytes) {
    body += BASE62[b % 62];
  }
  return `${KEY_PREFIX}${body}`;
}

export function isPlausibleKey(s: string): boolean {
  return (
    s.startsWith(KEY_PREFIX) &&
    s.length === KEY_PREFIX.length + KEY_BODY_LENGTH &&
    /^[A-Za-z0-9]+$/.test(s.slice(KEY_PREFIX.length))
  );
}

function hashKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}
