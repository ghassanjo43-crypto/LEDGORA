/**
 * Reactive monetary precision, for components.
 *
 * ── Why this is not in `monetaryPrecision` ──────────────────────────────────
 * That module must import no stores — it is called from inside the accounting
 * libraries the stores themselves depend on, and importing a store there closes
 * a module cycle. A hook, by definition, needs a store SUBSCRIPTION, so it lives
 * here instead. Components import freely from stores, so this file is safe.
 *
 * ── Why a subscription rather than a plain call ─────────────────────────────
 * `companyMonetaryDecimals()` answers correctly at the moment it is called, but
 * a component that called it during render would not re-render when the company
 * changed — it would keep showing two decimals beside a dinar amount until
 * something else happened to re-render it. Subscribing to both the company
 * setting and the Currency Master fixes the number of decimals to whatever the
 * active organization currently says.
 */
import { useStore } from '@/store/useStore';
import { useCurrencyStore } from '@/store/currencyStore';
import { getCurrencyMonetaryDecimals, smallestUnit } from '@/lib/monetaryPrecision';

/** The active company's functional currency code, reactively. */
export function useCompanyCurrencyCode(): string {
  return useStore((s) => (s.settings.baseCurrency ?? '').trim().toUpperCase());
}

/**
 * Monetary decimals for `code`, or for the active company when omitted.
 *
 * Re-renders on a company switch and on a Currency Master edit.
 */
export function useMonetaryPrecision(code?: string): number {
  const companyCode = useCompanyCurrencyCode();
  const target = (code ?? companyCode).trim().toUpperCase();
  // Subscribing to the master's own value means correcting a currency's
  // configuration re-renders the fields denominated in it.
  const fromMaster = useCurrencyStore((s) =>
    s.currencies.find((c) => c.code.trim().toUpperCase() === target)?.decimalPlaces,
  );
  return typeof fromMaster === 'number' ? fromMaster : getCurrencyMonetaryDecimals(target);
}

/** The currency's smallest expressible amount, reactively — an input's `step`. */
export function useMonetaryStep(code?: string): number {
  const decimals = useMonetaryPrecision(code);
  return 10 ** -decimals;
}

/** Re-exported so components need only one import for the common case. */
export { smallestUnit };
