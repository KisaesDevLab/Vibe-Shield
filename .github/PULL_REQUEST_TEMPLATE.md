<!--
Vibe Shield PR template. The redaction-recall question is required by Phase 1 of
BUILD_PLAN.md and is non-negotiable; PRs that touch recognizers, backstops, the
gateway orchestrator, or the engine pipeline cannot merge without an honest answer.
-->

## Summary

<!-- One paragraph: what changed, why. -->

## Phase

<!-- BUILD_PLAN.md phase this PR is part of, e.g. "Phase 4 — regex backstops". -->

## Compliance checklist

- [ ] No raw cleartext PII in logs, audit records, metrics, error messages, or fixtures
- [ ] No Anthropic-bound payload contains cleartext PII
- [ ] Fail-closed behavior preserved (no new bypass paths if redaction/engine fails)
- [ ] Real client data not introduced (only synthetic fixtures under `qa/corpus/`)
- [ ] If recognizers changed: `compliance/recognizers.md` updated with FP/FN rates

## Redaction recall regression run? (Y/N)

<!--
Required answer. If Y: paste the per-entity recall/precision delta vs. the
prior baseline. If N: justify why this PR cannot affect recall (e.g. docs-only,
admin UI styling). PRs touching apps/engine/, packages/schema/, or
apps/gateway/orchestrator/ may not answer N.
-->

**Answer:**

## Test plan

- [ ] `make verify` passes locally
- [ ] <!-- list any manual / integration steps -->

## Linked issues

<!-- Closes #N, refs #N -->
