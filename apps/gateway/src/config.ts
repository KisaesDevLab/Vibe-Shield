/**
 * Gateway runtime configuration. Loaded from env at boot, validated by
 * Zod. Any missing or malformed value causes a synchronous throw on
 * startup — fail-closed.
 */

import { z } from 'zod';

const configSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required'),
  ENGINE_URL: z.string().url().default('http://127.0.0.1:8000'),
  /** AES-256-GCM master key, 32 bytes base64. Required for token-vault use. */
  VS_KEK: z.string().min(1, 'VS_KEK is required'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  /** Default request body cap (bytes); Phase 7 ceiling. */
  MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(1_048_576),
  /** Default session idle TTL in minutes. */
  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(60),
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
