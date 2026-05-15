# Vibe Shield — Annual Review Checklist

Performed once per year by the Firm's compliance lead, with engineering support. Target: complete in a single 4-hour session.

---

## 1. Vendor due diligence

- [ ] Download current snapshot of Anthropic Trust Center → `compliance/vendor-due-diligence-binder/anthropic-trust-center-<YYYY-MM-DD>.pdf`
- [ ] Verify Anthropic Commercial Terms version on file matches the current published version
- [ ] Verify DPA on file is the current version
- [ ] Verify ZDR addendum on file (if Firm is on ZDR)
- [ ] Snapshot Anthropic's published per-token prices; update `apps/gateway/src/quota/spend-cap.ts::PRICING` if changed
- [ ] Update `compliance/vendor-due-diligence-binder/README.md` with the review date

## 2. Key rotation

- [ ] Generate new `VS_KEK` per the runbook
- [ ] Re-wrap every tenant's DEK under the new KEK (script in `packages/schema/scripts/`)
- [ ] Verify a smoke-test request roundtrips successfully
- [ ] Destroy the old KEK in the secret manager
- [ ] Update `compliance/key-rotation-log.md` with date + operator

## 3. Recall / precision recertification

- [ ] Run `cd apps/engine && PYTHONPATH=../.. uv run python -m qa.recall_precision`
- [ ] Compare against last year's `qa/reports/annual-review-<prior-year>.json`
- [ ] If recall regressed on any entity type, file an issue tagged `recall-regression`
- [ ] Add 10+ new synthetic fixtures to the corpus (generated, never real client data)
- [ ] Save the new report as `qa/reports/annual-review-<YYYY>.json`

## 4. Audit log integrity

- [ ] Spot-check 10 daily digests from the past year against recomputed values
- [ ] Verify no UPDATE / DELETE attempts succeeded against `vs_audit` (Postgres `pg_stat_user_tables` for the table should show 0 mods beyond INSERT)
- [ ] Confirm offline backup of `compliance/audit-digests/` exists and is readable

## 5. Engagement letter language

- [ ] Re-read `compliance/engagement-letter-language.md` against current state-board model letters
- [ ] Update if any state issued new AI-disclosure guidance during the year
- [ ] Confirm all active clients' engagement letters carry the current version

## 6. WISP

- [ ] Re-read `compliance/wisp-section.md` against the current FTC Safeguards Rule (no amendments require updates as of v1.0)
- [ ] Confirm the Firm's WISP binder includes the latest version
- [ ] Update §4 "Known noise items" if v1.1 has shipped fixes

## 7. Penetration test

- [ ] Schedule with the Firm's regular pentest vendor
- [ ] Scope must include: appliance host, Vibe Shield gateway, engine, token vault DB
- [ ] Out-of-scope: Anthropic (covered by their own SOC 2)
- [ ] Findings → `compliance/pentest/<YYYY>-<vendor>.pdf`

## 8. Incident-response rehearsal

- [ ] Tabletop walkthrough of `compliance/incident-response-runbook.md`
- [ ] Cover one Class C scenario (KEK compromise) end-to-end
- [ ] Document in `compliance/incidents/rehearsal-<YYYY>.md`
- [ ] If the rehearsal revealed a gap in the runbook, fix the runbook in the same session

## 9. Workforce training

- [ ] Verify all Firm staff who interact with Vibe apps have completed the privacy-explainer training in the past year
- [ ] New-hire training material updated against any v1.x feature changes

## 10. Sign-off

- [ ] Compliance lead signs the annual-review summary
- [ ] Filed under `compliance/annual-reviews/<YYYY>.md`
- [ ] Cited in next year's WISP binder
