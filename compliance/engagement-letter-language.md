# Engagement Letter Language — AI / PII Disclosure Paragraph

Drop-in language firms add to their engagement letters when using Vibe apps backed by Vibe Shield. Tested against AICPA ET §1.700 confidentiality + state board model engagement-letter standards.

## General disclosure (use in every engagement letter)

> **AI-Assisted Document Processing.** The Firm uses an AI-assisted document processing service operated through a privacy gateway hosted on the Firm's own infrastructure ("Vibe Shield"). Before any client-identifying information is sent to a third-party AI provider, Vibe Shield replaces names, account numbers, routing numbers, employer identification numbers, social security numbers, and similar identifiers with opaque placeholders. The third-party AI provider receives only the placeholders and the non-identifying portions of the document. The Firm holds the local key that maps placeholders back to the original values; the AI provider does not. The Firm uses Anthropic, PBC under Anthropic's Commercial Terms of Service and a signed Data Processing Addendum, with Zero Data Retention enabled where eligible.

## Bank-statement / Transaction-Converter specific (Addendum)

Append the following paragraph if the engagement includes converting bank or credit card statements:

> **Statement Conversion.** When converting bank or credit card statements (PDF → CSV / OFX / QFX / QBO), account numbers, holder names, and transaction memos are tokenized by Vibe Shield before any AI processing. The third-party AI provider never receives identifiable account or holder information. The final converted file restores the original values from a local key held only by the Firm — necessary because accounting software requires real account numbers to import. The Firm logs every output-file generation event for the Firm's compliance audit trail.

## Image / signature handling (Addendum)

Append if engagement includes scanned documents (e.g., signed engagement letters, check images):

> **Image Redaction.** When the Firm processes scanned documents through AI-assisted analysis, faces, signatures, machine-readable bar codes (which can encode account information), and identifiable text regions are masked locally before any image is sent to the AI provider. The original document is retained by the Firm under the Firm's existing record-retention policy and is not transmitted in unredacted form.

## Client right to opt out

Append:

> **Client Election.** A Client may elect at any time to have AI-assisted processing disabled for their engagement; in that case, the Firm will perform the relevant work using standard non-AI methods, and the Firm's fee estimate may change accordingly. The Client may make this election in writing to the Firm at any time during the engagement.

## Where to put it

These paragraphs go in the **Service Description** section of the engagement letter. The "Client Election" paragraph belongs in the **Client Responsibilities** or **Termination** section depending on the firm's standard letter structure.

## What this disclosure does NOT do

- It does not waive AICPA confidentiality obligations. The Firm remains responsible for AI-assisted output the same as for any other workpaper.
- It does not establish the AI provider as a "successor practitioner" under §1.700.060.
- It does not relieve the Firm of breach-notification duties under FTC Safeguards Rule §314.4(j) or applicable state law.

For the Firm's full compliance posture, see `compliance/wisp-section.md` (the WISP integration text), `compliance/peer-review-faq.md` (peer-review prep), and the underlying compliance memo.
