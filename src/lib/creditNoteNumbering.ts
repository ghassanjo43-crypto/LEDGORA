import type { CreditNoteNumberingConfig } from '@/types/creditNote';
import { generateInvoiceNumber } from '@/lib/invoiceNumbering';

export interface GeneratedCreditNoteNumber {
  number: string;
  nextConfig: CreditNoteNumberingConfig;
}

/**
 * Produce the next entity-scoped credit-note number (e.g. CN-2026-0001) and the
 * advanced config. Reuses the invoice numbering algorithm — it already skips
 * numbers already in use (so VOIDED numbers are never reused) and handles the
 * annual sequence reset.
 */
export function generateCreditNoteNumber(
  config: CreditNoteNumberingConfig,
  usedNumbers: Set<string>,
  date: string = new Date().toISOString().slice(0, 10),
): GeneratedCreditNoteNumber {
  return generateInvoiceNumber(config, usedNumbers, date);
}

export function makeDefaultCreditNoteNumberingConfig(
  entityId: string,
  year = new Date().getFullYear(),
): CreditNoteNumberingConfig {
  return { entityId, prefix: 'CN', includeYear: true, sequenceLength: 4, nextSequence: 1, resetAnnually: true, sequenceYear: year };
}
