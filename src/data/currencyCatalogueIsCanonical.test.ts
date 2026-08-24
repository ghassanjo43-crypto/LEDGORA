/**
 * There is ONE currency dataset, and every currency field selects from it.
 *
 * ══ The failure this exists to prevent ═══════════════════════════════════════
 *
 * The catalogue was expanded to the full active ISO 4217 set and the change was
 * reported as done — while every Base Currency field on every screen was still
 * bound to a nine-item hard-coded array in `ifrsOptions`. The data layer was
 * right and the product was unchanged: a user opening Settings still saw nine
 * currencies. Tests that only assert on the catalogue cannot see that gap,
 * because the catalogue was never the broken part.
 *
 * So this file reads the SOURCE. It fails if a hard-coded currency list
 * reappears anywhere, or if any currency field goes back to a native `<select>`
 * — the two shapes the regression actually takes.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STANDARD_CURRENCY_CATALOG } from './currencyCatalog';
import { SEED_CURRENCIES } from './currencySeed';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const relative = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');

/*
 * Read each source file once for the whole suite.
 *
 * Every test below scans the entire tree, so an uncached read re-loads several
 * hundred files nine times over. That was fast enough to look fine in isolation
 * and slow enough to blow the 5s default timeout under a full parallel run —
 * a flake that gets worse with every file added to the repository.
 */
const CONTENTS = new Map<string, string>();
const read = (f: string): string => {
  const cached = CONTENTS.get(f);
  if (cached !== undefined) return cached;
  const text = readFileSync(f, 'utf8');
  CONTENTS.set(f, text);
  return text;
};

/** Files that legitimately name several currencies: the catalogue and tests. */
const ALLOWED = (file: string): boolean =>
  /^data\/currencyCatalog\.ts$/.test(file) ||
  /^data\/currencySeed\.ts$/.test(file) ||
  /\.test\.tsx?$/.test(file);

/*
 * These tests read every source file in the tree, which is real filesystem I/O
 * and grows with the repository. Vitest's 5s default is a budget for a unit
 * test, not for several hundred file reads on a loaded machine — and a timeout
 * here reads as a failure of the thing being asserted, which it never is.
 * Raised deliberately rather than by trimming what is scanned.
 */
const SCAN_TIMEOUT_MS = 30_000;

describe('one canonical currency dataset', () => {
  const files = sourceFiles();

  it('the deleted nine-item list has not come back', () => {
    // The exact labels the old array used.
    const legacyLabels = ['USD — US Dollar', 'EUR — Euro', 'GBP — British Pound', 'AED — UAE Dirham'];
    const offenders = files.filter((f) => {
      if (ALLOWED(relative(f))) return false;
      const text = read(f);
      return legacyLabels.some((label) => text.includes(label));
    });
    expect(offenders.map(relative), 'hard-coded currency labels').toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it('nothing exports a CURRENCY_OPTIONS list any more', () => {
    const offenders = files.filter(
      (f) => !ALLOWED(relative(f)) && /export const CURRENCY_OPTIONS/.test(read(f)),
    );
    expect(offenders.map(relative)).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it('no module builds its own multi-currency array', () => {
    /*
     * A literal listing several ISO codes together is the shape every one of
     * these regressions took. The catalogue, the seed and tests may; product
     * code may not.
     */
    const pattern = /\[\s*'(USD|EUR|GBP|AED|SAR|JOD)'\s*,\s*'[A-Z]{3}'\s*,\s*'[A-Z]{3}'/;
    const offenders = files.filter((f) => {
      const file = relative(f);
      // The seed's `allowedCurrencyCodes` is a per-organization permission
      // list, not a catalogue — it restricts, it does not enumerate what exists.
      if (ALLOWED(file)) return false;
      return pattern.test(read(f));
    });
    expect(offenders.map(relative), 'ad-hoc currency arrays').toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it('every currency field uses the shared CurrencyPicker, not a native select', () => {
    /*
     * Catches the literal regression: a `<Select …>` whose id or label marks it
     * as a currency chooser. The picker is a searchable combobox; a native
     * select cannot search 162 rows.
     */
    const offenders: string[] = [];
    for (const f of files) {
      const file = relative(f);
      if (ALLOWED(file)) continue;
      const text = read(f);
      for (const line of text.split('\n')) {
        if (!/<Select\b/.test(line)) continue;
        if (/id="currency"|id="newCompanyCurrency"|CURRENCY_OPTIONS|currencyOptions/i.test(line)) {
          offenders.push(`${file}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
    expect(offenders, 'currency fields still on a native <select>').toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it('the catalogue the pickers read is the complete active ISO set', () => {
    const isoFiat = STANDARD_CURRENCY_CATALOG.filter((c) => c.isIso && c.type === 'fiat');
    expect(isoFiat.length).toBeGreaterThanOrEqual(160);

    // Every currency the requirement names must be selectable, not just present.
    const selectable = new Set(SEED_CURRENCIES.filter((c) => c.status === 'active').map((c) => c.code));
    for (const code of [
      'JOD', 'USD', 'EUR', 'AED', 'KWD', 'BHD', 'OMR', 'QAR', 'TND', 'LYD',
      'KES', 'NGN', 'CAD', 'AUD', 'CHF', 'CNY', 'HKD', 'SGD', 'BRL', 'ZAR',
    ]) {
      expect(selectable.has(code), `${code} must be selectable`).toBe(true);
    }
  });
});

/* ══ Search behaviour, over the real dataset ═══════════════════════════════ */

describe('searching the canonical dataset', () => {
  /** The predicate CurrencyPicker applies. */
  const search = (q: string): string[] => {
    const query = q.trim().toLowerCase();
    return SEED_CURRENCIES.filter(
      (c) =>
        c.status === 'active' &&
        (!query ||
          c.code.toLowerCase().includes(query) ||
          c.name.toLowerCase().includes(query) ||
          c.symbol.toLowerCase().includes(query) ||
          (c.region ?? '').toLowerCase().includes(query) ||
          (c.countryCodes ?? []).some((cc) => cc.toLowerCase() === query)),
    ).map((c) => c.code);
  };

  it('finds by ISO code', () => {
    expect(search('kwd')).toContain('KWD');
    expect(search('TND')).toContain('TND');
    expect(search('kes')).toContain('KES');
    expect(search('cad')).toContain('CAD');
  });

  it('finds every dinar by name', () => {
    expect(search('dinar')).toEqual(expect.arrayContaining(['JOD', 'KWD', 'BHD', 'IQD', 'TND', 'LYD']));
  });

  it('finds by country', () => {
    expect(search('kenya')).toContain('KES');
    expect(search('nigeria')).toContain('NGN');
    expect(search('united arab emirates')).toContain('AED');
  });

  it('finds the franc family', () => {
    expect(search('franc')).toEqual(expect.arrayContaining(['CHF', 'XAF', 'XOF']));
  });
});
