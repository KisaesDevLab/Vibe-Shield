/**
 * Scan SSE broker — v1.8 (mirrors RedactJobEvents).
 */

import { EventEmitter } from 'node:events';

export interface ScanJobEvent {
  jobId: string;
  type:
    | 'job_started'
    | 'file'
    | 'finding'
    | 'job_completed'
    | 'job_failed';
  /** When type='file': inner path; skipped flag. */
  path?: string;
  skipped?: boolean;
  /** When type='finding': entity_type + severity for UI counters. */
  entityType?: string;
  severity?: string;
  /** When type='job_completed': aggregate totals. */
  filesCount?: number;
  findingsCount?: number;
  /** When type='job_failed'. */
  errorMessage?: string;
  ts: string;
}

const TOPIC = 'scan-event';

export class ScanJobEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  emit(event: ScanJobEvent): void {
    this.emitter.emit(TOPIC, event);
  }

  subscribe(
    jobId: string,
    handler: (event: ScanJobEvent) => void,
  ): () => void {
    const wrapped = (event: ScanJobEvent): void => {
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
