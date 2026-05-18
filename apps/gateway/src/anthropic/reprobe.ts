/**
 * Periodic Anthropic key re-probe (v1.1 §3.7).
 *
 * BUILD_PLAN §8 hard rule: the gateway probes the key at startup and
 * refuses to boot if it isn't a commercial key. v1.0 only ran the
 * probe once; if the key was revoked mid-day the gateway kept trying
 * Anthropic calls until restart. v1.1 adds a background interval
 * re-probe — every successful probe logs at debug; every failure
 * surfaces a structured warn-level audit event so the admin sees it
 * before the next paying request fails.
 *
 * The re-probe does NOT stop the server on failure. The next /v1/messages
 * request will fail closed via the orchestrator's existing 401 / 503
 * paths; we don't want to add a "gateway crashes when Anthropic blips"
 * failure mode that's worse than the current behavior.
 *
 * Default interval: 15 minutes. Configurable via
 * ``ANTHROPIC_REPROBE_INTERVAL_MS``. Set to 0 to disable (test envs).
 */

import type { Logger } from 'pino';

import {
  AnthropicUnreachableError,
  ConsumerKeyError,
  probeAnthropicKey,
} from './probe.js';

export interface ReprobeOptions {
  /**
   * Live accessor for the current Anthropic key. Phase 23.5 introduced
   * runtime key rotation via the admin UI; the reprobe loop pulls the
   * latest value each tick instead of capturing one at construction.
   */
  getApiKey: () => string;
  intervalMs: number;
  logger: Logger;
  /** Optional callback invoked after every probe (for tests + audit). */
  onProbe?: (result: { ok: true } | { ok: false; reason: string }) => void;
  /** Override probeAnthropicKey for tests. */
  probeFn?: typeof probeAnthropicKey;
}

export class AnthropicKeyReprobe {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly opts: ReprobeOptions;

  constructor(opts: ReprobeOptions) {
    this.opts = opts;
  }

  /**
   * Start the recurring probe. Returns immediately; the first probe
   * fires after ``intervalMs``, not at zero (the boot probe in
   * ``index.ts`` already covers t=0). No-op when ``intervalMs <= 0``.
   */
  start(): void {
    if (this.opts.intervalMs <= 0 || this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.opts.intervalMs);
    // Don't keep the event loop alive for the timer alone — graceful
    // shutdown should still exit.
    this.timer.unref?.();
  }

  /** For tests + the graceful-shutdown handler. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Run one probe. Exposed for tests and for the admin "probe now"
   * button in the v1.1 admin UI (§3.3).
   */
  async runOnce(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const probe = this.opts.probeFn ?? probeAnthropicKey;
    try {
      const r = await probe({ apiKey: this.opts.getApiKey() });
      this.opts.logger.debug(
        { models_visible: r.models.length },
        'anthropic key reprobe ok',
      );
      const result = { ok: true as const };
      this.opts.onProbe?.(result);
      return result;
    } catch (err) {
      const reason =
        err instanceof ConsumerKeyError
          ? 'consumer_key'
          : err instanceof AnthropicUnreachableError
            ? 'unreachable'
            : 'unknown';
      this.opts.logger.warn(
        { reason, error_class: err instanceof Error ? err.name : 'Unknown' },
        'anthropic key reprobe failed',
      );
      const result = { ok: false as const, reason };
      this.opts.onProbe?.(result);
      return result;
    }
  }
}
