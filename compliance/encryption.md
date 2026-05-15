# Vibe Shield — Encryption at Rest

This file documents how Vibe Shield protects the cleartext side of the token vault. It supports peer-review questions about the firm's compliance with FTC Safeguards Rule §314.4(c)(3) ("encryption of customer information") and the AICPA confidentiality memo's "encrypted at rest with documented key management" requirement.

## Algorithm

**AES-256-GCM** (NIST SP 800-38D), 256-bit key, 96-bit nonce, 128-bit tag.

| Parameter | Value | Source |
|---|---|---|
| Cipher | AES-256-GCM | NIST FIPS 197 |
| Key length | 32 bytes (256 bits) | `KEY_LENGTH` |
| Nonce length | 12 bytes (96 bits) | `NONCE_LENGTH` — GCM-recommended; deviating costs an extra GHASH round |
| Tag length | 16 bytes (128 bits) | `TAG_LENGTH` — full strength; never truncated |
| Nonce policy | Fresh random per encrypt | Generated via `crypto.randomBytes` |
| AAD | Tenant ID for DEK wrapping | Binds the wrapped DEK to its owning tenant |

Storage layout (single `bytea` column): `nonce || ciphertext || tag`.

## Key hierarchy

```
                    ┌──────────────────────────────┐
                    │   KEK (Key Encryption Key)   │
                    │  256-bit, lives in env var   │
                    │      VS_KEK (base64)         │
                    └──────────────┬───────────────┘
                                   │ wraps
                  ┌────────────────┼────────────────┐
                  ▼                ▼                ▼
            ┌──────────┐     ┌──────────┐     ┌──────────┐
            │ DEK acme │     │  DEK B   │     │  DEK C   │   (per-tenant)
            │ wrapped  │     │ wrapped  │     │ wrapped  │   in vs_tenant_keys
            └────┬─────┘     └────┬─────┘     └────┬─────┘
                 │ encrypts       │                │
                 ▼                ▼                ▼
         vs_tokens rows    vs_tokens rows    vs_tokens rows
         for tenant acme   for tenant B      for tenant C
```

- The **KEK** lives outside the database. On the Vibe Appliance, it's mounted into the gateway container from the appliance secret manager as `VS_KEK`. The gateway refuses to start if `VS_KEK` is missing, empty, or not exactly 32 bytes base64.
- Each tenant has a **DEK** generated at tenant provisioning. The DEK is encrypted with the KEK and the tenant's `tenant_id` as Additional Authenticated Data, then stored in `vs_tenant_keys.wrapped_dek`. The cleartext DEK never touches disk.
- Per-request flow: the gateway loads `wrapped_dek`, unwraps with `VS_KEK` + `tenant_id` (AAD verifies it's the right tenant's blob), holds the cleartext DEK in memory for the request, and encrypts the request's cleartext PII before insert into `vs_tokens`.

## AAD binding

When wrapping a DEK, AAD = `"vs:tenant:<tenant_id>"`. This binds the wrapped blob to the row it lives in. Three concrete attack scenarios this defeats:

1. **Row copy across tenants.** An attacker with DB write access copies `vs_tenant_keys` row for tenant A into tenant B's row. Unwrap fails authentication because the AAD presented (B's ID) differs from the AAD bound at wrap time (A's ID).
2. **Wrapped-DEK swap between rows.** Same problem from the other direction — replace wrapped_dek bytes without changing tenant_id. The MAC tag was computed over the original tenant_id-as-AAD; unwrap fails.
3. **Cross-environment KEK reuse.** If the same KEK is used in dev and prod (it shouldn't be, but operator mistakes happen), AAD scoping limits the blast radius — production tenant blobs only unwrap if AAD matches the production tenant ID.

## Nonce policy and key lifetime

GCM is catastrophically insecure under nonce reuse: the keystream XORs out and the authentication subkey leaks. We use 96-bit random nonces, which means birthday-bound collision risk crosses ~2⁻³² at 2³² messages encrypted under the same key.

This puts a structural ceiling on KEK lifetime: **rotate the KEK well before 2³² wrap operations**. For a CPA firm doing ~10K bookkeeping transactions/day, that's ~12 million wraps/year, leaving headroom for ~350 years of operation per KEK — but rotation isn't motivated by exhaustion. It's motivated by:

- **Annual review** (Phase 22 checklist): rotate yearly as routine hygiene.
- **Suspected compromise**: rotate immediately. The `rewrapDek()` helper re-wraps each tenant's DEK under the new KEK; ciphertext in `vs_tokens` is untouched (the DEK itself didn't change).
- **Operator turnover**: if someone with KEK access leaves, rotate.

DEKs rotate independently if a tenant has a documented incident; the procedure is in `compliance/incident-response-runbook.md` (Phase 22).

## Dedup hash (`vs_token_index.hash`)

The token vault deduplicates within a session: the same cleartext fed to `TokenVault.allocate()` twice in the same session returns the same token. The index column that powers this lookup is HMAC-SHA-256, keyed by the tenant's DEK:

```
hash = HMAC-SHA-256(dek, sessionId || ":vs:" || cleartext)
```

Three properties this gives:

1. **Same cleartext, same session, same DEK → same hash.** This is what makes the index work.
2. **Same cleartext, different session → different hash.** Cross-session correlation by hash equality is impossible — Anthropic cannot stitch sessions back together by spotting identical hashes, even if they had read access to `vs_token_index`.
3. **Same cleartext, different tenant → different hash** (DEK differs per tenant). An attacker with read access to `vs_token_index` cannot stitch hashes across tenants either.

Critically: an attacker with read-only access to `vs_token_index` and *no DEK* cannot precompute hashes for likely PII values (e.g., a rainbow table of common SSNs). Plain SHA-256 of cleartext would be vulnerable to that attack; HMAC keyed by the per-tenant DEK is not. The integration test suite verifies all three properties in `tests/integration/token-vault.test.ts`.

## Cleartext non-appearance

These properties are tested in `packages/schema/tests/no-leak.test.ts`:

- No cleartext, key bytes, or base64 key strings appear on stdout or stderr during a full encrypt → wrap → unwrap → decrypt cycle.
- `CryptoError` messages on authentication failure do not include any portion of the input or key.

These are tests, not just discipline: the suite must pass on every PR.

## Limitations and scope

- **In-transit encryption.** Out of scope here — handled by TLS termination at the appliance ingress (Phase 21 Caddy config).
- **Key escrow.** No legal-hold key escrow in v1. Phase 5's "token vault export tool" produces an encrypted export bound to the current KEK; recovery requires `VS_KEK`.
- **HSM integration.** Out of scope for v1. The `VS_KEK` env var pattern is compatible with a KMS-fetched secret if the appliance later integrates one — change the loader, not the call sites.
- **Side channels.** Constant-time tag comparison is provided by Node's `crypto` module (which calls OpenSSL). We do not implement our own comparators.

## Verifying KEK presence

The gateway will probe `VS_KEK` at startup and refuse to serve if it's missing. To check locally:

```bash
node -e "const k=require('crypto').randomBytes(32).toString('base64'); console.log(k)"
export VS_KEK="<paste-output>"
```

A real appliance bootstrap script (Phase 21) fetches the KEK from the appliance secret manager and sources it into the gateway's environment.
