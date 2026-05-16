/**
 * Gateway runtime configuration. Loaded from env at boot, validated by
 * Zod. Any missing or malformed value causes a synchronous throw on
 * startup — fail-closed.
 */

import { z } from 'zod';

/**
 * Validate that a string is a URL with one of the allowed protocols.
 * v1.1.3 §review (S3): blocks file://, javascript://, gopher://, etc.
 * from sneaking into DATABASE_URL / REDIS_URL / ENGINE_URL if the env
 * is partially attacker-controlled (e.g., orchestration mis-config).
 */
function urlWithProtocol(allowed: readonly string[], envName: string) {
  return z
    .string()
    .min(1, `${envName} is required`)
    .refine(
      (v) => {
        try {
          const u = new URL(v);
          return allowed.includes(u.protocol);
        } catch {
          return false;
        }
      },
      `${envName} must use one of: ${allowed.join(', ')}`,
    );
}

const configSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: urlWithProtocol(['postgres:', 'postgresql:'], 'DATABASE_URL'),
  ENGINE_URL: urlWithProtocol(['http:', 'https:'], 'ENGINE_URL').default(
    'http://127.0.0.1:8000',
  ),
  /** AES-256-GCM master key, 32 bytes base64. Required for token-vault use. */
  VS_KEK: z.string().min(1, 'VS_KEK is required'),
  /** Commercial Anthropic API key. Verified at startup via /v1/models. */
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  /** Opt in to Zero Data Retention. Requires the ZDR addendum signed on
   *  the Anthropic account; the header alone doesn't activate ZDR. */
  ZDR_ENABLED: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .transform((v) => v === true || v === 'true')
    .default('false'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  /** Default request body cap (bytes); Phase 7 ceiling. */
  MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(1_048_576),
  /** Default session idle TTL in minutes. */
  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  /** Redis URL for rate-limit counters. */
  REDIS_URL: urlWithProtocol(['redis:', 'rediss:'], 'REDIS_URL').default(
    'redis://127.0.0.1:6379/0',
  ),
  /** Per-(tenant, app) request cap per minute. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  /** Per-tenant monthly spend cap in micro-dollars (USD * 1e6). */
  SPEND_CAP_MICRODOLLARS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(500_000_000),
  /** Periodic Anthropic key re-probe interval (ms). v1.1 §3.7. Set to
   *  0 to disable; default 15 minutes. The re-probe never crashes the
   *  gateway — failures are surfaced via structured warn logs and the
   *  next /v1/messages request fails closed via the existing 401/503
   *  paths. */
  ANTHROPIC_REPROBE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(900_000),
  /** Admin API key for /v1/admin/* (X-Admin-Key header). When unset,
   *  the admin API refuses every request with 401. v1.1 §3.3. */
  GATEWAY_ADMIN_KEY: z.string().min(1).optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type GatewayConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid gateway config: ${summary}`);
  }
  return parsed.data;
}
