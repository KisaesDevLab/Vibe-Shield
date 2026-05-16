/**
 * Gateway /v1/messages end-to-end load test (v1.1 §3.10).
 *
 * Full path: redact -> vault allocate -> Anthropic call -> re-id ->
 * audit -> response. Validates BUILD_PLAN §19 SLOs:
 *   P50 < 150 ms, P99 < 600 ms for /v1/messages
 *
 * 5 virtual users × 60s sustained. Bounded to 5 because the gateway's
 * default rate limit is 60 req/min/tenant — running 30 VU would
 * trigger 429s and skew the percentile data. For "find the ceiling"
 * runs, raise both this and RATE_LIMIT_PER_MINUTE on the target
 * gateway.
 *
 * Run:
 *   GATEWAY_URL=http://localhost:8080 \
 *     GATEWAY_API_KEY=sk-vs-... \
 *     k6 run qa/load/gateway-messages.js
 */

import http from 'k6/http';
import { check, fail } from 'k6';

const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://localhost:8080';
const API_KEY = __ENV.GATEWAY_API_KEY;
if (!API_KEY) {
  throw new Error('GATEWAY_API_KEY env var required');
}

export const options = {
  scenarios: {
    messages: {
      executor: 'constant-vus',
      vus: 5,
      duration: '60s',
    },
  },
  thresholds: {
    'http_req_duration{endpoint:messages}': ['p(50)<150', 'p(99)<600'],
    'http_req_failed{endpoint:messages}': ['rate<0.005'],
  },
};

// Small Anthropic call — keeps token cost low for sustained load.
const PROMPTS = [
  'List three CPA-relevant uses for Form 1099-NEC.',
  'Explain the difference between EIN and SSN in two sentences.',
  'What is a bank routing number?',
];

const params = {
  headers: {
    'content-type': 'application/json',
    'x-api-key': API_KEY,
  },
  tags: { endpoint: 'messages' },
};

export default function () {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [
      { role: 'user', content: PROMPTS[Math.floor(Math.random() * PROMPTS.length)] },
    ],
  };
  const res = http.post(
    `${GATEWAY_URL}/v1/messages`,
    JSON.stringify(body),
    params,
  );
  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'has content': (r) => Array.isArray(r.json('content')),
  });
  if (!ok) {
    fail(`/v1/messages failed: status=${res.status} duration=${res.timings.duration}ms`);
  }
}
