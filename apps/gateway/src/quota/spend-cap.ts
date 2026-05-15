/**
 * Per-tenant monthly spend cap.
 *
 * Pricing model: input/output token counts come from Anthropic's
 * response. We multiply by published per-token prices to get a
 * micro-dollar cost. The current month's accumulated cost is
 * compared against the cap before each call. Over the cap → throw.
 *
 * Pricing is a static map per model. When Anthropic changes prices,
 * update PRICING and redeploy — past records keep their original cost
 * value, future records use the new price.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import {
  type Database,
  spendRecords,
} from '@kisaesdevlab/vibe-shield-schema';

export class SpendCapExceededError extends Error {
  override readonly name = 'SpendCapExceededError';
  constructor(
    readonly capMicrodollars: bigint,
    readonly currentMicrodollars: bigint,
  ) {
    super(
      `monthly spend cap exceeded: $${(Number(currentMicrodollars) / 1_000_000).toFixed(2)}` +
        ` of $${(Number(capMicrodollars) / 1_000_000).toFixed(2)}`,
    );
  }
}

interface ModelPrice {
  /** Cost per 1M input tokens, in micro-dollars. */
  inputPerMillion: bigint;
  /** Cost per 1M output tokens, in micro-dollars. */
  outputPerMillion: bigint;
}

// Snapshot of Anthropic's published list prices as of the build date.
// Update on the annual review (Phase 22 checklist).
export const PRICING: Record<string, ModelPrice> = {
  // Claude 4.6 Sonnet
  'claude-sonnet-4-6': { inputPerMillion: 3_000_000n, outputPerMillion: 15_000_000n },
  'claude-sonnet-4-6-20251001': { inputPerMillion: 3_000_000n, outputPerMillion: 15_000_000n },
  // Claude 4.7 Opus
  'claude-opus-4-7': { inputPerMillion: 15_000_000n, outputPerMillion: 75_000_000n },
  // Claude 4.5 Haiku
  'claude-haiku-4-5-20251001': { inputPerMillion: 800_000n, outputPerMillion: 4_000_000n },
  // Legacy aliases — older Vibe app deploys may still send these names.
  'claude-3-5-sonnet-20241022': { inputPerMillion: 3_000_000n, outputPerMillion: 15_000_000n },
  'claude-3-5-haiku-20241022': { inputPerMillion: 800_000n, outputPerMillion: 4_000_000n },
};

const FALLBACK_PRICE: ModelPrice = {
  inputPerMillion: 15_000_000n,
  outputPerMillion: 75_000_000n,
};

export function priceFor(model: string, inputTokens: number, outputTokens: number): bigint {
  const p = PRICING[model] ?? FALLBACK_PRICE;
  return (
    (BigInt(inputTokens) * p.inputPerMillion) / 1_000_000n +
    (BigInt(outputTokens) * p.outputPerMillion) / 1_000_000n
  );
}

export interface SpendTrackerDeps {
  db: Database;
  /** Cap in micro-dollars per tenant per month. Default $500/mo. */
  defaultCapMicrodollars?: bigint;
}

export class SpendTracker {
  private readonly defaultCap: bigint;

  constructor(private readonly deps: SpendTrackerDeps) {
    this.defaultCap = deps.defaultCapMicrodollars ?? 500_000_000n;
  }

  /**
   * Check the cap before a call. Sums the current calendar month and
   * throws if the configured cap is reached. Per-tenant override
   * passed via ``cap``.
   */
  async checkCap(tenantId: string, cap?: bigint): Promise<void> {
    const ceiling = cap ?? this.defaultCap;
    const monthStart = startOfCurrentMonth();
    const rows = await this.deps.db
      .select({
        total: sql<string>`COALESCE(SUM(${spendRecords.costMicrodollars}), 0)::text`,
      })
      .from(spendRecords)
      .where(
        and(eq(spendRecords.tenantId, tenantId), gte(spendRecords.createdAt, monthStart)),
      );
    const total = BigInt(rows[0]?.total ?? '0');
    if (total >= ceiling) {
      throw new SpendCapExceededError(ceiling, total);
    }
  }

  /** Record a completed call's cost. Called after Anthropic returns. */
  async record(args: {
    tenantId: string;
    appId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }): Promise<void> {
    const cost = priceFor(args.model, args.inputTokens, args.outputTokens);
    await this.deps.db.insert(spendRecords).values({
      tenantId: args.tenantId,
      appId: args.appId,
      model: args.model,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      costMicrodollars: cost.toString(),
    });
  }

  /** Diagnostics: current month spend in micro-dollars. */
  async currentMonthSpend(tenantId: string): Promise<bigint> {
    const monthStart = startOfCurrentMonth();
    const rows = await this.deps.db
      .select({
        total: sql<string>`COALESCE(SUM(${spendRecords.costMicrodollars}), 0)::text`,
      })
      .from(spendRecords)
      .where(
        and(eq(spendRecords.tenantId, tenantId), gte(spendRecords.createdAt, monthStart)),
      );
    return BigInt(rows[0]?.total ?? '0');
  }
}

function startOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
}
