/**
 * The organization's functional (base) currency.
 *
 * ══ What these protect ═══════════════════════════════════════════════════════
 *
 * Two things that are easy to get wrong and expensive to discover late:
 *
 *   the catalogue   a company must be able to keep its books in any currency in
 *                   current use, with that currency's REAL minor units. A
 *                   three-decimal dinar rounded to two is a rounding error on
 *                   every posting for the life of the ledger.
 *
 *   the lock        once anything is posted, changing the functional currency
 *                   re-labels history rather than converting it. The refusal
 *                   has to live in the write path, not in the form.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { STANDARD_CURRENCY_CATALOG, findCatalogEntry } from '@/data/currencyCatalog';
import { SEED_CURRENCIES } from '@/data/currencySeed';
import {
  FUNCTIONAL_CURRENCY_LOCKED_MESSAGE,
  guardFunctionalCurrencyChange,
  normalizeFunctionalCurrency,
  suggestedCurrencyForCountry,
} from '@/lib/functionalCurrency';
import { useStore, DEFAULT_SETTINGS } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import type { JournalEntry } from '@/types/journal';

/* ══ 2 · The canonical catalogue ═══════════════════════════════════════════ */

describe('the canonical ISO 4217 catalogue', () => {
  const isoFiat = STANDARD_CURRENCY_CATALOG.filter((c) => c.isIso && c.type === 'fiat');

  it('carries the complete set of currencies in current use, not a short list', () => {
    // The hand-maintained list this replaced had nine entries.
    expect(isoFiat.length).toBeGreaterThanOrEqual(160);
    expect(new Set(STANDARD_CURRENCY_CATALOG.map((c) => c.code)).size).toBe(STANDARD_CURRENCY_CATALOG.length);
  });

  it('includes every currency named in the requirement', () => {
    for (const code of ['JOD', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'KWD', 'QAR', 'BHD', 'OMR', 'CNY', 'JPY', 'CHF']) {
      const entry = findCatalogEntry(code);
      expect(entry, `${code} must be in the catalogue`).toBeDefined();
      expect(entry!.isIso).toBe(true);
    }
  });

  it('and a long tail well beyond the original nine', () => {
    for (const code of ['NZD', 'ZAR', 'BRL', 'MXN', 'THB', 'PLN', 'NOK', 'SEK', 'KES', 'NGN', 'LYD', 'TND']) {
      expect(findCatalogEntry(code), `${code}`).toBeDefined();
    }
  });

  /* ══ 14 · Minor-unit precision ══════════════════════════════════════════ */

  it('respects each currency’s real minor units, not a blanket two decimals', () => {
    const expected: Record<string, number> = {
      // Three-decimal currencies — the case a "money is 2dp" assumption breaks.
      JOD: 3, KWD: 3, BHD: 3, OMR: 3, IQD: 3, TND: 3, LYD: 3,
      // Zero-decimal currencies.
      JPY: 0, KRW: 0, ISK: 0, VND: 0, XAF: 0, XOF: 0, CLP: 0, RWF: 0, UGX: 0,
      // Ordinary two-decimal currencies.
      USD: 2, EUR: 2, GBP: 2, AED: 2, SAR: 2, CHF: 2, CNY: 2,
    };
    for (const [code, decimals] of Object.entries(expected)) {
      expect(findCatalogEntry(code)?.decimals, `${code} minor units`).toBe(decimals);
    }
  });

  it('does not take CLDR display digits as accounting precision', () => {
    /*
     * The trap this file exists to document. `Intl.NumberFormat` reports the
     * digits these currencies are commonly DISPLAYED with — zero — because that
     * is how they are quoted. ISO 4217 defines their minor units differently,
     * and the ledger must follow ISO or every posting is scaled wrongly.
     */
    const cldrSaysZeroButIsoDoesNot = ['IQD', 'HUF', 'IDR', 'PKR', 'LBP', 'SYP', 'YER', 'IRR', 'AFN', 'ALL'];
    for (const code of cldrSaysZeroButIsoDoesNot) {
      const displayDigits = new Intl.NumberFormat('en', { style: 'currency', currency: code })
        .resolvedOptions().maximumFractionDigits;
      expect(displayDigits, `${code} CLDR display digits`).toBe(0);
      expect(findCatalogEntry(code)?.decimals, `${code} ISO minor units`).toBeGreaterThan(0);
    }
    expect(findCatalogEntry('IQD')?.decimals).toBe(3);
  });

  it('seeds every ISO fiat currency as selectable', () => {
    // The picker only offers ACTIVE currencies, so the catalogue reaching the
    // store is what makes the full set choosable.
    const activeIso = SEED_CURRENCIES.filter((c) => c.status === 'active' && c.isIso);
    expect(activeIso.length).toBeGreaterThanOrEqual(160);
    expect(activeIso.find((c) => c.code === 'JOD')?.decimalPlaces).toBe(3);
  });
});

/* ══ 3–5 · Searching the catalogue ═════════════════════════════════════════ */

describe('currency search', () => {
  /** The same predicate the CurrencyPicker applies. */
  const search = (q: string) => {
    const query = q.trim().toLowerCase();
    return SEED_CURRENCIES.filter(
      (c) =>
        !query ||
        c.code.toLowerCase().includes(query) ||
        c.name.toLowerCase().includes(query) ||
        c.symbol.toLowerCase().includes(query) ||
        (c.region ?? '').toLowerCase().includes(query) ||
        (c.countryCodes ?? []).some((cc) => cc.toLowerCase() === query),
    );
  };

  it('3 · finds a currency by its ISO code', () => {
    expect(search('JOD').map((c) => c.code)).toContain('JOD');
    expect(search('jod')[0]?.name).toBe('Jordanian Dinar');
  });

  it('4 · finds currencies by name', () => {
    const dinars = search('dinar').map((c) => c.code);
    expect(dinars).toEqual(expect.arrayContaining(['JOD', 'KWD', 'BHD', 'IQD', 'TND', 'LYD']));
    expect(search('Euro').map((c) => c.code)).toContain('EUR');
  });

  it('5 · is case-insensitive and trims the query', () => {
    const lower = search('jordan').map((c) => c.code);
    const upper = search('JORDAN').map((c) => c.code);
    const padded = search('  jordan  ').map((c) => c.code);
    expect(lower).toEqual(upper);
    expect(padded).toEqual(lower);
    // A country query answered through the currency's own name.
    expect(lower).toContain('JOD');
  });

  it('finds a currency by country where the catalogue carries the metadata', () => {
    expect(search('United Arab Emirates').map((c) => c.code)).toContain('AED');
    expect(search('Euro area').map((c) => c.code)).toContain('EUR');
  });
});

/* ══ 5 · Country suggestion ════════════════════════════════════════════════ */

describe('country → currency suggestion', () => {
  it('suggests the usual currency for a country', () => {
    expect(suggestedCurrencyForCountry('JO')).toBe('JOD');
    expect(suggestedCurrencyForCountry('AE')).toBe('AED');
    expect(suggestedCurrencyForCountry('SA')).toBe('SAR');
    expect(suggestedCurrencyForCountry('US')).toBe('USD');
    expect(suggestedCurrencyForCountry('DE')).toBe('EUR');
  });

  it('offers nothing rather than guessing for an unmapped country', () => {
    expect(suggestedCurrencyForCountry('ZZ')).toBe('');
    expect(suggestedCurrencyForCountry('')).toBe('');
    expect(suggestedCurrencyForCountry(undefined)).toBe('');
  });
});

/* ══ 8 · Canonical storage form ════════════════════════════════════════════ */

describe('what is persisted', () => {
  it('stores the ISO code, never the display label', () => {
    expect(normalizeFunctionalCurrency('jod')).toBe('JOD');
    expect(normalizeFunctionalCurrency('  usd  ')).toBe('USD');
    // The label is display only; the code is the identifier.
    expect(findCatalogEntry('JOD')?.name).toBe('Jordanian Dinar');
    expect(normalizeFunctionalCurrency('Jordanian Dinar')).not.toBe('JOD');
  });
});

/* ══ 11–12 · The lock ══════════════════════════════════════════════════════ */

describe('changing the functional currency', () => {
  const postedEntry = (): JournalEntry =>
    ({ ...(useJournalStore.getState().entries[0] ?? {}), id: 'je-posted', status: 'posted' }) as JournalEntry;

  beforeEach(() => {
    useJournalStore.setState({ entries: [] });
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, baseCurrency: 'USD' } });
  });
  afterEach(() => {
    useJournalStore.setState({ entries: [] });
    useStore.setState({ settings: DEFAULT_SETTINGS });
  });

  it('11 · can change freely before anything is posted', () => {
    const result = useStore.getState().updateSettings({ baseCurrency: 'JOD' });
    expect(result.ok, result.error).toBe(true);
    expect(useStore.getState().settings.baseCurrency).toBe('JOD');
  });

  it('normalises the stored code', () => {
    useStore.getState().updateSettings({ baseCurrency: 'jod' });
    expect(useStore.getState().settings.baseCurrency).toBe('JOD');
  });

  it('12 · refuses a casual change once a transaction is posted', () => {
    useStore.getState().updateSettings({ baseCurrency: 'JOD' });
    useJournalStore.setState({ entries: [postedEntry()] });

    const result = useStore.getState().updateSettings({ baseCurrency: 'USD' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(FUNCTIONAL_CURRENCY_LOCKED_MESSAGE);
    // And nothing moved — history is not silently re-labelled.
    expect(useStore.getState().settings.baseCurrency).toBe('JOD');
  });

  it('a draft entry does not lock it — only a posted one does', () => {
    useJournalStore.setState({ entries: [{ ...postedEntry(), id: 'je-draft', status: 'draft' }] });
    expect(useStore.getState().updateSettings({ baseCurrency: 'EUR' }).ok).toBe(true);
  });

  it('still allows unrelated settings edits after posting', () => {
    useJournalStore.setState({ entries: [postedEntry()] });
    const result = useStore.getState().updateSettings({ companyName: 'Renamed Co' });
    expect(result.ok, result.error).toBe(true);
    expect(useStore.getState().settings.companyName).toBe('Renamed Co');
  });

  it('re-setting the SAME currency after posting is not a change', () => {
    useStore.getState().updateSettings({ baseCurrency: 'JOD' });
    useJournalStore.setState({ entries: [postedEntry()] });
    expect(useStore.getState().updateSettings({ baseCurrency: 'JOD' }).ok).toBe(true);
  });

  it('the guard itself is explicit about both directions', () => {
    expect(guardFunctionalCurrencyChange({ from: 'USD', to: 'JOD', hasPosted: false }).ok).toBe(true);
    expect(guardFunctionalCurrencyChange({ from: 'USD', to: 'JOD', hasPosted: true }).ok).toBe(false);
    // The controlled migration path is not blocked by this guard.
    expect(
      guardFunctionalCurrencyChange({ from: 'USD', to: 'JOD', hasPosted: true, viaControlledMigration: true }).ok,
    ).toBe(true);
    // An empty selection is never acceptable.
    expect(guardFunctionalCurrencyChange({ from: 'USD', to: '', hasPosted: false }).ok).toBe(false);
  });
});

/* ══ 13 · Existing organizations ═══════════════════════════════════════════ */

describe('organizations that predate the field', () => {
  afterEach(() => useStore.setState({ settings: DEFAULT_SETTINGS }));

  it('keeps whatever currency they already had — no blanket re-stamping', () => {
    // A workspace configured in JOD before this feature existed.
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, baseCurrency: 'JOD' } });
    expect(useStore.getState().settings.baseCurrency).toBe('JOD');
    // Nothing in the new code path rewrites it.
    useStore.getState().updateSettings({ companyName: 'Legacy Co' });
    expect(useStore.getState().settings.baseCurrency).toBe('JOD');
  });

  it('a currency outside the old nine-item list is still recognised', () => {
    // The previous UI list could not even express these; the records exist.
    for (const code of ['LYD', 'TND', 'KES', 'NGN']) {
      useStore.setState({ settings: { ...DEFAULT_SETTINGS, baseCurrency: code } });
      expect(useStore.getState().settings.baseCurrency).toBe(code);
      expect(findCatalogEntry(code), `${code} resolves in the catalogue`).toBeDefined();
    }
  });
});
