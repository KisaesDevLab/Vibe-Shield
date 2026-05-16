/**
 * Config-validation tests (v1.1.3 §review S3).
 *
 * Each *_URL env var must reject protocols outside its allowlist —
 * blocks file://, javascript://, gopher:// from sneaking in via
 * partially-attacker-controlled orchestration env.
 */

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@h:5432/d',
  VS_KEK: 'PzM=',  // arbitrary base64; not validated for KEK length by loadConfig
  ANTHROPIC_API_KEY: 'sk-ant-test',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig URL validation (review S3)', () => {
  it('accepts postgres:// DATABASE_URL', () => {
    const cfg = loadConfig({ ...BASE_ENV, DATABASE_URL: 'postgres://u:p@h/d' });
    expect(cfg.DATABASE_URL).toBe('postgres://u:p@h/d');
  });

  it('accepts postgresql:// DATABASE_URL', () => {
    const cfg = loadConfig({ ...BASE_ENV, DATABASE_URL: 'postgresql://u:p@h/d' });
    expect(cfg.DATABASE_URL).toBe('postgresql://u:p@h/d');
  });

  it('rejects file:// DATABASE_URL', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, DATABASE_URL: 'file:///etc/passwd' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('rejects javascript: DATABASE_URL', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, DATABASE_URL: 'javascript:alert(1)' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('rejects gopher:// DATABASE_URL', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, DATABASE_URL: 'gopher://internal/' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('accepts http:// ENGINE_URL', () => {
    const cfg = loadConfig({ ...BASE_ENV, ENGINE_URL: 'http://engine:8000' });
    expect(cfg.ENGINE_URL).toBe('http://engine:8000');
  });

  it('accepts https:// ENGINE_URL', () => {
    const cfg = loadConfig({ ...BASE_ENV, ENGINE_URL: 'https://engine.internal/' });
    expect(cfg.ENGINE_URL).toBe('https://engine.internal/');
  });

  it('rejects file:// ENGINE_URL', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, ENGINE_URL: 'file:///tmp/engine' }),
    ).toThrow(/ENGINE_URL/);
  });

  it('accepts redis:// REDIS_URL', () => {
    const cfg = loadConfig({ ...BASE_ENV, REDIS_URL: 'redis://r:6379/0' });
    expect(cfg.REDIS_URL).toBe('redis://r:6379/0');
  });

  it('accepts rediss:// REDIS_URL', () => {
    const cfg = loadConfig({ ...BASE_ENV, REDIS_URL: 'rediss://r:6380/0' });
    expect(cfg.REDIS_URL).toBe('rediss://r:6380/0');
  });

  it('rejects http:// REDIS_URL', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, REDIS_URL: 'http://r:6379/' }),
    ).toThrow(/REDIS_URL/);
  });
});
