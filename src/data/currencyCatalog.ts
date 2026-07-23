/**
 * Standard currency CATALOG — shared reference data, not a hard limit.
 *
 * The application is never dependent on this list: organizations activate
 * entries from it, define custom currencies beyond it, and configure precision
 * per accounting policy. Default monetary decimals follow ISO 4217 (JPY 0,
 * USD 2, JOD/KWD/BHD/OMR/IQD 3); crypto/token entries carry their conventional
 * precision (BTC 8) and a higher default exchange-rate precision.
 */
import type { Currency, CurrencyType, SymbolPosition } from '@/types/currency';
import { DEFAULT_RATE_DECIMALS } from '@/types/currency';

export interface CurrencyCatalogEntry {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
  type: CurrencyType;
  isIso: boolean;
  isoNumericCode?: string;
  region?: string;
  countryCodes?: string[];
  symbolPosition?: SymbolPosition;
  /** Exchange-rate precision override (default 8; crypto typically 12). */
  rateDecimals?: number;
  minorUnitName?: string;
  minorUnitPluralName?: string;
}

const fiat = (
  code: string, name: string, symbol: string, decimals: number, isoNumericCode: string,
  region: string, countryCodes: string[], extra: Partial<CurrencyCatalogEntry> = {},
): CurrencyCatalogEntry => ({
  code, name, symbol, decimals, isoNumericCode, region, countryCodes,
  type: 'fiat', isIso: true, ...extra,
});

export const STANDARD_CURRENCY_CATALOG: CurrencyCatalogEntry[] = [
  fiat('AED', 'UAE Dirham', 'AED', 2, '784', 'United Arab Emirates', ['AE'], { symbolPosition: 'after', minorUnitName: 'fils', minorUnitPluralName: 'fils' }),
  fiat('AUD', 'Australian Dollar', 'A$', 2, '036', 'Australia', ['AU'], { minorUnitName: 'cent', minorUnitPluralName: 'cents' }),
  fiat('BHD', 'Bahraini Dinar', 'BD', 3, '048', 'Bahrain', ['BH'], { minorUnitName: 'fils', minorUnitPluralName: 'fils' }),
  fiat('CAD', 'Canadian Dollar', 'C$', 2, '124', 'Canada', ['CA'], { minorUnitName: 'cent', minorUnitPluralName: 'cents' }),
  fiat('CHF', 'Swiss Franc', 'CHF', 2, '756', 'Switzerland', ['CH'], { symbolPosition: 'after', minorUnitName: 'rappen', minorUnitPluralName: 'rappen' }),
  fiat('CNY', 'Chinese Yuan Renminbi', '¥', 2, '156', 'China', ['CN'], { minorUnitName: 'fen', minorUnitPluralName: 'fen' }),
  fiat('EGP', 'Egyptian Pound', 'E£', 2, '818', 'Egypt', ['EG'], { minorUnitName: 'piastre', minorUnitPluralName: 'piastres' }),
  fiat('EUR', 'Euro', '€', 2, '978', 'Euro area', ['DE', 'FR', 'ES', 'IT'], { minorUnitName: 'cent', minorUnitPluralName: 'cents' }),
  fiat('GBP', 'Pound Sterling', '£', 2, '826', 'United Kingdom', ['GB'], { minorUnitName: 'penny', minorUnitPluralName: 'pence' }),
  fiat('INR', 'Indian Rupee', '₹', 2, '356', 'India', ['IN'], { minorUnitName: 'paisa', minorUnitPluralName: 'paise' }),
  fiat('IQD', 'Iraqi Dinar', 'IQD', 3, '368', 'Iraq', ['IQ'], { symbolPosition: 'after', minorUnitName: 'fils', minorUnitPluralName: 'fils' }),
  fiat('JOD', 'Jordanian Dinar', 'JD', 3, '400', 'Jordan', ['JO'], { minorUnitName: 'fils', minorUnitPluralName: 'fils' }),
  fiat('JPY', 'Japanese Yen', '¥', 0, '392', 'Japan', ['JP'], { minorUnitName: 'sen', minorUnitPluralName: 'sen' }),
  fiat('KWD', 'Kuwaiti Dinar', 'KD', 3, '414', 'Kuwait', ['KW'], { minorUnitName: 'fils', minorUnitPluralName: 'fils' }),
  fiat('OMR', 'Omani Rial', 'OMR', 3, '512', 'Oman', ['OM'], { symbolPosition: 'after', minorUnitName: 'baisa', minorUnitPluralName: 'baisa' }),
  fiat('QAR', 'Qatari Riyal', 'QR', 2, '634', 'Qatar', ['QA'], { minorUnitName: 'dirham', minorUnitPluralName: 'dirhams' }),
  fiat('SAR', 'Saudi Riyal', 'SR', 2, '682', 'Saudi Arabia', ['SA'], { minorUnitName: 'halala', minorUnitPluralName: 'halalas' }),
  fiat('TRY', 'Turkish Lira', '₺', 2, '949', 'Türkiye', ['TR'], { minorUnitName: 'kuruş', minorUnitPluralName: 'kuruş' }),
  fiat('USD', 'United States Dollar', '$', 2, '840', 'United States', ['US'], { minorUnitName: 'cent', minorUnitPluralName: 'cents' }),

  // ── Digital / commodity reference entries (activated where enabled) ──────
  { code: 'BTC', name: 'Bitcoin', symbol: '₿', decimals: 8, type: 'cryptocurrency', isIso: false, rateDecimals: 12, minorUnitName: 'satoshi', minorUnitPluralName: 'satoshis' },
  { code: 'ETH', name: 'Ether', symbol: 'Ξ', decimals: 18, type: 'cryptocurrency', isIso: false, rateDecimals: 12, minorUnitName: 'wei', minorUnitPluralName: 'wei' },
  { code: 'USDT', name: 'Tether USD', symbol: 'USDT', decimals: 6, type: 'digital-token', isIso: false, rateDecimals: 8, symbolPosition: 'after' },
  { code: 'USDC', name: 'USD Coin', symbol: 'USDC', decimals: 6, type: 'digital-token', isIso: false, rateDecimals: 8, symbolPosition: 'after' },
  { code: 'XAU', name: 'Gold (troy ounce)', symbol: 'XAU', decimals: 6, type: 'commodity', isIso: true, isoNumericCode: '959', rateDecimals: 8, symbolPosition: 'after' },
];

export function findCatalogEntry(code: string): CurrencyCatalogEntry | undefined {
  const upper = code.trim().toUpperCase();
  return STANDARD_CURRENCY_CATALOG.find((e) => e.code === upper);
}

/** Materialize a Currency Master record from a catalog entry. */
export function catalogEntryToCurrency(
  entry: CurrencyCatalogEntry,
  opts: { now: string; status?: Currency['status']; by?: string },
): Currency {
  return {
    id: `cur_${entry.code}`,
    code: entry.code,
    name: entry.name,
    symbol: entry.symbol,
    currencyType: entry.type,
    isIso: entry.isIso,
    isoNumericCode: entry.isoNumericCode,
    region: entry.region,
    countryCodes: entry.countryCodes,
    decimalPlaces: entry.decimals,
    exchangeRateDecimalPlaces: entry.rateDecimals ?? DEFAULT_RATE_DECIMALS,
    minorUnitName: entry.minorUnitName,
    minorUnitPluralName: entry.minorUnitPluralName,
    symbolPosition: entry.symbolPosition ?? 'before',
    symbolSpacing: entry.symbolPosition === 'after',
    decimalSeparator: '.',
    thousandSeparator: ',',
    negativeFormat: '-1,234.56',
    roundingMethod: 'half-up',
    status: opts.status ?? 'active',
    auditTrail: [{
      id: `caud_${entry.code}_${opts.now}`,
      at: opts.now,
      action: 'currency-activated-from-catalog',
      detail: `Standard ${entry.isIso ? 'ISO' : entry.type} currency ${entry.code}`,
      by: opts.by,
    }],
    createdAt: opts.now,
    updatedAt: opts.now,
    createdBy: opts.by,
  };
}
