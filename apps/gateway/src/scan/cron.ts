/**
 * Tiny cron-expression evaluator — Phase 26 v1.9.
 *
 * Supports the standard 5-field syntax: ``minute hour dom month dow``.
 *
 *   *          — every value in range
 *   N          — exact value
 *   N-M        — range (inclusive)
 *   N,M,P      — list
 *   * /N       — step (every Nth value across the range)
 *   N-M/K      — stepped range
 *
 * Day-of-week 0–6 = Sunday-Saturday (matches the cron tradition).
 *
 * Times are evaluated in UTC. Returns ``null`` for ``nextAfter`` when
 * the expression matches nothing within 4 years — the caller treats
 * that as "disabled" and stops the scheduler row.
 *
 * No external dep so we stay tree-shake friendly and don't pull in
 * timezone files. Operators write cron exprs in UTC; the SPA renders
 * the next-run time in browser-local for display.
 */

interface FieldSet {
  values: Set<number>;
}

interface CronExpr {
  minute: FieldSet;
  hour: FieldSet;
  dom: FieldSet;
  month: FieldSet;
  dow: FieldSet;
}

const RANGES: Record<keyof CronExpr, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
};

export class CronParseError extends Error {
  override readonly name = 'CronParseError';
}

export function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      `cron expression must have 5 fields, got ${parts.length.toString()}`,
    );
  }
  return {
    minute: parseField(parts[0]!, ...RANGES.minute),
    hour: parseField(parts[1]!, ...RANGES.hour),
    dom: parseField(parts[2]!, ...RANGES.dom),
    month: parseField(parts[3]!, ...RANGES.month),
    dow: parseField(parts[4]!, ...RANGES.dow),
  };
}

function parseField(raw: string, min: number, max: number): FieldSet {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    expandPart(part, min, max, out);
  }
  if (out.size === 0) {
    throw new CronParseError(`empty field: ${raw}`);
  }
  return { values: out };
}

function expandPart(
  part: string,
  min: number,
  max: number,
  out: Set<number>,
): void {
  let step = 1;
  let body = part;
  const slash = part.indexOf('/');
  if (slash !== -1) {
    body = part.slice(0, slash);
    const stepStr = part.slice(slash + 1);
    step = Number(stepStr);
    if (!Number.isInteger(step) || step <= 0) {
      throw new CronParseError(`invalid step in field: ${part}`);
    }
  }
  let rangeStart = min;
  let rangeEnd = max;
  if (body === '*') {
    // already min..max
  } else if (body.includes('-')) {
    const [s, e] = body.split('-');
    rangeStart = Number(s);
    rangeEnd = Number(e);
    if (
      !Number.isInteger(rangeStart) ||
      !Number.isInteger(rangeEnd) ||
      rangeStart < min ||
      rangeEnd > max ||
      rangeStart > rangeEnd
    ) {
      throw new CronParseError(`invalid range in field: ${part}`);
    }
  } else {
    const single = Number(body);
    if (!Number.isInteger(single) || single < min || single > max) {
      throw new CronParseError(`out-of-range value in field: ${part}`);
    }
    rangeStart = single;
    rangeEnd = single;
  }
  for (let v = rangeStart; v <= rangeEnd; v += step) {
    out.add(v);
  }
}

/**
 * Return the next UTC Date after ``from`` (exclusive) that matches
 * the cron expression. Searches up to 4 years out; returns null if
 * no match.
 */
export function nextAfter(expr: CronExpr, from: Date): Date | null {
  // Start one minute past ``from`` (cron expressions don't fire
  // twice in the same minute).
  const start = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      from.getUTCHours(),
      from.getUTCMinutes() + 1,
      0,
      0,
    ),
  );
  const horizon = start.getTime() + 4 * 366 * 24 * 60 * 60 * 1000;
  const cur = new Date(start);
  while (cur.getTime() < horizon) {
    const month = cur.getUTCMonth() + 1;
    if (!expr.month.values.has(month)) {
      // Skip to first day of the next month.
      cur.setUTCMonth(cur.getUTCMonth() + 1, 1);
      cur.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const dom = cur.getUTCDate();
    const dow = cur.getUTCDay();
    if (!expr.dom.values.has(dom) || !expr.dow.values.has(dow)) {
      cur.setUTCDate(dom + 1);
      cur.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const hour = cur.getUTCHours();
    if (!expr.hour.values.has(hour)) {
      cur.setUTCHours(hour + 1, 0, 0, 0);
      continue;
    }
    const minute = cur.getUTCMinutes();
    if (!expr.minute.values.has(minute)) {
      cur.setUTCMinutes(minute + 1, 0, 0);
      continue;
    }
    return new Date(cur);
  }
  return null;
}

/** Convenience: parse + compute in one step. */
export function nextRun(expr: string, from: Date = new Date()): Date | null {
  return nextAfter(parseCron(expr), from);
}
