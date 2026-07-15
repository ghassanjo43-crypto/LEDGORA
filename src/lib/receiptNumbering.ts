import type { ReceiptNumberingConfig } from '@/types/receipt';
import { generateInvoiceNumber } from '@/lib/invoiceNumbering';

export interface GeneratedReceiptNumber {
  number: string;
  nextConfig: ReceiptNumberingConfig;
}

/**
 * Produce the next entity-scoped receipt number (e.g. RCT-2026-0001) and the
 * advanced config. Reuses the invoice numbering algorithm — it already skips
 * numbers already in use (so posted/reversed/voided numbers are never reused)
 * and handles the annual sequence reset. Historical receipts are never renumbered.
 */
export function generateReceiptNumber(
  config: ReceiptNumberingConfig,
  usedNumbers: Set<string>,
  date: string = new Date().toISOString().slice(0, 10),
): GeneratedReceiptNumber {
  return generateInvoiceNumber(config, usedNumbers, date);
}

export function makeDefaultReceiptNumberingConfig(
  entityId: string,
  year = new Date().getFullYear(),
): ReceiptNumberingConfig {
  return { entityId, prefix: 'RCT', includeYear: true, sequenceLength: 4, nextSequence: 1, resetAnnually: true, sequenceYear: year };
}
