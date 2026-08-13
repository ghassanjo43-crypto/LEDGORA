/**
 * The currency every ordinary accounting transaction is recorded in.
 *
 * ══ The policy ═══════════════════════════════════════════════════════════════
 *
 * The functional currency chosen when a company is created is the MANDATORY
 * currency for its ordinary transactions — journals, vouchers, invoices, credit
 * notes, bills, payments, receipts, opening balances. A JOD company records JOD
 * at an exchange rate of 1. There is no per-transaction currency choice, so no
 * transactional form offers one.
 *
 * ══ Why this module exists at all ════════════════════════════════════════════
 *
 * Before this, each editor answered "what currency is this?" for itself, and
 * several answered `?? 'USD'`. That is how a JOD company ends up with a dollar
 * invoice: not through a deliberate choice, but through a fallback nobody
 * looked at. Routing every form through ONE accessor means there is a single
 * place to be right, and a single place to change if multi-currency is ever
 * introduced deliberately.
 *
 * ══ What is canonical ═══════════════════════════════════════════════════════
 *
 * Server-backed accounting takes `organizations.base_currency`, resolved on the
 * server inside the write transaction — that is the authority, and the server
 * refuses anything else regardless of what the browser sends.
 *
 * This module is the browser's MIRROR of that value, read from the settings
 * store (which guards changes through `functionalCurrency.ts`). A mirror may
 * lag; it may not compete. So nothing here is ever sent to the server as the
 * transaction's currency — the forms use it to LABEL fields and to seed local
 * records, and the server derives the real value itself.
 *
 * ══ Not the same as the currency catalogue ══════════════════════════════════
 *
 * The full ISO catalogue stays exactly where it is. It is still needed to
 * CHOOSE the company's functional currency, for exchange-rate management, and
 * for historical and imported records. What has gone is the per-transaction
 * choice, not the currency infrastructure.
 */
import { useStore } from '@/store/useStore';
import { findCatalogEntry } from '@/data/currencyCatalog';

/** An ordinary transaction is in the company's own currency, so never converted. */
export const ORDINARY_TRANSACTION_EXCHANGE_RATE = 1;

export interface TransactionCurrency {
  /** ISO 4217 alphabetic code, e.g. `JOD`. */
  code: string;
  /** e.g. `Jordanian Dinar`. Falls back to the code when unknown. */
  name: string;
  /** e.g. `JOD — Jordanian Dinar`, for a read-only display. */
  label: string;
  /** Minor units for this currency — JOD and KWD have three, not two. */
  decimalPlaces: number;
}

function describe(code: string): TransactionCurrency {
  const normalized = (code ?? '').trim().toUpperCase();
  const entry = findCatalogEntry(normalized);
  return {
    code: normalized,
    name: entry?.name ?? normalized,
    label: entry ? `${normalized} — ${entry.name}` : normalized,
    decimalPlaces: entry?.decimals ?? 2,
  };
}

/**
 * Describe any currency code for display.
 *
 * For showing what an EXISTING record is denominated in, which is not always
 * the company's current currency: a historical or imported document may
 * legitimately carry another one, and a read-only field must show what the
 * record actually says rather than what the policy would choose today.
 */
export function describeCurrency(code: string | undefined | null): TransactionCurrency {
  return describe(code ?? '');
}

/**
 * The company's transaction currency, outside React.
 *
 * For store write paths and anything that builds a record without rendering.
 * Components should use {@link useTransactionCurrency} so they re-render if the
 * company's currency is changed while a form is open.
 */
export function transactionCurrencyCode(): string {
  return (useStore.getState().settings.baseCurrency ?? '').trim().toUpperCase();
}

/** As {@link transactionCurrencyCode}, with the display fields resolved. */
export function transactionCurrency(): TransactionCurrency {
  return describe(transactionCurrencyCode());
}

/**
 * The company's transaction currency, for components.
 *
 * Subscribed to the settings store, so a form open while the company currency
 * is changed re-labels itself rather than showing a stale code beside a live
 * amount.
 */
export function useTransactionCurrency(): TransactionCurrency {
  const code = useStore((s) => s.settings.baseCurrency);
  return describe(code);
}

/** Just the code, for components that only need to format amounts. */
export function useTransactionCurrencyCode(): string {
  return useStore((s) => (s.settings.baseCurrency ?? '').trim().toUpperCase());
}

/**
 * A monetary field label carrying its currency: `Amount (JOD)`.
 *
 * The interface pattern that replaces the removed dropdowns — the currency is
 * still visible everywhere money is entered, it simply is not a choice.
 */
export function withCurrency(label: string, code: string): string {
  return code ? `${label} (${code})` : label;
}
