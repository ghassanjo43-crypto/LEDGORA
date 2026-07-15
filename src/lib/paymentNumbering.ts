import type { PaymentNumberingConfig } from '@/types/payment';
import { generateInvoiceNumber } from '@/lib/invoiceNumbering';

export interface GeneratedPaymentNumber {
  number: string;
  nextConfig: PaymentNumberingConfig;
}

/**
 * Produce the next entity-scoped payment number (e.g. PAY-2026-0001) and the
 * advanced config. Reuses the invoice numbering algorithm — it already skips
 * numbers already in use (so posted/reversed/voided numbers are never reused)
 * and handles the annual sequence reset. Historical payments are never renumbered.
 */
export function generatePaymentNumber(
  config: PaymentNumberingConfig,
  usedNumbers: Set<string>,
  date: string = new Date().toISOString().slice(0, 10),
): GeneratedPaymentNumber {
  return generateInvoiceNumber(config, usedNumbers, date);
}

export function makeDefaultPaymentNumberingConfig(
  entityId: string,
  year = new Date().getFullYear(),
): PaymentNumberingConfig {
  return { entityId, prefix: 'PAY', includeYear: true, sequenceLength: 4, nextSequence: 1, resetAnnually: true, sequenceYear: year };
}
