/**
 * Per-tenant Data Encryption Key (DEK) management.
 *
 * The DEK is the symmetric key that actually encrypts ``vs_tokens.cleartext_encrypted``.
 * Each tenant has its own DEK. The DEK is wrapped under the appliance
 * KEK (see ``kek.ts``) and the wrapped blob is stored in
 * ``vs_tenant_keys.wrapped_dek``.
 *
 * AAD binding: the wrap call uses ``tenant_id`` as Additional
 * Authenticated Data. If an attacker with DB-only access tries to copy
 * a wrapped DEK to a different tenant_id row (impersonating one tenant
 * with another's wrapped key), unwrap will fail authentication.
 */

import { decrypt, encrypt, newKey } from './aead.js';

/**
 * Produce a fresh wrapped DEK for a new tenant. Call once per tenant at
 * provisioning time; persist the result in ``vs_tenant_keys``.
 */
export function createWrappedDek(kek: Buffer, tenantId: string): {
  wrappedDek: Buffer;
  dek: Buffer;
} {
  const dek = newKey();
  const wrappedDek = encrypt(dek, kek, aadFor(tenantId));
  return { wrappedDek, dek };
}

/**
 * Re-derive the cleartext DEK from a wrapped blob. Performed once per
 * request by the gateway, then held in memory for the duration of the
 * request — never persisted.
 */
export function unwrapDek(
  wrappedDek: Buffer,
  kek: Buffer,
  tenantId: string,
): Buffer {
  return decrypt(wrappedDek, kek, aadFor(tenantId));
}

/**
 * Rewrap an existing DEK under a new KEK. Used by the Phase 23 KEK
 * rotation procedure: unwrap with the old KEK, wrap with the new KEK.
 * Ciphertext rows in ``vs_tokens`` are unaffected because the DEK
 * itself does not change.
 */
export function rewrapDek(
  wrappedDek: Buffer,
  oldKek: Buffer,
  newKek: Buffer,
  tenantId: string,
): Buffer {
  const dek = unwrapDek(wrappedDek, oldKek, tenantId);
  try {
    return encrypt(dek, newKek, aadFor(tenantId));
  } finally {
    // Best-effort zero of the unwrapped key once we're done with it.
    // Node Buffers are not guaranteed to clear pooled memory, but this
    // narrows the window during which the DEK lives in heap.
    dek.fill(0);
  }
}

function aadFor(tenantId: string): Buffer {
  return Buffer.from(`vs:tenant:${tenantId}`, 'utf8');
}
