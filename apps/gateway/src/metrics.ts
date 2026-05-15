/**
 * Prometheus metrics. Exposed at /metrics; scraped by appliance-local
 * Prometheus and visualized by Phase 19's Grafana dashboard.
 *
 * Metric naming: vs_gateway_<noun>_<unit>. Histograms use sensible
 * latency buckets in seconds.
 */

import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

// Default Node.js metrics (event loop lag, GC, heap, etc.)
collectDefaultMetrics({ register: registry, prefix: 'vs_gateway_' });

export const httpRequests = new Counter({
  name: 'vs_gateway_http_requests_total',
  help: 'Total HTTP requests handled by the gateway.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpLatency = new Histogram({
  name: 'vs_gateway_http_latency_seconds',
  help: 'HTTP request latency.',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
  registers: [registry],
});

export const proxyCalls = new Counter({
  name: 'vs_gateway_proxy_calls_total',
  help: 'Total /v1/messages calls (post-auth).',
  labelNames: ['tenant_id', 'app_id', 'model', 'status'] as const,
  registers: [registry],
});

export const tokensInput = new Counter({
  name: 'vs_gateway_anthropic_input_tokens_total',
  help: 'Sum of input tokens reported by Anthropic per call.',
  labelNames: ['tenant_id', 'app_id', 'model'] as const,
  registers: [registry],
});

export const tokensOutput = new Counter({
  name: 'vs_gateway_anthropic_output_tokens_total',
  help: 'Sum of output tokens reported by Anthropic per call.',
  labelNames: ['tenant_id', 'app_id', 'model'] as const,
  registers: [registry],
});

export const spendMicrodollars = new Counter({
  name: 'vs_gateway_spend_microdollars_total',
  help: 'Cumulative micro-dollar spend.',
  labelNames: ['tenant_id', 'app_id', 'model'] as const,
  registers: [registry],
});

export const recognizerMisses = new Counter({
  name: 'vs_gateway_recognizer_misses_total',
  help: 'Backstop catches Presidio missed.',
  labelNames: ['entity_type', 'severity'] as const,
  registers: [registry],
});

export const rateLimitBreaches = new Counter({
  name: 'vs_gateway_rate_limit_breaches_total',
  help: 'Per-tenant rate-limit breach count.',
  labelNames: ['tenant_id', 'app_id'] as const,
  registers: [registry],
});

export const spendCapBreaches = new Counter({
  name: 'vs_gateway_spend_cap_breaches_total',
  help: 'Per-tenant monthly spend-cap breach count.',
  labelNames: ['tenant_id'] as const,
  registers: [registry],
});

export const materializeEvents = new Counter({
  name: 'vs_gateway_materialize_events_total',
  help: 'Materialize endpoint invocations (addendum 16.5).',
  labelNames: ['tenant_id', 'app_id'] as const,
  registers: [registry],
});

export const engineLatency = new Histogram({
  name: 'vs_gateway_engine_latency_seconds',
  help: 'Engine /redact round-trip latency.',
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0],
  registers: [registry],
});

export const anthropicLatency = new Histogram({
  name: 'vs_gateway_anthropic_latency_seconds',
  help: 'Anthropic /v1/messages round-trip latency.',
  buckets: [0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0],
  registers: [registry],
});
