/**
 * Public bank-name whitelist (Addendum 16.5.8).
 *
 * Bank/issuer names are not PII. Templates and statement classifiers
 * legitimately need to send "Chase" / "Wells Fargo" / "Amex" to
 * Anthropic to pick the right column layout. We bypass tokenization
 * for these.
 *
 * Static list is fine for v1 — covers the top US issuers that appear
 * in CPA bookkeeping flows. Operators can extend per-tenant via the
 * admin UI in v1.1.
 */

export const PUBLIC_BANK_NAMES: readonly string[] = [
  // Money-center banks
  'Chase', 'JPMorgan Chase', 'Bank of America', 'BofA', 'Wells Fargo',
  'Citibank', 'Citi', 'U.S. Bank', 'US Bank', 'PNC', 'PNC Bank', 'Truist',
  'Capital One', 'Goldman Sachs', 'Morgan Stanley',
  // Card issuers
  'American Express', 'Amex', 'Discover', 'Discover Card', 'Visa',
  'Mastercard', 'Synchrony', 'Synchrony Bank',
  // Regionals + military / federal credit unions
  'USAA', 'Navy Federal', 'Navy Federal Credit Union', 'NFCU',
  'Pentagon Federal', 'PenFed',
  'Charles Schwab', 'Schwab', 'Fidelity', 'Vanguard',
  'Ally Bank', 'Ally',
  'TD Bank', 'KeyBank', 'Huntington', 'Regions Bank', 'Fifth Third',
  'BB&T', 'M&T Bank', 'BMO', 'BMO Harris',
  // Credit unions / thrifts that show up nationally
  'State Farm Bank', 'USAA Federal Savings',
];

const NORMALIZED = new Set(PUBLIC_BANK_NAMES.map((n) => n.toLowerCase()));

/** Returns true if ``name`` is a public bank/issuer brand and may pass
 *  through to Anthropic without tokenization. */
export function isPublicBank(name: string): boolean {
  return NORMALIZED.has(name.trim().toLowerCase());
}
