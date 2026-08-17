/** Validate a date value crossing a persistence/API boundary without normalizing it. */
export function parseSafeDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!day) return null;
  const year = Number(day[1]);
  const month = Number(day[2]);
  const date = Number(day[3]);
  const calendarCheck = new Date(Date.UTC(year, month - 1, date));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== date
  ) return null;
  const parsed = new Date(text.length === 10 ? `${text}T00:00:00Z` : text);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function isSafeDate(value: unknown): value is string {
  return parseSafeDate(value) !== null;
}

