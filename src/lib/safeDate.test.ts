import { describe, expect, it } from 'vitest';
import { parseSafeDate } from './safeDate';
import { sanitizeSubscriptionDates } from './entitlementMigration';
import { createEnterpriseDevelopmentSubscription } from './entitlementMigration';

describe('persisted date recovery', () => {
  it.each([['bad'], [''], [null], [undefined], [{ value: '2026-01-01' }], ['2026-02-30']])(
    'rejects malformed persisted value %j',
    (value) => expect(parseSafeDate(value)).toBeNull(),
  );

  it('preserves valid ISO dates and drops only an invalid optional expiry', () => {
    const subscription = createEnterpriseDevelopmentSubscription('org', '2026-01-02T03:04:05.000Z');
    const valid = sanitizeSubscriptionDates({ ...subscription, expiresAt: '2026-12-31' });
    expect(valid.expiresAt).toBe('2026-12-31');
    expect(valid.startsAt).toBe('2026-01-02T03:04:05.000Z');

    const repaired = sanitizeSubscriptionDates({ ...subscription, expiresAt: { bad: true } } as never, '2026-08-17T00:00:00.000Z');
    expect(repaired.expiresAt).toBeUndefined();
    expect(repaired.startsAt).toBe(subscription.startsAt);
  });

  it('repairs only invalid required legacy dates with the supplied fallback', () => {
    const subscription = createEnterpriseDevelopmentSubscription('org', '2026-01-02T03:04:05.000Z');
    const repaired = sanitizeSubscriptionDates({ ...subscription, startsAt: '' }, '2026-08-17T00:00:00.000Z');
    expect(repaired.startsAt).toBe('2026-08-17T00:00:00.000Z');
    expect(repaired.createdAt).toBe(subscription.createdAt);
  });
});
