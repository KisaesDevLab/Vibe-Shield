/**
 * ApplianceSecretStore — Phase 23.5 admin-set Anthropic key vault.
 *
 * Stores the operator-set Anthropic commercial API key encrypted under
 * the appliance KEK (AES-256-GCM, AAD bound to ``vs:appliance:anthropic_key``
 * so a wrapped tenant DEK can't be substituted in). Singleton row in
 * ``vs_appliance_settings``; ``id`` is fixed to ``1`` by the table's
 * CHECK constraint.
 *
 * Read path: ``getAnthropicKey`` decrypts on demand and returns the
 * plaintext. The plaintext lives in heap only during the call; callers
 * (``getEffectiveAnthropicKey`` in the gateway) copy it into the
 * AnthropicClientHolder and drop the local reference.
 *
 * Write path: ``setAnthropicKey`` encrypts and UPDATEs row 1. Fingerprint
 * is SHA-256(plaintext) truncated to 16 hex chars — short enough to
 * display in the admin UI, long enough to disambiguate a rotation.
 *
 * Audit hygiene: the plaintext key is never logged, never stringified,
 * never returned in error messages. The fingerprint is what gets
 * written into the audit payload.
 */

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../crypto/aead.js';
import { applianceSettings } from '../schema/appliance-settings.js';
import type { Database } from '../db/index.js';

/** AAD binding for the wrap. Distinct from per-tenant DEK AAD. */
const APPLIANCE_AAD = Buffer.from('vs:appliance:anthropic_key', 'utf8');

export class ApplianceSettingsMissingError extends Error {
  override readonly name = 'ApplianceSettingsMissingError';
}

export interface AnthropicKeyRecord {
  /** Decrypted Anthropic key — handle carefully; never log. */
  plaintext: string;
  /** Display-safe SHA-256 prefix (16 hex chars). */
  fingerprint: string;
  /** When the operator set this key, or null if env-only. */
  setAt: Date;
  /** Free-text operator descriptor (currently the actor name). */
  setBy: string;
}

export interface AnthropicKeyStatus {
  /** True when a DB-backed key is set. */
  present: boolean;
  fingerprint: string | null;
  setAt: Date | null;
  setBy: string | null;
  updatedAt: Date;
}

export class ApplianceSecretStore {
  /**
   * @param db   Drizzle handle.
   * @param kek  32-byte appliance KEK loaded by ``loadKek()``.
   */
  constructor(
    private readonly db: Database,
    private readonly kek: Buffer,
  ) {}

  /** Decrypt and return the admin-set key, or null if the operator hasn't set one. */
  async getAnthropicKey(): Promise<AnthropicKeyRecord | null> {
    const row = await this.loadRow();
    if (
      row.anthropicApiKeyCiphertext === null ||
      row.anthropicApiKeyFingerprint === null ||
      row.anthropicApiKeySetAt === null
    ) {
      return null;
    }
    const plaintextBuf = decrypt(
      row.anthropicApiKeyCiphertext,
      this.kek,
      APPLIANCE_AAD,
    );
    try {
      return {
        plaintext: plaintextBuf.toString('utf8'),
        fingerprint: row.anthropicApiKeyFingerprint,
        setAt: row.anthropicApiKeySetAt,
        setBy: row.anthropicApiKeySetBy ?? '',
      };
    } finally {
      // Best-effort zero. Node Buffers don't guarantee pooled-memory
      // erasure, but this narrows the heap window.
      plaintextBuf.fill(0);
    }
  }

  /**
   * Display-only status — never decrypts. Cheap enough to call on every
   * admin page load.
   */
  async getStatus(): Promise<AnthropicKeyStatus> {
    const row = await this.loadRow();
    return {
      present: row.anthropicApiKeyCiphertext !== null,
      fingerprint: row.anthropicApiKeyFingerprint,
      setAt: row.anthropicApiKeySetAt,
      setBy: row.anthropicApiKeySetBy,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Persist a new operator-set Anthropic key. Caller must validate the
   * key against the commercial-key probe BEFORE invoking this — a
   * persisted key is assumed to be live.
   */
  async setAnthropicKey(plaintext: string, actor: string): Promise<{ fingerprint: string }> {
    if (plaintext.length === 0) {
      throw new Error('refusing to persist an empty Anthropic key');
    }
    const ciphertext = encrypt(
      Buffer.from(plaintext, 'utf8'),
      this.kek,
      APPLIANCE_AAD,
    );
    const fingerprint = fingerprintOf(plaintext);
    await this.db
      .update(applianceSettings)
      .set({
        anthropicApiKeyCiphertext: ciphertext,
        anthropicApiKeyFingerprint: fingerprint,
        anthropicApiKeySetAt: new Date(),
        anthropicApiKeySetBy: actor,
        updatedAt: new Date(),
      })
      .where(eq(applianceSettings.id, 1));
    return { fingerprint };
  }

  /**
   * Null out the persisted key, returning the gateway to the env-set
   * bootstrap key. The row stays — only the secret columns clear.
   */
  async clearAnthropicKey(actor: string): Promise<void> {
    await this.db
      .update(applianceSettings)
      .set({
        anthropicApiKeyCiphertext: null,
        anthropicApiKeyFingerprint: null,
        anthropicApiKeySetAt: null,
        anthropicApiKeySetBy: actor,
        updatedAt: new Date(),
      })
      .where(eq(applianceSettings.id, 1));
  }

  /**
   * Load the singleton row. Migration 0003 seeds id=1 on every fresh
   * install; this throws only if a database has been hand-edited.
   */
  private async loadRow() {
    const rows = await this.db
      .select()
      .from(applianceSettings)
      .where(eq(applianceSettings.id, 1))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ApplianceSettingsMissingError(
        'vs_appliance_settings row 1 is missing — has migration 0003 run?',
      );
    }
    return row;
  }
}

/**
 * SHA-256(plaintext) truncated to 16 hex chars. Distinct enough to
 * disambiguate a rotation; short enough for a compact UI badge.
 */
export function fingerprintOf(plaintext: string): string {
  return createHash('sha256')
    .update(plaintext, 'utf8')
    .digest('hex')
    .slice(0, 16);
}
