/**
 * Engine /redact load test (v1.1 §3.10).
 *
 * Pure redaction throughput — no Anthropic call. Validates BUILD_PLAN
 * §19 SLOs:
 *   P50 < 80 ms, P99 < 300 ms for /redact
 *
 * 30 virtual users × 60s sustained. Each request rotates through a
 * small set of synthetic CPA payloads. All payloads are pre-computed
 * at module load to keep the per-iteration cost dominated by the HTTP
 * round-trip + the engine's actual work.
 *
 * Run:
 *   ENGINE_URL=http://localhost:8000 k6 run qa/load/engine-redact.js
 */

import http from 'k6/http';
import { check, fail } from 'k6';

const ENGINE_URL = __ENV.ENGINE_URL || 'http://localhost:8000';

export const options = {
  scenarios: {
    redact: {
      executor: 'constant-vus',
      vus: 30,
      duration: '60s',
    },
  },
  thresholds: {
    // BUILD_PLAN §19 SLOs.
    'http_req_duration{endpoint:redact}': ['p(50)<80', 'p(99)<300'],
    // Hard rule: any non-200 from /redact = redaction failed = bug.
    'http_req_failed{endpoint:redact}': ['rate<0.001'],
  },
};

// Synthetic payloads — all PII is Faker-derived / non-issued ranges.
// Mirrors the qa/corpus/synthetic/bookkeeping.py shape.
const PAYLOADS = [
  { text: 'Statement for Maria Reyes, Account # 000123456789, Routing 021000021. Period 2026-04-01 to 2026-04-30.' },
  { text: 'Taxpayer Hector Diaz, SSN 234-56-7890, was contacted on April 12 about the 1099-NEC discrepancy.' },
  { text: 'Entity Acme Bookkeeping LLC, EIN 82-1234567, filed a Form 1065 for tax year 2025.' },
  { text: 'Client contact: Sarah Lin, sarah.lin@example.com, (415) 555-0142. Schedule the QBR.' },
  { text: 'For 2025 returns, taxpayer Derrick Johnson (SSN 234-56-7890) is sole owner of Acme LLC (EIN 12-3456789). Routing 011000015.' },
];

const params = {
  headers: { 'content-type': 'application/json' },
  tags: { endpoint: 'redact' },
};

export default function () {
  const payload = PAYLOADS[Math.floor(Math.random() * PAYLOADS.length)];
  const res = http.post(`${ENGINE_URL}/redact`, JSON.stringify(payload), params);
  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'has redacted_text': (r) => r.json('redacted_text') !== undefined,
  });
  if (!ok) {
    // Don't dump the body (might contain cleartext if redaction errored
    // before mask). Just status + duration.
    fail(`/redact failed: status=${res.status} duration=${res.timings.duration}ms`);
  }
}
