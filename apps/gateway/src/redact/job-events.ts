/**
 * In-memory job-event broker — v1.5 SSE backbone.
 *
 * The pipeline emits progress events (``page_started``, ``page_completed``,
 * ``job_completed``, ``job_failed``) to this broker; the SSE handler at
 * ``GET /v1/redact/jobs/:id/stream`` subscribes and forwards the events
 * to the browser via Server-Sent Events.
 *
 * Memory hygiene: subscribers are bound to a specific ``job_id`` and
 * auto-clean on disconnect. We don't replay history — a late
 * subscriber that connects after the job finished will see nothing on
 * the stream; the SPA's fallback is to poll ``GET /v1/redact/jobs/:id``
 * for the final state.
 *
 * Process-local only: this is fine for the single-gateway-process
 * deployment Vibe Shield ships as. A multi-process deployment would
 * need Redis pub/sub here — not v1.5 scope.
 */

import { EventEmitter } from 'node:events';

export interface RedactJobEvent {
  /** The job UUID. */
  jobId: string;
  type:
    | 'page_started'
    | 'page_completed'
    | 'job_completed'
    | 'job_failed';
  /** 1-indexed page number for per-page events; absent for job-level events. */
  page?: number;
  /** Total pages, populated as soon as the engine reports it. */
  totalPages?: number;
  /** When type='job_failed'. */
  errorMessage?: string;
  /** Per-page tokens-extracted count; surfaced for live UX. */
  tokensCount?: number;
  ts: string;
}

const TOPIC = 'redact-event';

export class RedactJobEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // 1 listener per concurrent SPA session is fine; bump cap.
    this.emitter.setMaxListeners(200);
  }

  emit(event: RedactJobEvent): void {
    this.emitter.emit(TOPIC, event);
  }

  /**
   * Subscribe to events for one job. Returns an unsubscribe function
   * — the SSE handler should call it on connection close.
   */
  subscribe(
    jobId: string,
    handler: (event: RedactJobEvent) => void,
  ): () => void {
    const wrapped = (event: RedactJobEvent): void => {
      if (event.jobId === jobId) {
        handler(event);
      }
    };
    this.emitter.on(TOPIC, wrapped);
    return () => {
      this.emitter.off(TOPIC, wrapped);
    };
  }
}
