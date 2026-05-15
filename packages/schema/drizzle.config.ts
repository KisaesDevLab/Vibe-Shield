import type { Config } from 'drizzle-kit';

// Phase 6 will plug the real DATABASE_URL via the gateway's env. For now
// drizzle-kit generate works without a live connection — it produces SQL
// from the schema definitions alone.
export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5432/vibe_shield',
  },
  strict: true,
  verbose: true,
} satisfies Config;
