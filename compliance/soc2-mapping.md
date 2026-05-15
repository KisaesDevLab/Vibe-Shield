# SOC 2 Trust Service Criteria — Vibe Shield Coverage

For Firms whose clients ask "does the Firm's AI tooling support SOC 2?", this maps Vibe Shield controls to each TSC the Firm typically relies on.

Vibe Shield itself is not SOC 2-audited (it's the Firm's tool, not a service provider). Anthropic's SOC 2 covers the cloud AI side. This document records what Shield contributes to the Firm's own SOC 2 posture.

| TSC | Criterion | Vibe Shield contribution |
|---|---|---|
| **CC1** | Control Environment | Hard rules in `BUILD_PLAN.md` are the system's compliance posture; written, version-controlled, code-enforced. |
| **CC2** | Communication & Information | `CHANGELOG.md` per phase; `compliance/wisp-section.md` for Firm-internal communication; engagement-letter language for client communication. |
| **CC3** | Risk Assessment | Risk register in `BUILD_PLAN.md` §7 + `ADDENDUM_TO_BUILD.md` §6; reassessed at each phase. |
| **CC4** | Monitoring | Prometheus metrics (`vs_gateway_*`); audit log + daily hash-chained digests; recall/precision quarterly recertification. |
| **CC5** | Control Activities | Append-only `vs_audit` trigger; CI hard-rule-2 lint; recall/precision CI gate; commercial-key probe at startup. |
| **CC6.1** | Logical access — restrict | `vs_live_…` API keys, SHA-256-hashed at rest; per-tenant DEK isolation; per-row tenant scoping. |
| **CC6.2** | Logical access — provision | Admin UI issues / revokes keys; cleartext shown exactly once. |
| **CC6.3** | Logical access — review | Key list + last_used_at visible in admin UI; quarterly review per the WISP. |
| **CC6.6** | Logical access — restrict to authorized | Cross-tenant lookups always return 404, never 403. |
| **CC6.7** | Logical access — encryption | AES-256-GCM at rest; TLS in transit at the appliance ingress. |
| **CC6.8** | Logical access — change management | All changes via PR with required CI; no manual production patches. |
| **CC7.1** | System operations — capacity | Per-tenant rate limit + monthly spend cap; metrics for capacity planning. |
| **CC7.2** | System operations — monitoring | `/metrics` + Grafana dashboard. |
| **CC7.3** | System operations — recovery | Postgres point-in-time recovery; encrypted backups only; KEK held off-host. |
| **CC7.4** | System operations — change | CI workflows enforce green build. |
| **CC8.1** | Change management | Reviewed & merged via PR; `BUILD_PLAN.md` phase model. |
| **CC9.1** | Risk mitigation — vendors | Anthropic Commercial Terms + DPA + ZDR addendum on file. |
| **CC9.2** | Risk mitigation — incidents | `compliance/incident-response-runbook.md`. |
| **A1.1** | Availability — operations | Health + readiness endpoints; graceful shutdown. |
| **A1.2** | Availability — monitoring | Same as CC4. |
| **A1.3** | Availability — recovery | DB backups; KEK rotation procedure preserves DEKs. |
| **C1.1** | Confidentiality — identification | Recognizers + backstops detect every covered PII type; `compliance/recognizers.md`. |
| **C1.2** | Confidentiality — disposal | Session purge cascades vault; manual purge endpoint; default 60-min idle. |
| **PI1.1** | Processing integrity — input | Zod schema validation on every gateway request. |
| **PI1.2** | Processing integrity — processing | Recall/precision CI gate enforces redaction quality. |
| **PI1.3** | Processing integrity — output | Re-identification per documented policy; audit event per call. |
| **PI1.4** | Processing integrity — exceptions | `EngineUnavailable` exception + sanitized error envelopes; never returns half-redacted output. |
| **P1** through **P8** | Privacy criteria | Covered if the Firm relies on the Privacy TSC: Shield is the privacy tool. Each P-criterion maps to one or more rows above. |

## What Shield does NOT cover for SOC 2

- The Firm's **own** identity provider integration (Okta / Google Workspace / etc.) is the Firm's responsibility.
- **Physical security** of the appliance hardware (NucBox M6 in a locked cabinet, etc.) is the Firm's responsibility.
- **Workforce training** records are the Firm's responsibility — Shield provides the technical control; training that staff know to use it is the Firm's HR program.
- **Vendor risk management** for non-Anthropic AI providers — Shield is single-provider in v1.0.

For an external SOC 2 audit, point the auditor at this file plus the WISP section, the encryption doc, the recognizer doc, the peer-review FAQ, and the vendor due-diligence binder.
