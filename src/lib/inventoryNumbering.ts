/**
 * Entity-specific document/movement numbering. Sequences are derived from the
 * existing records so they stay stable across reloads without a mutable counter.
 */

export type InventorySeqPrefix = 'GRN' | 'GIN' | 'TRF' | 'ADJ' | 'CNT' | 'MOV' | 'OPN';

function year(date?: string): number {
  return date ? new Date(`${date}T00:00:00Z`).getUTCFullYear() : new Date().getUTCFullYear();
}

/**
 * Next number of the form `PREFIX-YYYY-####` given the existing numbers. The
 * running sequence is per prefix+year.
 */
export function nextNumber(prefix: InventorySeqPrefix, existing: string[], date?: string): string {
  const y = year(date);
  const re = new RegExp(`^${prefix}-${y}-(\\d+)$`);
  let max = 0;
  for (const n of existing) {
    const m = re.exec(n.trim());
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${y}-${String(max + 1).padStart(4, '0')}`;
}
