/**
 * Cron parser — Phase 26 v1.9 unit test.
 */

import { describe, expect, it } from 'vitest';
import { CronParseError, nextRun, parseCron } from '../src/scan/cron.js';

describe('cron parser', () => {
  it('rejects expressions with the wrong field count', () => {
    expect(() => parseCron('* * * *')).toThrow(CronParseError);
    expect(() => parseCron('* * * * * *')).toThrow(CronParseError);
  });

  it('rejects out-of-range values', () => {
    expect(() => parseCron('60 * * * *')).toThrow(CronParseError);
    expect(() => parseCron('* 24 * * *')).toThrow(CronParseError);
  });

  it("computes the next run for '0 6 * * *' (daily 06:00 UTC)", () => {
    const from = new Date('2026-05-19T05:00:00.000Z');
    const next = nextRun('0 6 * * *', from);
    expect(next?.toISOString()).toBe('2026-05-19T06:00:00.000Z');
  });

  it('rolls into the next day when past the hour', () => {
    const from = new Date('2026-05-19T07:00:00.000Z');
    const next = nextRun('0 6 * * *', from);
    expect(next?.toISOString()).toBe('2026-05-20T06:00:00.000Z');
  });

  it("supports '*/15 * * * *' (every 15 minutes)", () => {
    const from = new Date('2026-05-19T05:07:00.000Z');
    const next = nextRun('*/15 * * * *', from);
    expect(next?.toISOString()).toBe('2026-05-19T05:15:00.000Z');
  });

  it('supports day-of-week restriction (Mon-Fri 9am)', () => {
    // 2026-05-18 is a Monday in our calendar.
    const from = new Date('2026-05-18T08:00:00.000Z');
    const next = nextRun('0 9 * * 1-5', from);
    expect(next?.toISOString()).toBe('2026-05-18T09:00:00.000Z');
    // From Saturday → Monday.
    const fromSat = new Date('2026-05-23T08:00:00.000Z');
    const nextMon = nextRun('0 9 * * 1-5', fromSat);
    expect(nextMon?.toISOString()).toBe('2026-05-25T09:00:00.000Z');
  });

  it('supports lists in fields', () => {
    const from = new Date('2026-05-19T04:30:00.000Z');
    const next = nextRun('0 6,12,18 * * *', from);
    expect(next?.toISOString()).toBe('2026-05-19T06:00:00.000Z');
    const next2 = nextRun('0 6,12,18 * * *', next!);
    expect(next2?.toISOString()).toBe('2026-05-19T12:00:00.000Z');
  });
});
