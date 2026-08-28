/**
 * @vitest-environment happy-dom
 */
/**
 * `useStore.settings` as a cache, not an authority.
 *
 * ══ What these prove ═════════════════════════════════════════════════════════
 *
 * Every accounting-meaning setting now lives on the server. The store holds the
 * last answer so screens render synchronously and decides nothing. So: a
 * cleared browser comes back identical; a save is written through and the cache
 * refreshed from what the SERVER returned rather than from what was sent; a
 * concurrent edit is reported rather than applied; and a failure leaves the
 * previous answer in place instead of inventing a fiscal year.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  hydrateCompanySettings,
  saveCompanySettings,
  resetCompanySettings,
  settingsVersion,
} from './companySettingsSync';
import { useStore, DEFAULT_SETTINGS } from '@/store/useStore';
import { setCsrfToken } from './api/client';

const fetchMock = vi.fn();

const ok = (body: unknown) => ({
  status: 200, ok: true,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
} as unknown as Response);

const failure = (status: number, code: string, message: string) => ({
  status, ok: false,
  headers: { get: () => null },
  text: async () => JSON.stringify({ error: { code, message } }),
} as unknown as Response);

const SERVER = {
  organizationId: 'org-1',
  companyId: 'co-1',
  fiscalYearStart: '04-01',
  booksStartDate: '2026-04-01',
  accountingBasis: 'accrual' as const,
  reportingFramework: 'IFRS_FOR_SMES' as const,
  taxRegistered: true,
  taxRegistrationNumber: 'TRN-77',
  defaultTaxRate: '16.0000',
  organizationType: 'LLC',
  industryType: 'construction',
  logoUrl: '',
  email: 'books@acme.test',
  phone: '+962',
  website: 'acme.test',
  country: 'JO',
  stateProvince: 'Amman',
  city: 'Amman',
  addressLine1: 'One Street',
  addressLine2: '',
  postalCode: '11118',
  version: 3,
};

const settingsBody = (over: Partial<typeof SERVER> = {}) => ({ settings: { ...SERVER, ...over } });
const lastBody = () => JSON.parse((fetchMock.mock.calls.at(-1)![1] as { body: string }).body);

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  fetchMock.mockReset();
  setCsrfToken('csrf');
  resetCompanySettings();
  useStore.getState().resetToDefault();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetCompanySettings();
});

describe('hydration', () => {
  it('replaces the cache with the server answer', async () => {
    fetchMock.mockResolvedValue(ok(settingsBody()));

    const result = await hydrateCompanySettings();
    expect(result.ok).toBe(true);

    const cached = useStore.getState().settings;
    expect(cached.fiscalYearStart).toBe('04-01');
    expect(cached.reportingFramework).toBe('IFRS_FOR_SMES');
    expect(cached.taxRegistrationNumber).toBe('TRN-77');
    expect(cached.defaultTaxRate).toBe(16);
    expect(settingsVersion()).toBe(3);
  });

  it('restores identical settings after the browser is cleared', async () => {
    fetchMock.mockResolvedValue(ok(settingsBody()));
    await hydrateCompanySettings();
    const before = { ...useStore.getState().settings };

    /*
     * A cleared browser. `resetToDefault()` deliberately does not touch
     * settings — they are no longer the store's to reset — so the built-in
     * defaults are applied explicitly to reproduce a first-load cache.
     */
    useStore.getState().updateSettings(DEFAULT_SETTINGS);
    resetCompanySettings();
    expect(useStore.getState().settings.fiscalYearStart).toBe('01-01');

    await hydrateCompanySettings();

    /* Identical, because the server held them all along. */
    const after = useStore.getState().settings;
    expect(after.fiscalYearStart).toBe(before.fiscalYearStart);
    expect(after.reportingFramework).toBe(before.reportingFramework);
    expect(after.booksStartDate).toBe(before.booksStartDate);
    expect(after.taxRegistrationNumber).toBe(before.taxRegistrationNumber);
  });

  it('keeps the previous answer when the server cannot be reached', async () => {
    fetchMock.mockResolvedValue(ok(settingsBody()));
    await hydrateCompanySettings();

    fetchMock.mockRejectedValue(new Error('offline'));
    const result = await hydrateCompanySettings();

    /*
     * Reported, not papered over. A screen that cannot reach the server must
     * say so rather than render a fiscal year nobody chose.
     */
    expect(result.ok).toBe(false);
    expect(useStore.getState().settings.fiscalYearStart).toBe('04-01');
  });
});

describe('saving', () => {
  it('writes through and refreshes from what the server returned', async () => {
    fetchMock.mockResolvedValueOnce(ok(settingsBody()));
    await hydrateCompanySettings();

    /* The server normalises and bumps the version. */
    fetchMock.mockResolvedValueOnce(ok(settingsBody({ fiscalYearStart: '07-01', version: 4 })));
    const result = await saveCompanySettings({ fiscalYearStart: '07-01' });

    expect(result.ok).toBe(true);
    expect(lastBody().expectedVersion).toBe(3);
    /* From the RESPONSE, not the request — the two can differ. */
    expect(useStore.getState().settings.fiscalYearStart).toBe('07-01');
    expect(settingsVersion()).toBe(4);
  });

  it('hydrates first when nothing has been read', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(settingsBody()))
      .mockResolvedValueOnce(ok(settingsBody({ city: 'Irbid', version: 4 })));

    const result = await saveCompanySettings({ city: 'Irbid' });

    expect(result.ok).toBe(true);
    /* A GET to learn the version, then the PATCH. */
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(lastBody().expectedVersion).toBe(3);
  });

  it('reports a concurrent edit instead of applying it', async () => {
    fetchMock.mockResolvedValueOnce(ok(settingsBody()));
    await hydrateCompanySettings();

    fetchMock.mockResolvedValueOnce(failure(
      409, 'conflict', 'These settings were changed by someone else.',
    ));
    const result = await saveCompanySettings({ fiscalYearStart: '07-01' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/changed by someone else/i);
    /* The losing value was NOT written into the cache. */
    expect(useStore.getState().settings.fiscalYearStart).toBe('04-01');
    expect(settingsVersion()).toBe(3);
  });

  it('reports a refusal from an unentitled workspace', async () => {
    fetchMock.mockResolvedValueOnce(ok(settingsBody()));
    await hydrateCompanySettings();

    fetchMock.mockResolvedValueOnce(failure(
      403, 'subscription_required_for_persistence',
      'Activate your subscription to save records permanently.',
    ));
    const result = await saveCompanySettings({ city: 'Irbid' });

    expect(result.ok).toBe(false);
    expect(useStore.getState().settings.city).toBe(SERVER.city);
  });

  it('never sends an accounting basis', async () => {
    fetchMock.mockResolvedValueOnce(ok(settingsBody()));
    await hydrateCompanySettings();
    fetchMock.mockResolvedValueOnce(ok(settingsBody({ version: 4 })));

    await saveCompanySettings({ city: 'Irbid' });

    /* Accrual is the only value the database permits; the client has no say. */
    expect(lastBody()).not.toHaveProperty('accountingBasis');
  });
});
