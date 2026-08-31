/**
 * Reading a SQL `date` back as the date it actually is.
 *
 * ══ Why this test exists ═════════════════════════════════════════════════════
 *
 * The suite cannot catch the bug this guards. PGlite returns `date` columns as
 * STRINGS, so every code path that mishandles a `Date` looks correct against it;
 * `node-postgres` returns a `Date` at LOCAL midnight, and `.toISOString()` on
 * that yields the PREVIOUS day east of Greenwich. An invoice dated 2026-03-01
 * came back as 2026-02-28 — and, once read and written again, 2026-02-27.
 *
 * It was found by the disposable real-PostgreSQL probe. These cases pin the fix
 * without needing a database at all, by handing the converter the `Date` a real
 * driver would have produced.
 *
 * The stakes are not cosmetic: `issue_date` is the ledger posting date, the date
 * period locks are enforced against, what UBL emits as cbc:IssueDate, and the
 * date a tax rate is resolved on.
 */
import { describe, it, expect } from 'vitest';
import { toCalendarDate, toCalendarDateOrNull } from '../src/services/accounting/calendarDate.js';

/** What `node-postgres` hands back for a bare `date`: LOCAL midnight. */
const asDriverWouldReturn = (year: number, month: number, day: number): Date =>
  new Date(year, month - 1, day, 0, 0, 0, 0);

describe('a date column read back from a real driver', () => {
  it('keeps the calendar date, not the UTC instant', () => {
    /* The exact failure the probe caught. */
    expect(toCalendarDate(asDriverWouldReturn(2026, 3, 1))).toBe('2026-03-01');
  });

  it('survives a read/write round trip without drifting', () => {
    /* The compounding case: a value read wrongly and stored again lost a
     * SECOND day, which is how 2026-03-01 became 2026-02-27. */
    let value: string = toCalendarDate(asDriverWouldReturn(2026, 3, 1));
    for (let i = 0; i < 5; i += 1) {
      const [y, m, d] = value.split('-').map(Number);
      value = toCalendarDate(asDriverWouldReturn(y!, m!, d!));
    }
    expect(value).toBe('2026-03-01');
  });

  it('pads single-digit months and days', () => {
    expect(toCalendarDate(asDriverWouldReturn(2026, 1, 5))).toBe('2026-01-05');
  });

  it('handles a year boundary, where a UTC shift changes the YEAR', () => {
    expect(toCalendarDate(asDriverWouldReturn(2026, 1, 1))).toBe('2026-01-01');
  });

  it('handles a leap day', () => {
    expect(toCalendarDate(asDriverWouldReturn(2028, 2, 29))).toBe('2028-02-29');
  });

  it('passes a string through untouched, as PGlite returns', () => {
    expect(toCalendarDate('2026-03-01')).toBe('2026-03-01');
  });

  it('takes only the date from a timestamp rendered as text', () => {
    expect(toCalendarDate('2026-03-01T22:30:00.000Z')).toBe('2026-03-01');
  });
});

describe('the nullable form', () => {
  it('preserves null rather than inventing an empty date', () => {
    expect(toCalendarDateOrNull(null)).toBeNull();
    expect(toCalendarDateOrNull(undefined)).toBeNull();
    expect(toCalendarDateOrNull('')).toBeNull();
  });

  it('still converts a real value', () => {
    expect(toCalendarDateOrNull(asDriverWouldReturn(2026, 7, 1))).toBe('2026-07-01');
  });
});
