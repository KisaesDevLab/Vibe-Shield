/**
 * PromptRegistry — Phase 25 G2.6.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptRegistry } from '../src/prompts/registry.js';

const VALID = `---
id: example.simple.v1
description: A trivial template
model_hint: claude-haiku-4-5
---

You are a helpful assistant.
Respond in JSON.
`;

const NO_ID = `---
description: missing id field
---

body
`;

const NO_FRONTMATTER = `Just a body, no frontmatter.`;

describe('PromptRegistry', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vs-prompts-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a valid template and computes its SHA', async () => {
    await writeFile(join(dir, 'one.md'), VALID);
    const r = new PromptRegistry();
    await r.load(dir);
    const t = r.get('example.simple.v1');
    expect(t).toBeDefined();
    expect(t!.id).toBe('example.simple.v1');
    expect(t!.description).toBe('A trivial template');
    expect(t!.modelHint).toBe('claude-haiku-4-5');
    expect(t!.body.startsWith('You are a helpful assistant.')).toBe(true);
    expect(t!.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('SHA changes when content changes', async () => {
    await writeFile(join(dir, 'a.md'), VALID);
    const r1 = new PromptRegistry();
    await r1.load(dir);
    const sha1 = r1.get('example.simple.v1')!.sha;

    // Replace with edited body — same id, different bytes.
    await writeFile(
      join(dir, 'a.md'),
      VALID.replace('helpful', 'unhelpful'),
    );
    const r2 = new PromptRegistry();
    await r2.load(dir);
    const sha2 = r2.get('example.simple.v1')!.sha;
    expect(sha2).not.toBe(sha1);
  });

  it('skips files without an id frontmatter', async () => {
    await writeFile(join(dir, 'good.md'), VALID);
    await writeFile(join(dir, 'no-id.md'), NO_ID);
    await writeFile(join(dir, 'no-front.md'), NO_FRONTMATTER);
    const warnings: string[] = [];
    const r = new PromptRegistry();
    await r.load(dir, (m) => warnings.push(m));
    expect(r.list().map((t) => t.id)).toEqual(['example.simple.v1']);
    expect(warnings.length).toBe(2);
  });

  it('throws on duplicate ids across files', async () => {
    await writeFile(join(dir, 'a.md'), VALID);
    await writeFile(join(dir, 'b.md'), VALID);
    const r = new PromptRegistry();
    await expect(r.load(dir)).rejects.toThrow(/duplicate prompt template id/);
  });

  it('load on a missing directory is a no-op (registry stays empty)', async () => {
    const r = new PromptRegistry();
    await r.load(join(dir, 'does-not-exist'));
    expect(r.list()).toEqual([]);
  });

  it('skips README.md and non-.md files', async () => {
    await writeFile(join(dir, 'README.md'), '# notes — not a template\n');
    await writeFile(join(dir, 'note.txt'), 'plain text');
    await writeFile(join(dir, 'real.md'), VALID);
    const r = new PromptRegistry();
    await r.load(dir);
    expect(r.list().map((t) => t.id)).toEqual(['example.simple.v1']);
  });

  it('rejects invalid id slugs', async () => {
    const bad = VALID.replace('example.simple.v1', 'Has Spaces!');
    await writeFile(join(dir, 'bad.md'), bad);
    const warnings: string[] = [];
    const r = new PromptRegistry();
    await r.load(dir, (m) => warnings.push(m));
    expect(r.list()).toEqual([]);
    expect(warnings.length).toBe(1);
  });

  it('fromInline is a test helper that computes SHAs from body alone', () => {
    const r = PromptRegistry.fromInline([
      { id: 'x.y.v1', description: null, modelHint: null, body: 'hello' },
    ]);
    const t = r.get('x.y.v1');
    expect(t).toBeDefined();
    expect(t!.sha).toMatch(/^[0-9a-f]{64}$/);
  });
});
