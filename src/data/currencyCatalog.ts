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

/**
 * A standard ISO 4217 currency carrying the fields the catalogue can state with
 * confidence: code, name, symbol and MINOR UNITS.
 *
 * ── Where the data comes from, and one trap ─────────────────────────────────
 * Names and symbols are CLDR's. Minor units are ISO 4217's, and the two
 * DISAGREE for about sixteen currencies: CLDR reports the digits a currency is
 * commonly *displayed* with, so it gives IQD, HUF, IDR, PKR, LBP, SYP, YER and
 * others zero decimals, while ISO 4217 defines IQD with three and the rest with
 * two. Taking the display digits as the accounting precision would silently
 * re-scale a ledger — and would contradict the curated IQD entry above, which
 * has always been 3. Minor units therefore follow ISO, never the formatter.
 *
 * Entries here deliberately omit `isoNumericCode`, `region` and `countryCodes`:
 * the curated block above carries that metadata where it was verified, and
 * inventing it for another 143 currencies would be asserting facts this file
 * cannot stand behind. Nothing in the application reads those fields for
 * anything but display, and currency search matches on code and name — which
 * already answers a country query, because "Jordan" is a prefix of "Jordanian
 * Dinar".
 */
const iso = (
  code: string, name: string, symbol: string, decimals: number, symbolPosition?: SymbolPosition,
): CurrencyCatalogEntry => ({
  code, name, symbol, decimals, type: 'fiat', isIso: true,
  ...(symbolPosition ? { symbolPosition } : {}),
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


  // ── The remainder of the active ISO 4217 set (alphabetical) ─────────────
  // Generated from CLDR names/symbols with ISO 4217 minor units; see `iso()`.
  iso('AFN', 'Afghan Afghani', 'AFN', 2, 'after'),
  iso('ALL', 'Albanian Lek', 'ALL', 2, 'after'),
  iso('AMD', 'Armenian Dram', 'AMD', 2, 'after'),
  iso('ANG', 'Netherlands Antillean Guilder', 'ANG', 2, 'after'),
  iso('AOA', 'Angolan Kwanza', 'AOA', 2, 'after'),
  iso('ARS', 'Argentine Peso', 'ARS', 2, 'after'),
  iso('AWG', 'Aruban Florin', 'AWG', 2, 'after'),
  iso('AZN', 'Azerbaijani Manat', 'AZN', 2, 'after'),
  iso('BAM', 'Bosnia-Herzegovina Convertible Mark', 'BAM', 2, 'after'),
  iso('BBD', 'Barbadian Dollar', 'BBD', 2, 'after'),
  iso('BDT', 'Bangladeshi Taka', 'BDT', 2, 'after'),
  iso('BGN', 'Bulgarian Lev', 'BGN', 2, 'after'),
  iso('BIF', 'Burundian Franc', 'BIF', 0, 'after'),
  iso('BMD', 'Bermudan Dollar', 'BMD', 2, 'after'),
  iso('BND', 'Brunei Dollar', 'BND', 2, 'after'),
  iso('BOB', 'Bolivian Boliviano', 'BOB', 2, 'after'),
  iso('BRL', 'Brazilian Real', 'R$', 2),
  iso('BSD', 'Bahamian Dollar', 'BSD', 2, 'after'),
  iso('BTN', 'Bhutanese Ngultrum', 'BTN', 2, 'after'),
  iso('BWP', 'Botswanan Pula', 'BWP', 2, 'after'),
  iso('BYN', 'Belarusian Ruble', 'BYN', 2, 'after'),
  iso('BZD', 'Belize Dollar', 'BZD', 2, 'after'),
  iso('CDF', 'Congolese Franc', 'CDF', 2, 'after'),
  iso('CLP', 'Chilean Peso', 'CLP', 0, 'after'),
  iso('COP', 'Colombian Peso', 'COP', 2, 'after'),
  iso('CRC', 'Costa Rican Colón', 'CRC', 2, 'after'),
  iso('CUC', 'Cuban Convertible Peso', 'CUC', 2, 'after'),
  iso('CUP', 'Cuban Peso', 'CUP', 2, 'after'),
  iso('CVE', 'Cape Verdean Escudo', 'CVE', 2, 'after'),
  iso('CZK', 'Czech Koruna', 'CZK', 2, 'after'),
  iso('DJF', 'Djiboutian Franc', 'DJF', 0, 'after'),
  iso('DKK', 'Danish Krone', 'DKK', 2, 'after'),
  iso('DOP', 'Dominican Peso', 'DOP', 2, 'after'),
  iso('DZD', 'Algerian Dinar', 'DZD', 2, 'after'),
  iso('ERN', 'Eritrean Nakfa', 'ERN', 2, 'after'),
  iso('ETB', 'Ethiopian Birr', 'ETB', 2, 'after'),
  iso('FJD', 'Fijian Dollar', 'FJD', 2, 'after'),
  iso('FKP', 'Falkland Islands Pound', 'FKP', 2, 'after'),
  iso('GEL', 'Georgian Lari', 'GEL', 2, 'after'),
  iso('GHS', 'Ghanaian Cedi', 'GHS', 2, 'after'),
  iso('GIP', 'Gibraltar Pound', 'GIP', 2, 'after'),
  iso('GMD', 'Gambian Dalasi', 'GMD', 2, 'after'),
  iso('GNF', 'Guinean Franc', 'GNF', 0, 'after'),
  iso('GTQ', 'Guatemalan Quetzal', 'GTQ', 2, 'after'),
  iso('GYD', 'Guyanaese Dollar', 'GYD', 2, 'after'),
  iso('HKD', 'Hong Kong Dollar', 'HK$', 2),
  iso('HNL', 'Honduran Lempira', 'HNL', 2, 'after'),
  iso('HRK', 'Croatian Kuna', 'HRK', 2, 'after'),
  iso('HTG', 'Haitian Gourde', 'HTG', 2, 'after'),
  iso('HUF', 'Hungarian Forint', 'HUF', 2, 'after'),
  iso('IDR', 'Indonesian Rupiah', 'IDR', 2, 'after'),
  iso('ILS', 'Israeli New Shekel', '₪', 2),
  iso('IRR', 'Iranian Rial', 'IRR', 2, 'after'),
  iso('ISK', 'Icelandic Króna', 'ISK', 0, 'after'),
  iso('JMD', 'Jamaican Dollar', 'JMD', 2, 'after'),
  iso('KES', 'Kenyan Shilling', 'KES', 2, 'after'),
  iso('KGS', 'Kyrgyz Som', 'KGS', 2, 'after'),
  iso('KHR', 'Cambodian Riel', 'KHR', 2, 'after'),
  iso('KMF', 'Comorian Franc', 'KMF', 0, 'after'),
  iso('KPW', 'North Korean Won', 'KPW', 2, 'after'),
  iso('KRW', 'South Korean Won', '₩', 0),
  iso('KYD', 'Cayman Islands Dollar', 'KYD', 2, 'after'),
  iso('KZT', 'Kazakhstani Tenge', 'KZT', 2, 'after'),
  iso('LAK', 'Laotian Kip', 'LAK', 2, 'after'),
  iso('LBP', 'Lebanese Pound', 'LBP', 2, 'after'),
  iso('LKR', 'Sri Lankan Rupee', 'LKR', 2, 'after'),
  iso('LRD', 'Liberian Dollar', 'LRD', 2, 'after'),
  iso('LSL', 'Lesotho Loti', 'LSL', 2, 'after'),
  iso('LYD', 'Libyan Dinar', 'LYD', 3, 'after'),
  iso('MAD', 'Moroccan Dirham', 'MAD', 2, 'after'),
  iso('MDL', 'Moldovan Leu', 'MDL', 2, 'after'),
  iso('MGA', 'Malagasy Ariary', 'MGA', 2, 'after'),
  iso('MKD', 'Macedonian Denar', 'MKD', 2, 'after'),
  iso('MMK', 'Myanmar Kyat', 'MMK', 2, 'after'),
  iso('MNT', 'Mongolian Tugrik', 'MNT', 2, 'after'),
  iso('MOP', 'Macanese Pataca', 'MOP', 2, 'after'),
  iso('MRU', 'Mauritanian Ouguiya', 'MRU', 2, 'after'),
  iso('MUR', 'Mauritian Rupee', 'MUR', 2, 'after'),
  iso('MVR', 'Maldivian Rufiyaa', 'MVR', 2, 'after'),
  iso('MWK', 'Malawian Kwacha', 'MWK', 2, 'after'),
  iso('MXN', 'Mexican Peso', 'MX$', 2),
  iso('MYR', 'Malaysian Ringgit', 'MYR', 2, 'after'),
  iso('MZN', 'Mozambican Metical', 'MZN', 2, 'after'),
  iso('NAD', 'Namibian Dollar', 'NAD', 2, 'after'),
  iso('NGN', 'Nigerian Naira', 'NGN', 2, 'after'),
  iso('NIO', 'Nicaraguan Córdoba', 'NIO', 2, 'after'),
  iso('NOK', 'Norwegian Krone', 'NOK', 2, 'after'),
  iso('NPR', 'Nepalese Rupee', 'NPR', 2, 'after'),
  iso('NZD', 'New Zealand Dollar', 'NZ$', 2),
  iso('PAB', 'Panamanian Balboa', 'PAB', 2, 'after'),
  iso('PEN', 'Peruvian Sol', 'PEN', 2, 'after'),
  iso('PGK', 'Papua New Guinean Kina', 'PGK', 2, 'after'),
  iso('PHP', 'Philippine Peso', '₱', 2),
  iso('PKR', 'Pakistani Rupee', 'PKR', 2, 'after'),
  iso('PLN', 'Polish Zloty', 'PLN', 2, 'after'),
  iso('PYG', 'Paraguayan Guarani', 'PYG', 0, 'after'),
  iso('RON', 'Romanian Leu', 'RON', 2, 'after'),
  iso('RSD', 'Serbian Dinar', 'RSD', 2, 'after'),
  iso('RUB', 'Russian Ruble', 'RUB', 2, 'after'),
  iso('RWF', 'Rwandan Franc', 'RWF', 0, 'after'),
  iso('SBD', 'Solomon Islands Dollar', 'SBD', 2, 'after'),
  iso('SCR', 'Seychellois Rupee', 'SCR', 2, 'after'),
  iso('SDG', 'Sudanese Pound', 'SDG', 2, 'after'),
  iso('SEK', 'Swedish Krona', 'SEK', 2, 'after'),
  iso('SGD', 'Singapore Dollar', 'SGD', 2, 'after'),
  iso('SHP', 'St. Helena Pound', 'SHP', 2, 'after'),
  iso('SLE', 'Sierra Leonean Leone', 'SLE', 2, 'after'),
  iso('SLL', 'Sierra Leonean Leone (1964—2022)', 'SLL', 2, 'after'),
  iso('SOS', 'Somali Shilling', 'SOS', 2, 'after'),
  iso('SRD', 'Surinamese Dollar', 'SRD', 2, 'after'),
  iso('SSP', 'South Sudanese Pound', 'SSP', 2, 'after'),
  iso('STN', 'São Tomé & Príncipe Dobra', 'STN', 2, 'after'),
  iso('SVC', 'Salvadoran Colón', 'SVC', 2, 'after'),
  iso('SYP', 'Syrian Pound', 'SYP', 2, 'after'),
  iso('SZL', 'Swazi Lilangeni', 'SZL', 2, 'after'),
  iso('THB', 'Thai Baht', 'THB', 2, 'after'),
  iso('TJS', 'Tajikistani Somoni', 'TJS', 2, 'after'),
  iso('TMT', 'Turkmenistani Manat', 'TMT', 2, 'after'),
  iso('TND', 'Tunisian Dinar', 'TND', 3, 'after'),
  iso('TOP', 'Tongan Paʻanga', 'TOP', 2, 'after'),
  iso('TTD', 'Trinidad & Tobago Dollar', 'TTD', 2, 'after'),
  iso('TWD', 'New Taiwan Dollar', 'NT$', 2),
  iso('TZS', 'Tanzanian Shilling', 'TZS', 2, 'after'),
  iso('UAH', 'Ukrainian Hryvnia', 'UAH', 2, 'after'),
  iso('UGX', 'Ugandan Shilling', 'UGX', 0, 'after'),
  iso('UYU', 'Uruguayan Peso', 'UYU', 2, 'after'),
  iso('UZS', 'Uzbekistani Som', 'UZS', 2, 'after'),
  iso('VES', 'Venezuelan Bolívar', 'VES', 2, 'after'),
  iso('VND', 'Vietnamese Dong', '₫', 0),
  iso('VUV', 'Vanuatu Vatu', 'VUV', 0, 'after'),
  iso('WST', 'Samoan Tala', 'WST', 2, 'after'),
  iso('XAF', 'Central African CFA Franc', 'FCFA', 0),
  iso('XCD', 'East Caribbean Dollar', 'EC$', 2),
  iso('XCG', 'Caribbean guilder', 'Cg.', 2),
  iso('XDR', 'Special Drawing Rights', 'XDR', 2, 'after'),
  iso('XOF', 'West African CFA Franc', 'F CFA', 0),
  iso('XPF', 'CFP Franc', 'CFPF', 0),
  iso('XSU', 'Sucre', 'XSU', 2, 'after'),
  iso('YER', 'Yemeni Rial', 'YER', 2, 'after'),
  iso('ZAR', 'South African Rand', 'ZAR', 2, 'after'),
  iso('ZMW', 'Zambian Kwacha', 'ZMW', 2, 'after'),
  iso('ZWG', 'Zimbabwean Gold', 'ZWG', 2, 'after'),
  iso('ZWL', 'Zimbabwean Dollar (2009–2024)', 'ZWL', 2, 'after'),

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
