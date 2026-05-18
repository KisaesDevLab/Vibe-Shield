/**
 * Gateway entry point. Wires real deps from env, starts the HTTP
 * server, registers graceful shutdown.
 *
 * Fail-closed startup contract:
 *   1. Config parse must succeed (zod-validated env).
 *   2. KEK must load (32 base64 bytes from VS_KEK).
 *   3. Anthropic key must pass the commercial-key probe.
 *   4. DB must accept the connection (lazy — the first /ready or
 *      first request fails if it doesn't).
 *   5. Redis must accept the connection (lazy — first quota check).
 * Any of 1-3 raises and the process exits before listening.
 */

import { Redis } from 'ioredis';
import {
  ApiKeyStore,
  ApplianceSecretStore,
  AuditLogger,
  MagicLinkStore,
  RecognizerMissStore,
  RedactJobStore,
  SessionManager,
  TokenVault,
  UserSessionStore,
  UserStore,
  createDatabase,
  loadKek,
} from '@kisaesdevlab/vibe-shield-schema';
import { AnthropicClientHolder } from './anthropic/holder.js';
import { probeAnthropicKey } from './anthropic/probe.js';
import { Mailer } from './auth/mailer.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { AnthropicKeyReprobe } from './anthropic/reprobe.js';
import { EngineClient } from './engine/client.js';
import { createLogger } from './logging.js';
import { PolicyResolver } from './policy/resolver.js';
import { PromptRegistry } from './prompts/registry.js';
import { RateLimiter } from './quota/rate-limiter.js';
import { SpendTracker } from './quota/spend-cap.js';
import { SpendRateLimiter } from './quota/spend-rate-limiter.js';
import { RedactPipeline } from './redact/pipeline.js';
import { JobStorage } from './redact/storage.js';
import { PerTenantKeyResolver } from './tenant-key/resolver.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const kek = loadKek();
  logger.info({ kek_status: 'loaded' }, 'kek loaded');

  const dbHandle = createDatabase(config.DATABASE_URL);
  const applianceSecrets = new ApplianceSecretStore(dbHandle.db, kek);

  // Phase 23.5: the operator-set Anthropic key in vs_appliance_settings
  // takes precedence over ANTHROPIC_API_KEY in env. Env remains the
  // bootstrap fallback for fresh installs where the operator hasn't yet
  // touched the admin UI.
  //
  // Fail-closed posture (review-pass v1.3): a decrypt failure on the
  // persisted ciphertext means the row is present but tampered with
  // or the KEK changed — that's a data-integrity problem we must NOT
  // paper over by silently falling back to env. Re-throw so the
  // gateway refuses to start until an operator clears the row or
  // rotates the KEK. ApplianceSettingsMissingError (row absent) is
  // still benign — log + fall through to env.
  let dbKey: Awaited<ReturnType<typeof applianceSecrets.getAnthropicKey>>;
  try {
    dbKey = await applianceSecrets.getAnthropicKey();
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === 'ApplianceSettingsMissingError'
    ) {
      logger.warn(
        { error_class: err.name },
        'vs_appliance_settings row missing; using env-backed Anthropic key',
      );
      dbKey = null;
    } else {
      // CryptoError / KekUnavailableError / unknown — fail closed.
      logger.fatal(
        { error_class: err instanceof Error ? err.name : 'Unknown' },
        'appliance-secrets decrypt failed; refusing to boot. ' +
          'Clear vs_appliance_settings.anthropic_api_key_ciphertext via ' +
          'the admin UI or rotate the KEK.',
      );
      throw err;
    }
  }
  const effectiveKey = dbKey?.plaintext ?? config.ANTHROPIC_API_KEY;
  const keySource: 'env' | 'db' = dbKey === null ? 'env' : 'db';

  const probe = await probeAnthropicKey({ apiKey: effectiveKey });
  logger.info(
    { models_visible: probe.models.length, key_source: keySource },
    'anthropic commercial-key probe ok',
  );

  const anthropicHolder = new AnthropicClientHolder({
    apiKey: effectiveKey,
    zdr: config.ZDR_ENABLED,
    meta: {
      source: keySource,
      setAt: dbKey?.setAt ?? null,
      fingerprint: dbKey?.fingerprint ?? null,
    },
  });

  const apiKeys = new ApiKeyStore(dbHandle.db);
  const sessions = new SessionManager(dbHandle.db);
  const tenantKeys = new PerTenantKeyResolver(dbHandle.db, kek);
  const vault = new TokenVault(dbHandle.db, tenantKeys);

  const engine = new EngineClient({ baseUrl: config.ENGINE_URL });

  const redis = new Redis(config.REDIS_URL, { lazyConnect: true });
  const rateLimiter = new RateLimiter({
    redis,
    defaultLimit: config.RATE_LIMIT_PER_MINUTE,
  });
  const spendTracker = new SpendTracker({
    db: dbHandle.db,
    defaultCapMicrodollars: BigInt(config.SPEND_CAP_MICRODOLLARS),
  });
  const spendRateLimiter = new SpendRateLimiter({
    redis,
    defaultCapMicrodollars: BigInt(config.SPEND_RATE_PER_MINUTE_MICRODOLLARS),
    logger,
  });

  // Phase 25 G2.6 — prompt template registry. Loaded from
  // PROMPTS_DIR when set. Missing directory loads empty (no consumer
  // yet — Phase 28 internal API lights it up).
  const promptRegistry = new PromptRegistry();
  if (config.PROMPTS_DIR !== undefined) {
    try {
      await promptRegistry.load(config.PROMPTS_DIR, (msg) =>
        logger.warn({ prompts_dir: config.PROMPTS_DIR }, msg),
      );
      logger.info(
        { prompts_dir: config.PROMPTS_DIR, loaded: promptRegistry.list().length },
        'prompt registry loaded',
      );
    } catch (err) {
      logger.warn(
        {
          prompts_dir: config.PROMPTS_DIR,
          error_class: err instanceof Error ? err.name : 'Unknown',
        },
        'prompt registry failed to load; serving empty',
      );
    }
  }

  const policies = new PolicyResolver(dbHandle.db);
  await policies.ensureLoaded();

  const audit = new AuditLogger(dbHandle.db);
  const recognizerMisses = new RecognizerMissStore(dbHandle.db);

  const reprobe = new AnthropicKeyReprobe({
    getApiKey: () => anthropicHolder.getApiKey(),
    intervalMs: config.ANTHROPIC_REPROBE_INTERVAL_MS,
    logger,
  });
  reprobe.start();

  // Phase 17 v1.4 — Redact module wiring.
  const redactJobStore = new RedactJobStore(dbHandle.db);
  const jobStorage = new JobStorage({ baseDir: config.REDACT_JOBS_DIR });
  const redactPipeline = new RedactPipeline({
    jobs: redactJobStore,
    engine,
    storage: jobStorage,
    audit,
    logger,
  });
  // Reap any jobs that were running when the gateway crashed.
  void redactJobStore
    .reapStaleRunning()
    .then((n) => {
      if (n > 0) {
        logger.warn({ count: n }, 'reaped stale running redact jobs');
      }
    })
    .catch(() => undefined);

  // Phase 24 — identity v2 wiring. Constructed unconditionally; the
  // auth routes themselves degrade gracefully when SMTP isn't set.
  const userStore = new UserStore(dbHandle.db);
  const userSessionStore = new UserSessionStore(
    dbHandle.db,
    config.SESSION_IDLE_TTL_MINUTES,
  );
  const magicLinkStore = new MagicLinkStore(
    dbHandle.db,
    config.MAGIC_LINK_TTL_MINUTES,
  );

  // Optional SMTP — only construct the Mailer if SMTP_HOST is set.
  // When unset, /api/auth/request-link returns 503 with a clear
  // message and operators continue to use X-Admin-Key.
  let mailer: Mailer | undefined;
  if (config.SMTP_HOST !== undefined && config.SMTP_HOST !== '') {
    mailer = new Mailer({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      user: config.SMTP_USER,
      password: config.SMTP_PASSWORD,
      from: config.SMTP_FROM ?? `vibe-shield@${config.SMTP_HOST}`,
      tls: config.SMTP_TLS,
      logger,
    });
    try {
      await mailer.verify();
      logger.info({ host: config.SMTP_HOST }, 'smtp connection verified');
    } catch (err) {
      logger.warn(
        {
          host: config.SMTP_HOST,
          error_class: err instanceof Error ? err.name : 'Unknown',
        },
        'smtp verification failed; magic-link emails may fail',
      );
    }
  }

  // Bootstrap admin: on first boot, when no *active* user exists AND
  // BOOTSTRAP_ADMIN_EMAIL is set, create that user as is_org_admin=true
  // with admin role on every module.
  //
  // Idempotence (review-pass v1.3): counting *active* users (not all)
  // is what we want. If the bootstrap user was disabled, an appliance
  // restart should re-create them — otherwise the operator is locked
  // out. ``UserStore.countActive()`` excludes disabled rows.
  if (config.BOOTSTRAP_ADMIN_EMAIL !== undefined) {
    const existingActive = await userStore.countActive();
    if (existingActive === 0) {
      const bootstrap = await userStore.create({
        email: config.BOOTSTRAP_ADMIN_EMAIL,
        isOrgAdmin: true,
      });
      await Promise.all([
        userStore.setRole(bootstrap.id, 'redact', 'admin'),
        userStore.setRole(bootstrap.id, 'scan', 'admin'),
        userStore.setRole(bootstrap.id, 'compliance', 'admin'),
      ]);
      // System-actor audit so compliance can prove who created the
      // bootstrap admin and when. Best-effort: an audit-write failure
      // here must not block the gateway from starting.
      void audit
        .append({
          tenantId: 'appliance',
          eventType: 'user_created',
          module: 'identity',
          actorType: 'system',
          payload: {
            action: 'bootstrap_admin',
            user_id: bootstrap.id,
            email_domain: bootstrap.email.split('@')[1] ?? '?',
            is_org_admin: true,
          },
        })
        .catch(() => undefined);
      logger.info(
        { user_id: bootstrap.id, email_domain: bootstrap.email.split('@')[1] ?? '?' },
        'bootstrap admin created',
      );
    }
  }

  const app = createApp({
    db: dbHandle.db,
    apiKeys,
    sessions,
    vault,
    engine,
    anthropicHolder,
    rateLimiter,
    spendTracker,
    spendRateLimiter,
    promptRegistry,
    policies,
    zdrEnabled: config.ZDR_ENABLED,
    audit,
    recognizerMisses,
    applianceSecrets,
    bootstrapApiKey: config.ANTHROPIC_API_KEY,
    users: userStore,
    userSessions: userSessionStore,
    magicLinks: magicLinkStore,
    redactJobs: redactJobStore,
    redactStorage: jobStorage,
    redactPipeline,
    redactMaxUploadBytes: config.REDACT_MAX_UPLOAD_BYTES,
    ...(mailer !== undefined ? { mailer } : {}),
    ...(config.PUBLIC_URL !== undefined ? { publicUrl: config.PUBLIC_URL } : {}),
    logger,
    maxRequestBytes: config.MAX_REQUEST_BYTES,
    sessionTtlMinutes: config.SESSION_TTL_MINUTES,
    engineUrl: config.ENGINE_URL,
    reprobe,
    ...(config.GATEWAY_ADMIN_KEY !== undefined ? { adminKey: config.GATEWAY_ADMIN_KEY } : {}),
  });

  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info(
      {
        host: config.HOST,
        port: config.PORT,
        engine_url: config.ENGINE_URL,
        anthropic_reprobe_interval_ms: config.ANTHROPIC_REPROBE_INTERVAL_MS,
      },
      'gateway listening',
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    reprobe.stop();
    server.close(() => {
      tenantKeys.clear();
      void redis.quit().catch(() => undefined);
      void dbHandle.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const logger = createLogger();
  logger.fatal(
    { error_class: err instanceof Error ? err.name : 'Unknown' },
    'gateway startup failed',
  );
  process.exit(1);
});
