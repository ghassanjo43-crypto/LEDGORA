/**
 * The organization's FUNCTIONAL (base) currency — the one its books and
 * financial statements are maintained in.
 *
 * ── Functional currency is not transaction currency ─────────────────────────
 * A company whose functional currency is JOD may invoice in USD. Ledgora stores
 * the USD transaction with its rate and the JOD value; the functional currency
 * is what the Trial Balance, Income Statement, Balance Sheet and every other
 * statement are expressed in. Nothing here touches a transaction's own currency.
 *
 * ── Why the lock exists ─────────────────────────────────────────────────────
 * Changing the functional currency after postings exist does not re-price
 * anything: the numbers already in the ledger were recorded as JOD, and simply
 * relabelling them USD asserts that 1 JOD was always 1 USD. That is not a
 * setting change, it is a restatement — so once anything is posted the ordinary
 * settings path refuses, and the change has to go through the Currency Master's
 * controlled migration (`currencyStore.setBaseCurrency`, which demands an
 * effective date, a rate source and explicit confirmation, and never rewrites
 * historical journals).
 *
 * The refusal lives HERE and is applied in the store write paths, so it holds
 * however the change is attempted — not only when a form disables a field.
 */
import { useJournalStore } from '@/store/journalStore';

/** The sentence the requirement specifies, verbatim. */
export const FUNCTIONAL_CURRENCY_LOCKED_MESSAGE =
  'Functional currency cannot be changed because accounting transactions have already been posted. Changing the functional currency requires a controlled accounting conversion.';

/**
 * Has anything been posted to the ledger?
 *
 * A POSTED journal entry is the signal. Drafts are not: nothing has entered the
 * books, so the currency they are denominated in is still a choice rather than
 * a historical fact. Opening balances arrive as posted entries, so they count.
 */
export function hasPostedAccounting(): boolean {
  return useJournalStore.getState().entries.some((e) => e.status === 'posted');
}

export interface FunctionalCurrencyGuardResult {
  ok: boolean;
  error?: string;
}

/**
 * May the functional currency move from `from` to `to` through an ordinary
 * settings edit?
 *
 * Free while the books are empty; refused once anything is posted. An elevated
 * caller performing the Currency Master's migration workflow passes
 * `viaControlledMigration` — this function does not perform that migration, it
 * only declines to stand in its way.
 */
export function guardFunctionalCurrencyChange(params: {
  from: string;
  to: string;
  hasPosted?: boolean;
  viaControlledMigration?: boolean;
}): FunctionalCurrencyGuardResult {
  const from = normalizeFunctionalCurrency(params.from);
  const to = normalizeFunctionalCurrency(params.to);
  if (!to) return { ok: false, error: 'A functional currency is required.' };
  // Not a change at all.
  if (from === to) return { ok: true };
  if (params.viaControlledMigration) return { ok: true };
  const posted = params.hasPosted ?? hasPostedAccounting();
  return posted ? { ok: false, error: FUNCTIONAL_CURRENCY_LOCKED_MESSAGE } : { ok: true };
}

/** Canonical storage form: the ISO alphabetic code, upper-cased. */
export function normalizeFunctionalCurrency(code: string | undefined | null): string {
  return (code ?? '').trim().toUpperCase();
}

/* ── Country → usual currency ─────────────────────────────────────────────── */

/**
 * The currency a company in this country USUALLY keeps its books in.
 *
 * A convenience only. A Jordanian company may legitimately report in USD — for
 * a foreign parent, for a dollar-denominated contract book — so this seeds the
 * field and never constrains it. Deliberately a small, explicit map of the
 * countries the onboarding form actually offers rather than a generated
 * country-to-currency table: a wrong suggestion here is a wrong ledger, and a
 * guess is worse than no suggestion at all.
 */
const COUNTRY_CURRENCY: Record<string, string> = {
  JO: 'JOD',
  AE: 'AED',
  SA: 'SAR',
  KW: 'KWD',
  QA: 'QAR',
  BH: 'BHD',
  OM: 'OMR',
  IQ: 'IQD',
  EG: 'EGP',
  US: 'USD',
  GB: 'GBP',
  CH: 'CHF',
  CN: 'CNY',
  JP: 'JPY',
  IN: 'INR',
  CA: 'CAD',
  AU: 'AUD',
  TR: 'TRY',
  // Euro-area members the onboarding country list offers.
  DE: 'EUR',
  FR: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  NL: 'EUR',
  IE: 'EUR',
};

/** The usual functional currency for a country code, or '' when unknown. */
export function suggestedCurrencyForCountry(countryCode: string | undefined | null): string {
  const key = (countryCode ?? '').trim().toUpperCase();
  return COUNTRY_CURRENCY[key] ?? '';
}
