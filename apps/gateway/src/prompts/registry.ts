/**
 * PromptRegistry — Phase 25 G2.6.
 *
 * Versioned, content-addressed prompt templates. Markdown files under
 * a directory; the registry loads them at startup, computes
 * SHA-256(content) for each, and exposes lookup by id. The egress
 * wrapper records the template SHA in the audit row so a future
 * reviewer can prove which prompt produced which extraction.
 *
 * v1 consumer: none yet — the internal API (Phase 28) calls
 * ``shield.redact.sync({ promptId: 'mybooks.bank_statement.v1' })``
 * and the orchestrator passes it through to ``getTemplate``. For now
 * we ship the registry + the admin "list templates" surface so the
 * Phase 28 work doesn't have to also build it.
 *
 * Template format:
 *
 *     ---
 *     id: mybooks.bank_statement.v1
 *     description: Categorize transactions in a bank statement
 *     model_hint: claude-sonnet-4-6
 *     ---
 *
 *     You are a CPA bookkeeping assistant. The user will provide …
 *
 * Front-matter is YAML-ish but parsed by hand to avoid pulling a YAML
 * dep. Keys we recognize: ``id`` (required, slug), ``description``
 * (optional, free text), ``model_hint`` (optional, advisory only —
 * the policy still gates the model allowlist). Unknown keys are
 * tolerated.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

export interface PromptTemplate {
  /** Slug from the template's id frontmatter, e.g. ``mybooks.bank_statement.v1``. */
  id: string;
  /** SHA-256 of the raw file bytes — for audit reproducibility. */
  sha: string;
  description: string | null;
  modelHint: string | null;
  /** Rendered body — everything after the frontmatter close. */
  body: string;
}

export interface PromptTemplateSummary {
  id: string;
  sha: string;
  description: string | null;
  modelHint: string | null;
}

export class PromptRegistry {
  private readonly byId = new Map<string, PromptTemplate>();

  /**
   * Load every ``*.md`` file under ``dir``. Files without a valid ``id``
   * frontmatter are skipped with a warn-level log (passed via the
   * optional ``onWarn`` hook). Duplicate ids throw.
   *
   * Resource limits (review-pass v1.3): each file capped at
   * ``MAX_TEMPLATE_BYTES`` (1 MB); each frontmatter value capped at
   * ``MAX_HEADER_VALUE_LENGTH`` (10 KB) so a pathological template
   * can't OOM the gateway at startup.
   */
  async load(
    dir: string,
    onWarn?: (msg: string) => void,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === 'ENOENT'
      ) {
        // No prompts directory is fine — registry is empty.
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      if (extname(entry).toLowerCase() !== '.md') continue;
      if (entry.toLowerCase() === 'readme.md') continue;
      const path = join(dir, entry);
      const raw = await readFile(path);
      if (raw.length > MAX_TEMPLATE_BYTES) {
        onWarn?.(
          `prompt template ${entry} exceeds ${MAX_TEMPLATE_BYTES.toString()} bytes; skipping`,
        );
        continue;
      }
      const parsed = parseTemplate(raw, onWarn);
      if (parsed === null) {
        onWarn?.(`prompt template ${entry} missing required id frontmatter`);
        continue;
      }
      if (this.byId.has(parsed.id)) {
        throw new Error(`duplicate prompt template id: ${parsed.id}`);
      }
      this.byId.set(parsed.id, parsed);
    }
  }

  get(id: string): PromptTemplate | undefined {
    return this.byId.get(id);
  }

  list(): PromptTemplateSummary[] {
    return Array.from(this.byId.values())
      .map((t) => ({
        id: t.id,
        sha: t.sha,
        description: t.description,
        modelHint: t.modelHint,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Test helper. */
  static fromInline(templates: Array<Omit<PromptTemplate, 'sha'>>): PromptRegistry {
    const r = new PromptRegistry();
    for (const t of templates) {
      const sha = createHash('sha256').update(t.body, 'utf8').digest('hex');
      r.byId.set(t.id, { ...t, sha });
    }
    return r;
  }
}

const SLUG_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Whole-file cap. 1 MB is enormous for a prompt; if you need more,
 *  you almost certainly want a different mechanism. */
const MAX_TEMPLATE_BYTES = 1_000_000;
/** Per-frontmatter-value cap. Protects the parser from a single
 *  pathological value that fills memory. */
const MAX_HEADER_VALUE_LENGTH = 10_000;
/** Frontmatter line cap. Bounds scan cost when ``---`` is missing. */
const MAX_HEADER_LINES = 100;

function parseTemplate(
  raw: Buffer,
  onWarn?: (msg: string) => void,
): PromptTemplate | null {
  const text = raw.toString('utf8').replace(/\r\n/g, '\n');
  const sha = createHash('sha256').update(raw).digest('hex');
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  let close = -1;
  // Bound the scan: if we don't see the closing fence within
  // MAX_HEADER_LINES, give up — likely a file without proper frontmatter.
  for (let i = 1; i < lines.length && i <= MAX_HEADER_LINES + 1; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return null;
  const headerLines = lines.slice(1, close);
  const body = lines.slice(close + 1).join('\n').trimStart();
  const header: Record<string, string> = {};
  for (const line of headerLines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip a single layer of surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH) {
      onWarn?.(
        `prompt template header value for "${key}" exceeds ${MAX_HEADER_VALUE_LENGTH.toString()} chars; skipping`,
      );
      return null;
    }
    if (key !== '') header[key] = value;
  }
  const id = header['id'];
  if (id === undefined || !SLUG_RE.test(id)) {
    return null;
  }
  return {
    id,
    sha,
    description: header['description'] ?? null,
    modelHint: header['model_hint'] ?? null,
    body,
  };
}
