/**
 * Entity-specific manufacturing document numbering, derived from existing
 * numbers so sequences are stable across reloads without a mutable counter.
 */
function year(date?: string): number {
  return date ? new Date(`${date}T00:00:00Z`).getUTCFullYear() : new Date().getUTCFullYear();
}

/** Next `PREFIX-YYYY-####` for the given prefix, per prefix+year. */
export function nextMfgNumber(prefix: string, existing: string[], date?: string): string {
  const y = year(date);
  const re = new RegExp(`^${prefix}-${y}-(\\d+)$`);
  let max = 0;
  for (const n of existing) {
    const m = re.exec(n.trim());
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${y}-${String(max + 1).padStart(4, '0')}`;
}
