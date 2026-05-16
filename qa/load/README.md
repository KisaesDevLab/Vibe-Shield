# Load tests (v1.1 §3.10)

[k6](https://k6.io) scripts that exercise the gateway under sustained
load and compare measured percentiles against the BUILD_PLAN §19 SLOs.

## SLOs (BUILD_PLAN §19)

| Endpoint | P50 | P99 |
|---|---|---|
| `/redact` (engine, internal) | 80 ms | 300 ms |
| `/v1/messages` (gateway → Anthropic, end-to-end) | 150 ms | 600 ms |

The k6 scripts encode these as thresholds; a failed threshold exits
non-zero so CI can gate on it.

## Running

These scripts are **not** part of the per-PR CI run — load testing
against the real Anthropic API is expensive and rate-limited. They're
intended for:

1. Pre-release smoke (run by hand against a staging gateway pointing
   at a paid Anthropic account).
2. Performance-regression investigation (drop into the loop when
   diagnosing a P99 spike).

```bash
# Engine /redact (no Anthropic call; pure redaction throughput).
ENGINE_URL=http://localhost:8000 k6 run qa/load/engine-redact.js

# Gateway /v1/messages (full path; needs an issued API key + Anthropic key).
GATEWAY_URL=http://localhost:8080 \
  GATEWAY_API_KEY=sk-vs-... \
  k6 run qa/load/gateway-messages.js
```

## What each script does

- **`engine-redact.js`**: 30 VU × 60 s sustained against `/redact` with a
  rotation of synthetic CPA payloads. Validates engine throughput +
  P50/P99 without any Anthropic dependency.
- **`gateway-messages.js`**: 5 VU × 60 s against `/v1/messages` with a
  small Anthropic prompt. Bounded to 5 VU because the gateway's default
  rate limit is 60 req/min/tenant; raise both if you want to push
  harder. Validates the end-to-end path (redact → vault → Anthropic →
  re-id).

## Hard rules in force

- Test prompts are synthetic. No real client data. Use the same
  Faker-derived fixtures from `qa/corpus/synthetic/`.
- The scripts log only HTTP status + duration. Never the response body.
- Failed-threshold k6 runs exit 1 — don't ship a perf regression.
