/**
 * Reading a SQL `date` back as the calendar date it actually is.
 *
 * ══ The bug this exists to prevent ═══════════════════════════════════════════
 *
 * `node-postgres` parses a bare `date` column into a JavaScript `Date` at LOCAL
 * midnight — there is no time or zone in the column, so it has to pick one, and
 * it picks the server's. Calling `.toISOString()` on that converts to UTC, and
 * east of Greenwich local midnight is the PREVIOUS day in UTC. An invoice dated
 * 2026-03-01 read on a UTC+3 machine comes back as 2026-02-28.
 *
 * It compounds: a value read that way and then written back loses another day
 * on the next round trip. That is not a display nuisance. `issue_date` is the
 * ledger's posting date, the date period locks are enforced against, the date
 * UBL emits as cbc:IssueDate, and — since S2c — the date the tax rate is
 * resolved on. A silent shift moves a document into a different period and can
 * charge it a different rate.
 *
 * PGlite returns these columns as STRINGS, so the whole class of error is
 * invisible to the test suite and only appears against a real server. It was
 * found by the disposable probe, which is the reason that probe exists.
 *
 * The fix is to read the local calendar components rather than converting to
 * UTC: the Date was built at local midnight, so its local year, month and day
 * are exactly the characters the column held.
 */

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * A `yyyy-mm-dd` string, whatever the driver handed back.
 *
 * Strings pass through untouched (PGlite, and any explicit cast) — only the
 * first ten characters, so a timestamp rendered as text cannot smuggle a time
 * in behind the date.
 */
export function toCalendarDate(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value ?? '').slice(0, 10);
}

/** The same, but preserving `null` rather than turning it into an empty string. */
export function toCalendarDateOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return toCalendarDate(value);
}
