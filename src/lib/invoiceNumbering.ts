import type { InvoiceNumberingConfig } from '@/types/invoice';

export interface GeneratedInvoiceNumber {
  number: string;
  nextConfig: InvoiceNumberingConfig;
}

function pad(n: number, length: number): string {
  return String(n).padStart(Math.max(1, length), '0');
}

function format(config: InvoiceNumberingConfig, seq: number, year: number): string {
  return [config.prefix, config.includeYear ? String(year) : '', pad(seq, config.sequenceLength)]
    .filter((p) => p !== '')
    .join('-');
}

/**
 * Produce the next entity-scoped invoice number (e.g. INV-2026-0001) and the
 * advanced numbering config. Skips any number already in use so VOIDED numbers
 * are never reused. Handles annual sequence reset.
 */
export function generateInvoiceNumber(
  config: InvoiceNumberingConfig,
  usedNumbers: Set<string>,
  date: string = new Date().toISOString().slice(0, 10),
): GeneratedInvoiceNumber {
  const year = Number(date.slice(0, 4)) || new Date().getFullYear();

  let seq = config.nextSequence;
  let sequenceYear = config.sequenceYear;
  if (config.resetAnnually && sequenceYear !== year) {
    seq = 1;
    sequenceYear = year;
  }

  let candidate = format(config, seq, year);
  while (usedNumbers.has(candidate)) {
    seq += 1;
    candidate = format(config, seq, year);
  }

  return {
    number: candidate,
    nextConfig: { ...config, nextSequence: seq + 1, sequenceYear },
  };
}

export function makeDefaultNumberingConfig(entityId: string, year = new Date().getFullYear()): InvoiceNumberingConfig {
  return { entityId, prefix: 'INV', includeYear: true, sequenceLength: 4, nextSequence: 1, resetAnnually: true, sequenceYear: year };
}
