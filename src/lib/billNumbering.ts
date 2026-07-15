import type { BillNumberingConfig } from '@/types/bill';
import { generateInvoiceNumber } from '@/lib/invoiceNumbering';

export interface GeneratedBillNumber {
  number: string;
  nextConfig: BillNumberingConfig;
}

/**
 * Next entity-scoped internal bill number (e.g. BILL-2026-0001). Reuses the
 * invoice numbering algorithm — skips numbers already in use so posted/void/
 * reversed numbers are never reused, and handles the annual reset.
 */
export function generateBillNumber(
  config: BillNumberingConfig,
  usedNumbers: Set<string>,
  date: string = new Date().toISOString().slice(0, 10),
): GeneratedBillNumber {
  return generateInvoiceNumber(config, usedNumbers, date);
}

export function makeDefaultBillNumberingConfig(entityId: string, year = new Date().getFullYear()): BillNumberingConfig {
  return { entityId, prefix: 'BILL', includeYear: true, sequenceLength: 4, nextSequence: 1, resetAnnually: true, sequenceYear: year };
}
