# Vibe Shield — Incident Response Runbook

When the Firm suspects a Vibe Shield compromise, follow these steps in order. Each step has a runtime ≤ 5 minutes; the full procedure ≤ 30 minutes if performed without interruption.

---

## 0. Triage (1 minute)

Determine which class of incident:

- **A.** Compromised `vs_live_…` API key (single tenant, single app)
- **B.** Compromised `ANTHROPIC_API_KEY`
- **C.** Compromised `VS_KEK` (worst case — every tenant's vault is at risk)
- **D.** Suspected unauthorized access to the appliance host

Class A is contained; B / C / D require the full procedure.

## 1. Stop the bleeding (5 minutes)

For Class A:
```bash
# Use the admin UI or the CLI:
gh shield key revoke <api-key-name> --tenant <tenant-id>
```

For Class B / C / D:
```bash
# Hard-stop the gateway. Vibe apps will surface "AI unavailable"; that's
# the desired fail-closed behavior.
docker compose --profile app stop gateway
```

## 2. Snapshot for investigation (5 minutes)

```bash
# Postgres dump for the audit table window of interest.
docker compose exec postgres pg_dump -U vibe -d vibe_shield \
  --table=vs_audit --table=vs_recognizer_misses \
  --where="created_at > NOW() - INTERVAL '30 days'" \
  > "incident-$(date -u +%Y%m%dT%H%M%SZ).sql"

# Engine + gateway logs.
docker compose logs --since 30d engine gateway > "logs-$(date -u +%Y%m%dT%H%M%SZ).txt"
```

## 3. Verify the audit chain (5 minutes)

```bash
# For each day in the suspected window:
for d in $(seq 0 30); do
  date=$(date -u -d "$d days ago" +%Y-%m-%d)
  # Recompute the digest from the live DB:
  pnpm --filter @kisaesdevlab/vibe-shield-schema exec node -e "
    import('./dist/index.js').then(async ({ AuditLogger, createDatabase }) => {
      const h = createDatabase(process.env.DATABASE_URL);
      const log = new AuditLogger(h.db);
      const d = await log.computeDailyDigest(new Date('$date'));
      console.log('$date', d.toString('hex'));
      await h.close();
    })
  "
  # Compare against the published file:
  diff <(echo "above output") "compliance/audit-digests/$date.txt"
done
```

Any mismatch = tampering or post-hoc insertion. Treat as confirmed Class C/D.

## 4. Rotate keys

### Class A — single API key

Already done in step 1 (`revoke`). Issue a new key for the affected app and notify the app owner out-of-band.

### Class B — Anthropic key

1. Generate a new commercial-grade key in the Anthropic console.
2. Update `ANTHROPIC_API_KEY` in the appliance secret manager.
3. Restart the gateway: `docker compose --profile app up -d gateway`.
4. Confirm the startup probe logs `anthropic commercial-key probe ok`.
5. Revoke the old key in the Anthropic console.
6. Audit Anthropic's dashboard for activity using the old key in the suspected window.

### Class C — VS_KEK (the keystone)

```bash
# 1. Generate the new KEK (keep the old one for the rewrap step!)
NEW_KEK=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
OLD_KEK="$VS_KEK"

# 2. Re-wrap every tenant's DEK under the new KEK. The DEK ITSELF doesn't
#    change, so vs_tokens.cleartext_encrypted is untouched — no
#    re-encryption of token rows needed.
node packages/schema/scripts/rewrap-keks.js \
  --old-kek="$OLD_KEK" --new-kek="$NEW_KEK"   # script lives with v1.1 admin tooling

# 3. Update the secret manager with the new KEK, restart the gateway.
# 4. Verify a smoke-test request roundtrips successfully.
# 5. Destroy the old KEK in the secret manager.
```

### Class D — appliance host compromise

1. Disconnect the appliance from the network.
2. Take a forensic image of the disk.
3. Treat as a full Class C: rotate KEK, regenerate every API key, audit every session in the relevant window.
4. Engage external incident response if the Firm doesn't have an in-house security team.

## 5. Notification

Per FTC Safeguards Rule §314.4(j) (effective May 2024): notify the FTC within **30 days** of a breach affecting unencrypted customer information of **500 or more consumers**.

Per applicable state law: timing varies. The strictest among the Firm's clients' jurisdictions controls.

Per AICPA ET §1.700.040: notify affected clients per the Firm's standard breach-notification process.

For Class A / B incidents where the audit chain confirms no cleartext PII reached an unauthorized party, the threshold may not be met. **Document the determination and the chain-of-evidence in writing.**

## 6. Post-incident

- File a `compliance/incidents/<date>-<class>.md` write-up with timeline, root cause, scope, customers affected (if any), and remediation.
- Update this runbook if the incident revealed a procedure gap.
- Schedule a Firm-wide debrief within 14 days.
- Add any newly discovered detection patterns to `qa/corpus/` so the QA harness catches similar issues going forward.

## Annual rehearsal

This runbook is rehearsed once per year. The rehearsal targets a Class C/D scenario and is documented in `compliance/incidents/rehearsal-<year>.md`. The rehearsal includes the audit-chain verification, the KEK rotation, and a tabletop walk-through of notification timing.
