# Peer Review FAQ — Vibe Shield

The 15 questions a peer reviewer asks when they see "AI-assisted document processing" in the Firm's engagement letters, with answers and pointers to supporting artifacts.

---

**Q1. What AI provider does the Firm use, and under what contract?**
Anthropic, PBC, under Anthropic Commercial Terms of Service plus a signed Data Processing Addendum and (where eligible) the Zero Data Retention addendum. PDFs are in `compliance/vendor-due-diligence-binder/`.

**Q2. Does the AI provider see client-identifying information?**
No. Vibe Shield runs locally on the Firm's appliance and replaces names, account numbers, routing numbers, EINs, SSNs, ITINs, dates of birth, driver's-license numbers, and similar identifiers with opaque placeholders before any payload reaches Anthropic. The placeholder format is `<ENTITY_TYPE_N>`, e.g., `<US_SSN_3>`.

**Q3. How is the placeholder-to-cleartext mapping protected?**
Stored in a Postgres table (`vs_tokens.cleartext_encrypted`) under AES-256-GCM. Each tenant has its own Data Encryption Key, which is itself wrapped under an appliance-level Key Encryption Key. The KEK lives outside the database, mounted into the gateway container by the appliance secret manager. Documented in `compliance/encryption.md`.

**Q4. Can a Firm-internal user with database read access reverse-engineer the cleartext?**
No. Without the KEK they cannot unwrap the per-tenant DEK; without the DEK they cannot decrypt `cleartext_encrypted` and they cannot precompute the dedup hash either (HMAC-SHA-256 keyed by the DEK).

**Q5. What stops a misconfigured deployment from using a non-commercial Anthropic key?**
The gateway probes Anthropic's `/v1/models` endpoint at startup and refuses to start if the key returns 401 or 403. Documented in `apps/gateway/src/anthropic/probe.ts` and tested in `apps/gateway/tests/probe.test.ts`.

**Q6. What stops a Firm-internal user with admin UI access from disabling redaction "just for one call"?**
Nothing in the UI does that, by design. Redaction is mandatory for every `/v1/messages` call. Hard-rule #4 ("fail-closed: if redaction fails, the request fails") is enforced in `AnalyzerService.analyze()` (Python) and the gateway orchestrator. Disabling redaction would require a code change going through PR review with the recall/precision CI gate.

**Q7. How does the Firm know redaction is actually working?**
The recall/precision harness in `qa/recall_precision.py` runs on every PR and at quarterly review against a 34+ fixture synthetic corpus. Recall ≥ 0.99 for SSN/EIN/routing; ≥ 0.95 for names, addresses, emails, phones; ≥ 0.85 for business names. Reports in `qa/reports/`. CI fails any PR that regresses against the standing baseline.

**Q8. Where can I see the redaction in action?**
Run `make dev` to bring up the appliance components, then `curl -X POST http://localhost:8080/v1/messages` with a `Bearer vs_live_…` key. The `vs-session-id` response header points to the session whose `vs_audit` rows show what was processed. The cleartext payload to Anthropic is reconstructable from the request body + the engine's `/redact` output (also auditable through correlation IDs).

**Q9. What's the audit trail look like?**
`vs_audit` is a Postgres table with row-level UPDATE / DELETE triggers that raise on any mutation attempt. Each row carries the SHA-256 of the payload — never cleartext. Daily hash-chained digests are written to `compliance/audit-digests/` so any post-hoc tampering changes the published digest. Documented in `packages/schema/src/vault/audit-logger.ts`.

**Q10. What event types are audited?**
`request`, `reidentify`, `materialize`, `recognizer_miss`, `policy_change`, `session_create`, `session_purge`, `api_key_issue`, `api_key_revoke`, `spend_cap_breached`, `rate_limit_breached`, `commercial_key_probe`. The materialize event (Vibe Transactions Converter only) carries the output filename and SHA-256.

**Q11. How long is data retained?**
- Audit log: 7 years (matches CPA workpaper retention)
- Token vault: per-session, default 60-minute idle expiry; cascades on session delete
- Daily audit digests: 7 years on the file system + offline backup
- Vendor due-diligence binder: indefinite

**Q12. What happens if Anthropic suffers a breach?**
Anthropic does not hold the cleartext PII; their commercial DPA + ZDR addendum cover any incident on their side. Anthropic-held data is opaque tokens + non-identifying document content. The Firm's exposure on an Anthropic breach is the *structure* of the documents (which schemas, how many transactions, etc.) — not the identities.

**Q13. What happens if the Vibe Shield appliance itself is breached?**
That's the Firm's incident — see `compliance/incident-response-runbook.md` and the WISP §8. The KEK is the keystone: an attacker with disk access but no KEK cannot decrypt anything. An attacker with the KEK has effectively the same access as the Firm's senior IT staff, and the breach-notification calculus is the same as for any compromise of those credentials.

**Q14. Is there a way to verify the audit digests haven't been tampered with?**
Yes. `AuditLogger.computeDailyDigest(date)` recomputes the digest for any given day from the rows currently in `vs_audit`. Compare against the published file in `compliance/audit-digests/`. Mismatch = tampering or insertion. Append-only triggers prevent in-place modification.

**Q15. Can the Firm produce a per-client report of every AI-assisted operation that touched that client's data?**
Yes — query `vs_audit` filtered by `tenant_id` and the client's session window. The audit row payload hash plus the session metadata pins each operation to a specific client engagement. The Phase 13 admin UI exposes this as the "Audit log browser" view; the underlying SQL is also documented in this FAQ if a peer reviewer wants to verify directly.

---

## Where to find the supporting artifacts

| Question | File |
|---|---|
| Q1, Q12 | `compliance/vendor-due-diligence-binder/` |
| Q2, Q3, Q4 | `compliance/encryption.md`, `compliance/recognizers.md` |
| Q5 | `apps/gateway/src/anthropic/probe.ts`, `apps/gateway/tests/probe.test.ts` |
| Q6 | `BUILD_PLAN.md` §1 hard rules; `apps/engine/app/errors.py::EngineUnavailable`; `apps/gateway/src/proxy/orchestrator.ts` |
| Q7 | `qa/recall_precision.py`, `qa/reports/baseline.json`, `.shield-build/blockers.md::B1` |
| Q9, Q10 | `packages/schema/src/vault/audit-logger.ts`, `packages/schema/migrations/0001_initial.sql` (trigger) |
| Q11 | `compliance/wisp-section.md` §9 |
| Q13 | `compliance/incident-response-runbook.md` |
| Q14 | `packages/schema/src/vault/audit-logger.ts::computeDailyDigest` |
