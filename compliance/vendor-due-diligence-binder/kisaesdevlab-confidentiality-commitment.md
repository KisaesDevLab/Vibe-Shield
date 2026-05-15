# KisaesDevLab Confidentiality Commitment

KisaesDevLab is the maintainer of Vibe Shield. This document records the maintainer's commitments to Firms that deploy Shield on their own infrastructure.

## What KisaesDevLab can see

By default, **nothing**. Vibe Shield is self-hosted on the Firm's appliance. The Firm holds the database, the KEK, the audit log, and every bit of cleartext that ever existed on the system. KisaesDevLab does not operate any cloud component of Vibe Shield.

## Support access

When the Firm explicitly requests support — for example, by opening an issue on the public repo or contacting `support@kisaesdevlab.com` — the support engagement may include:

1. Reviewing Firm-supplied diagnostic bundles (these contain redacted logs only — Vibe Shield's diagnostic exporter never includes cleartext).
2. Tailscale access to the appliance, granted by the Firm and revocable at any time. Tailscale sessions are audited by Tailscale itself; the Firm sees who connected and when.
3. Direct screen-share or pair-debugging sessions arranged by the Firm.

KisaesDevLab does not have standing access to any Firm appliance. Every support session is initiated by the Firm and timeboxed.

## What KisaesDevLab will not do

- Will not request copies of the Firm's `vs_audit` table, token vault, or any cleartext data.
- Will not request the Firm's `VS_KEK`, Anthropic API key, or any credential.
- Will not retain Firm logs or diagnostic data past the close of a support engagement.
- Will not use Firm-derived information to train models, improve recognizers, or for any purpose other than the support engagement that produced it.

## Recognizer improvements

If the Firm voluntarily contributes a synthetic test fixture (no real client data, generated from Faker or non-issued ranges), KisaesDevLab may incorporate it into the public QA corpus to benefit other Firms. The Firm controls whether to contribute; nothing is automatic.

## Breach notification

If KisaesDevLab discovers a vulnerability in Vibe Shield that could compromise Firm-held data, the maintainer will publish a security advisory at `https://github.com/KisaesDevLab/Vibe-Shield/security/advisories` within 24 hours of confirmation, and notify Firms via the support channel before public disclosure where the maintainer has a contact.

---

Signed:
KisaesDevLab — maintainer of Vibe Shield
