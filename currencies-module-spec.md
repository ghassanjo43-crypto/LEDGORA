# Currencies Module Specification

## Objective

Build a production-quality **Currencies module** in the existing React + TypeScript IFRS bookkeeping application.

The module must provide centralized currency, exchange-rate, conversion, revaluation, and foreign-exchange accounting logic for:

- Entities / companies
- Customers
- Suppliers
- Invoices
- Credit notes
- Receipts
- Bills
- Supplier credits
- Payments
- General Journal
- General Ledger
- Trial Balance
- Income Statement
- Balance Sheet
- Cash Flow Statement
- Tax reports
- Statements of account
- Supplier statements
- Bank reconciliation
- Financial reporting

The application already contains or is expected to contain:

- Chart of Accounts
- General Journal and General Ledger
- Customers and suppliers
- Sales and purchase documents
- Tax Code module
- Entity selector
- AccountPicker
- Zustand stores
- Zod validation
- LocalStorage persistence
- Existing calculations, posting, print/PDF, and report utilities
- Ledgerly ERP design system

The Currencies module must be the single source of truth for currency metadata, exchange-rate history, conversion rules, and FX posting.

Do not duplicate exchange-rate calculations inside transaction components.

Do not overwrite historical posted values when exchange rates change.

Do not use live or current rates to recalculate historical transactions.

---

# 1. Core Purpose

The module must support:

1. One base currency per entity
2. Multiple transaction currencies
3. Currency master data
4. ISO currency codes
5. Currency symbols
6. Currency decimal precision
7. Currency-specific rounding
8. Historical exchange rates
9. Buy and sell rates
10. Mid-market/reference rates
11. Manual exchange-rate entry
12. Effective-dated rates
13. Source and audit metadata
14. Document currency snapshots
15. Base-currency snapshots
16. Multi-currency invoices
17. Multi-currency bills
18. Multi-currency receipts
19. Multi-currency payments
20. Bank accounts in foreign currencies
21. Realized FX gains and losses
22. Unrealized FX gains and losses
23. Period-end revaluation
24. Reversal of revaluation
25. Foreign-currency aging
26. Base-currency financial statements
27. Currency-specific customer/supplier statements
28. Tax reporting in base currency
29. Currency conversion preview
30. Exchange-rate locking
31. Exchange-rate import as a future option
32. Currency activation/deactivation
33. Audit history

The first release should support manual and effective-dated exchange rates with correct historical snapshots and FX accounting.

---

# 2. Navigation

Under Settings add:

```text
Settings
- Company
- Chart of Accounts
- Tax Codes
- Currencies
- Exchange Rates
- Numbering
```

Under Accounting add:

```text
Accounting
- Currency Revaluation
- FX Gain/Loss Report
```

Routes:

```text
/settings/currencies
/settings/currencies/new
/settings/currencies/:currencyId
/settings/exchange-rates
/settings/exchange-rates/new
/accounting/currency-revaluation
/accounting/fx-gain-loss
```

---

# 3. Currency Master

Create `src/types/currency.ts`.

```ts
export type CurrencyStatus =
  | "active"
  | "inactive"
  | "archived"

export type Currency = {
  id: string

  code: string
  name: string
  symbol: string

  decimalPlaces: number
  minorUnitName?: string
  majorUnitName?: string

  symbolPosition:
    | "before"
    | "after"

  decimalSeparator:
    | "."
    | ","

  thousandSeparator:
    | ","
    | "."
    | " "
    | ""

  negativeFormat:
    | "-1,234.56"
    | "(1,234.56)"

  roundingIncrement?: number

  status: CurrencyStatus

  countryCodes?: string[]

  createdAt: string
  updatedAt: string
  createdBy?: string
  updatedBy?: string
}
```

Examples:

```text
USD — United States Dollar — $
EUR — Euro — €
JOD — Jordanian Dinar — JD
AED — UAE Dirham — AED
GBP — Pound Sterling — £
```

Do not infer decimal precision from symbol.

Use explicit configuration.

---

# 4. Entity Currency Configuration

Each entity must have one base currency.

Create:

```ts
export type EntityCurrencyConfig = {
  entityId: string

  baseCurrencyCode: string

  allowedCurrencyCodes: string[]

  defaultSalesCurrencyCode?: string
  defaultPurchaseCurrencyCode?: string

  realizedFxGainAccountId: string
  realizedFxLossAccountId: string

  unrealizedFxGainAccountId?: string
  unrealizedFxLossAccountId?: string

  cumulativeTranslationAdjustmentAccountId?: string

  revaluationJournalTemplateId?: string

  rateType:
    | "mid"
    | "buy"
    | "sell"
    | "custom"

  allowManualRateOverride: boolean
  requireOverrideReason: boolean

  createdAt: string
  updatedAt: string
}
```

Rules:

- One base currency per entity
- Base currency cannot be removed while entity exists
- Base currency rate is always 1.0
- Foreign currencies must be explicitly enabled
- Entity-specific FX accounts must be valid posting accounts

---

# 5. Exchange Rate Model

Create:

```ts
export type ExchangeRateSource =
  | "manual"
  | "bank"
  | "central-bank"
  | "market-provider"
  | "import"
  | "system"
  | "custom"

export type ExchangeRateType =
  | "mid"
  | "buy"
  | "sell"
  | "custom"

export type ExchangeRate = {
  id: string
  entityId: string

  fromCurrencyCode: string
  toCurrencyCode: string

  rate: number
  inverseRate: number

  rateType: ExchangeRateType
  source: ExchangeRateSource

  effectiveDate: string
  effectiveTime?: string

  status:
    | "active"
    | "superseded"
    | "inactive"

  sourceReference?: string
  notes?: string

  createdAt: string
  updatedAt: string
  createdBy?: string
  updatedBy?: string
}
```

Recommended convention:

```text
1 unit of fromCurrency = rate units of toCurrency
```

Example:

```text
1 USD = 0.709 JOD
```

Do not mix conventions.

Display the convention clearly in the UI.

---

# 6. Exchange Rate Resolution

Create:

```ts
resolveExchangeRate({
  entityId,
  fromCurrencyCode,
  toCurrencyCode,
  transactionDate,
  rateType,
})
```

Resolution priority:

1. Exact rate for date/time
2. Latest prior effective rate
3. Inverse of an available reciprocal rate
4. Triangulated rate through base currency if allowed
5. Manual entry if permitted
6. Block transaction

Never use a future rate for a past transaction unless explicitly overridden.

Never silently default a missing foreign rate to 1.0.

Base-to-base conversion:

```text
rate = 1
```

---

# 7. Exchange Rate Snapshot

Every posted foreign-currency document must freeze the rate used.

Create:

```ts
export type ExchangeRateSnapshot = {
  fromCurrencyCode: string
  toCurrencyCode: string

  rate: number
  inverseRate: number

  rateType: ExchangeRateType
  source: ExchangeRateSource

  effectiveDate: string
  effectiveTime?: string

  sourceReference?: string

  capturedAt: string
}
```

Store the snapshot on:

- Invoice
- Credit note
- Bill
- Supplier credit
- Receipt
- Payment
- Journal entry
- Tax snapshot where base-currency values are needed

Historical documents must continue using their snapshot even if rates change later.

---

# 8. Conversion Formula

Use one centralized formula.

If:

```text
1 foreign unit = rate base units
```

then:

```text
baseAmount = foreignAmount × rate
```

Inverse:

```text
foreignAmount = baseAmount ÷ rate
```

Create:

```ts
convertCurrency(...)
convertToBaseCurrency(...)
convertFromBaseCurrency(...)
```

Use decimal-safe arithmetic.

Do not use binary floating-point for posted monetary values.

---

# 9. Currency Precision and Rounding

Use:

- Currency decimal precision
- Exchange-rate precision
- Internal calculation precision
- Posting precision

Recommended:

```text
Currency precision: configured per currency
Exchange rate precision: 8–12 decimals
Internal calculation precision: at least 12 decimals
Posted amount precision: currency precision
```

Create:

```ts
roundCurrencyAmount(...)
roundExchangeRate(...)
```

Examples:

- USD: 2 decimals
- JOD: 3 decimals
- JPY: 0 decimals

Do not force every currency to two decimals.

---

# 10. Formatting

Create:

```ts
formatCurrencyAmount(...)
formatForeignAndBaseAmount(...)
```

Examples:

```text
USD 1,234.56
JOD 1,234.567
JPY 1,235
```

Optional dual display:

```text
USD 1,000.00
Base: JOD 709.000
```

Use configured symbol position, separators, and negative format.

---

# 11. Currency Activation

Allow:

- Activate
- Deactivate
- Archive

Rules:

- Used currencies cannot be hard deleted
- Inactive currency cannot be selected for new transactions
- Historical documents still render correctly
- Existing open balances remain visible
- Revaluation still works for inactive currencies with outstanding balances

---

# 12. Default Currency Resolution

Create:

```ts
resolveDefaultCurrency(...)
```

Priority:

## Sales

1. Explicit invoice currency
2. Customer preferred currency
3. Entity default sales currency
4. Entity base currency

## Purchases

1. Explicit bill currency
2. Supplier preferred currency
3. Entity default purchase currency
4. Entity base currency

Do not override an explicitly selected currency.

Show why a default was selected.

---

# 13. Customer and Supplier Currency Profiles

Recommended fields:

```ts
export type PartyCurrencyProfile = {
  preferredCurrencyCode?: string
  allowedCurrencyCodes?: string[]
  defaultExchangeRateType?: ExchangeRateType
  allowCurrencyOverride?: boolean
}
```

Do not infer preferred currency from country alone.

---

# 14. Foreign-Currency Invoice

Invoice fields must include:

- Document currency
- Exchange rate
- Base currency
- Foreign subtotal
- Foreign tax
- Foreign grand total
- Base subtotal
- Base tax
- Base grand total
- Exchange-rate snapshot

Example:

```text
Invoice currency: USD
Base currency: JOD
Invoice total: USD 1,000.00
Rate: 1 USD = 0.709 JOD
Base total: JOD 709.000
```

Journal posts base-currency values while preserving foreign values in metadata.

---

# 15. Foreign-Currency Bill

Bill fields mirror invoice requirements.

Example:

```text
Bill total: EUR 5,000.00
Rate: 1 EUR = 0.770 JOD
Base total: JOD 3,850.000
```

Posting:

```text
Dr Expense / Asset / Inventory    base value
Dr Input tax                      base value
    Cr Trade payables             base value
```

Foreign-currency payable remains tracked in EUR.

---

# 16. Foreign-Currency Credit Note

A credit note linked to an invoice must normally use the original invoice’s currency.

Rules:

- Customer locked
- Currency locked
- Original tax snapshot reused
- Original document rate reused where policy requires historical reversal
- Current rate may be used only if accounting policy explicitly requires it

Store both:

- Foreign credit amount
- Base credit amount
- Rate snapshot

Do not allow arbitrary currency mismatch.

---

# 17. Foreign-Currency Supplier Credit

Mirror credit-note treatment.

Use original bill currency and original tax snapshot where linked.

Do not silently use today’s rate.

---

# 18. Foreign-Currency Receipt

Receipt fields:

- Receipt currency
- Bank account currency
- Invoice currency
- Base currency
- Exchange rate
- Foreign amount
- Base amount
- Allocation amount
- Realized FX amount

If receipt and invoice currency match but settlement rate differs from invoice rate, calculate realized FX.

If receipt currency differs from invoice currency, block in MVP unless cross-currency settlement is fully implemented.

---

# 19. Foreign-Currency Payment

Payment fields mirror receipts.

If payment and bill currency match but payment rate differs from bill rate, calculate realized FX.

Example:

Bill:

```text
USD 1,000
Historical base value: JOD 709
```

Payment:

```text
USD 1,000
Payment base value: JOD 715
```

Realized FX loss:

```text
JOD 6
```

Journal:

```text
Dr Trade payables             709
Dr Realized FX loss             6
    Cr Bank                   715
```

---

# 20. Realized FX Gain/Loss

Create:

```ts
calculateRealizedFx(...)
```

For receivables:

```text
Settlement base amount
vs
Carrying base amount of settled receivable
```

For payables:

```text
Settlement base amount
vs
Carrying base amount of settled payable
```

Use proportional carrying value for partial settlement.

Do not calculate realized FX on original full balance when only part is settled.

---

# 21. Partial Settlement FX

Example:

Invoice:

```text
USD 1,000
Historical rate: 0.709
Base carrying value: JOD 709
```

Receipt:

```text
USD 400
Settlement rate: 0.715
Settlement base amount: JOD 286
Historical carrying amount settled: JOD 283.6
Realized FX gain/loss difference: JOD 2.4
```

Use proportional allocation.

Preserve remaining foreign and base carrying values.

---

# 22. Bank Account Currency

Each bank/cash account must have a currency.

Create or require:

```ts
type MonetaryAccountCurrencyConfig = {
  accountId: string
  currencyCode: string
  allowForeignTransactions: boolean
}
```

Rules:

- Native-currency bank account normally receives/payments in its own currency
- Cross-currency bank posting requires explicit conversion
- Base and foreign amount metadata must be stored
- Bank reconciliation uses the account’s native currency

Do not post USD amounts directly into a JOD bank account without conversion metadata.

---

# 23. General Journal Integration

Journal lines must support:

```ts
type JournalCurrencyFields = {
  transactionCurrencyCode: string
  transactionAmount: number
  baseCurrencyCode: string
  baseAmount: number
  exchangeRate: number
  exchangeRateSnapshot?: ExchangeRateSnapshot
}
```

For base-currency entries:

```text
exchangeRate = 1
transactionAmount = baseAmount
```

Journal must balance in base currency.

Optionally validate foreign-currency balancing by currency where applicable.

---

# 24. Trial Balance

Primary Trial Balance remains in entity base currency.

Optional columns:

- Foreign currency
- Foreign debit
- Foreign credit
- Base debit
- Base credit

Do not combine foreign balances without base conversion.

---

# 25. General Ledger

Ledger must show:

- Transaction currency
- Foreign amount
- Exchange rate
- Base amount
- Realized FX line
- Revaluation line
- Source document

For foreign monetary accounts, show both transaction and base balances.

---

# 26. Financial Statements

Income Statement, Balance Sheet, and Cash Flow Statement are primarily presented in base currency.

Do not use current spot rates to retranslate historical income transactions unless consolidation/translation policy explicitly requires it.

For single-entity bookkeeping:

- Posted base amounts are authoritative
- Revaluation journals update monetary balance-sheet items
- Realized FX appears in profit or loss
- Unrealized FX appears according to configured policy

---

# 27. Monetary vs Non-Monetary Accounts

Create metadata:

```ts
export type FxAccountClassification =
  | "monetary"
  | "non-monetary"
  | "not-applicable"
```

Examples:

## Monetary

- Bank
- Cash
- Trade receivables
- Trade payables
- Loans
- Accrued liabilities

## Non-monetary

- Inventory at historical cost
- Property, plant and equipment at historical cost
- Prepaid expenses
- Equity

Only monetary foreign-currency balances are normally revalued.

Do not revalue all foreign-currency accounts indiscriminately.

---

# 28. Currency Revaluation

Create route:

```text
/accounting/currency-revaluation
```

Filters:

- Entity
- Revaluation date
- Currency
- Account
- Customer/supplier
- Include receivables
- Include payables
- Include bank accounts
- Include loans
- Include other monetary accounts

For each balance show:

- Account
- Party
- Foreign balance
- Historical base carrying value
- Closing exchange rate
- Revalued base value
- Unrealized gain/loss
- Proposed journal account

Create:

```ts
buildCurrencyRevaluation(...)
```

---

# 29. Unrealized FX Calculation

For a foreign monetary balance:

```text
Revalued base value =
Foreign closing balance × closing rate
```

```text
Unrealized FX =
Revalued base value − current base carrying value
```

Interpret sign according to account type.

Do not use absolute values.

---

# 30. Revaluation Journal

Create balanced journal entries through the existing journal service.

Examples:

## Receivable gain

```text
Dr Trade receivables
    Cr Unrealized FX gain
```

## Receivable loss

```text
Dr Unrealized FX loss
    Cr Trade receivables
```

## Payable gain

```text
Dr Trade payables
    Cr Unrealized FX gain
```

## Payable loss

```text
Dr Unrealized FX loss
    Cr Trade payables
```

Use account-sign logic carefully.

Store revaluation metadata.

---

# 31. Revaluation Reversal

Support policy:

```ts
export type RevaluationReversalPolicy =
  | "reverse-next-day"
  | "reverse-next-period"
  | "carry-forward"
```

If auto-reversal is used:

- Create exact reversing journal
- Link original and reversal
- Preserve audit history

Do not manually reconstruct reversal amounts.

---

# 32. Revaluation Record

Create:

```ts
export type CurrencyRevaluationRun = {
  id: string
  entityId: string

  revaluationDate: string
  baseCurrencyCode: string

  currencyCodes: string[]

  status:
    | "draft"
    | "reviewed"
    | "posted"
    | "reversed"

  totalGain: number
  totalLoss: number
  netFx: number

  journalEntryId?: string
  reversalJournalEntryId?: string

  lines: CurrencyRevaluationLine[]

  createdAt: string
  updatedAt: string
  postedAt?: string
  reversedAt?: string
}
```

---

# 33. Revaluation Line

```ts
export type CurrencyRevaluationLine = {
  id: string

  accountId: string
  partyId?: string

  currencyCode: string
  foreignBalance: number

  carryingBaseAmount: number
  closingRate: number
  revaluedBaseAmount: number

  unrealizedGain: number
  unrealizedLoss: number

  fxGainAccountId?: string
  fxLossAccountId?: string
}
```

---

# 34. Revaluation Validation

Require:

- Entity
- Revaluation date
- Closing rates
- Valid monetary accounts
- Valid FX gain/loss accounts
- No duplicate posted revaluation for same scope/date unless reversed
- Open accounting period
- Balanced journal

Block:

- Missing rate
- Zero/negative rate
- Non-monetary account without override
- Locked period
- Duplicate run
- Invalid account mapping

---

# 35. FX Gain/Loss Report

Create route:

```text
/accounting/fx-gain-loss
```

Show:

- Realized FX gains
- Realized FX losses
- Unrealized FX gains
- Unrealized FX losses
- Net FX result
- By currency
- By customer
- By supplier
- By bank account
- By document
- By period

Each row links to source settlement or revaluation journal.

---

# 36. Currency Exposure Report

Optional but recommended.

Show:

- Currency
- Foreign receivables
- Foreign payables
- Foreign bank balances
- Foreign loans
- Net exposure
- Base equivalent
- Current rate
- Sensitivity impact

Do not present sensitivity as booked accounting.

Label it analytical.

---

# 37. Exchange Rate List

Columns:

- Effective date
- From currency
- To currency
- Rate
- Inverse rate
- Type
- Source
- Status
- Reference
- Created by

Filters:

- Entity
- Currency pair
- Date range
- Rate type
- Source
- Status

Actions:

- View
- Edit unused future/manual rate
- Duplicate
- Supersede
- Deactivate

Do not delete rates used by posted snapshots.

---

# 38. Exchange Rate Editor

Fields:

- Entity
- From currency
- To currency
- Rate
- Inverse rate
- Rate type
- Effective date/time
- Source
- Reference
- Notes

Rules:

- From and to cannot match unless rate = 1 and it is the base identity rate
- Rate must be positive
- Inverse must reconcile within tolerance
- Duplicate effective timestamp handled according to policy
- Base identity rate is system-managed

---

# 39. Rate Override

When manual override is allowed on a transaction:

Require:

- Entered rate
- Override reason
- User
- Timestamp
- Difference from resolved rate

Store on snapshot:

```ts
overrideReason?: string
resolvedRate?: number
overrideRate?: number
```

Show warning when variance exceeds threshold.

Do not silently override.

---

# 40. Rate Variance Controls

Configuration:

```ts
export type RateVariancePolicy = {
  warningThresholdPercent: number
  blockingThresholdPercent?: number
  requireApprovalAbovePercent?: number
}
```

Example:

```text
Resolved rate: 0.709
Entered rate: 0.750
Variance: 5.78%
```

Warn or block according to policy.

---

# 41. Currency Locking

Allow rate/date locking for closed periods.

When period is locked:

- Historical rate snapshots remain immutable
- Backdated rate changes do not alter posted documents
- Revaluation reversal follows period rules
- Manual overrides require permission

---

# 42. Statements of Account

Customer and supplier statements must support:

- Original transaction currency
- Base currency
- Single-currency mode
- Multi-currency grouping
- Exchange rate
- Foreign running balance
- Base running balance

Do not add different currencies together without conversion.

---

# 43. Aging Reports

AR/AP aging should support:

- Base currency view
- Single foreign currency view
- Multi-currency grouped view

Use outstanding foreign amount and posted base carrying amount.

Do not age revalued base amount as if it were original transaction currency.

---

# 44. Tax Integration

Tax calculations occur in document currency.

Store:

- Foreign taxable amount
- Foreign tax amount
- Base taxable amount
- Base tax amount
- Exchange-rate snapshot

Tax reports generally use base currency or jurisdiction filing currency.

Do not recalculate historical tax using current rates.

---

# 45. Cash Flow Statement

Cash Flow Statement is in base currency.

For foreign bank transactions:

- Use posted base amount
- Include realized FX effects according to policy
- Avoid double counting revaluation, which is non-cash

Unrealized FX revaluation is non-cash.

---

# 46. Bank Reconciliation

Bank reconciliation uses bank account native currency.

Show:

- Statement currency
- Book currency
- Foreign amount
- Base amount
- Exchange rate
- Difference

Do not reconcile converted base values against a foreign bank statement without showing native amounts.

---

# 47. Dashboard Integration

Optional metrics:

- Foreign receivables
- Foreign payables
- Net currency exposure
- Realized FX this month
- Unrealized FX this period
- Missing exchange rates
- Rates requiring approval
- Foreign bank balances

---

# 48. Currency Converter

Provide a non-posting utility:

```text
Currency Converter
```

Inputs:

- From currency
- To currency
- Date
- Rate type
- Amount

Outputs:

- Resolved rate
- Converted amount
- Inverse rate
- Source
- Effective date

Clearly label:

```text
Preview only — no accounting entry created
```

---

# 49. Permissions

Suggested permissions:

- View currencies
- Create currencies
- Edit unused currencies
- Activate/deactivate currencies
- View exchange rates
- Create exchange rates
- Override rates
- Approve rate overrides
- Run revaluation
- Post revaluation
- Reverse revaluation
- View FX reports
- Manage entity currency settings

---

# 50. Audit Trail

Record:

- Currency created
- Currency activated/deactivated
- Base currency assigned
- Allowed currency changed
- Exchange rate created
- Exchange rate superseded
- Manual override used
- Rate variance approved
- Revaluation created
- Revaluation posted
- Revaluation reversed
- FX account mapping changed

Do not overwrite historical audit records.

---

# 51. Recommended Files

Adapt to actual project conventions.

```text
src/
  types/
    currency.ts
    exchangeRate.ts
    currencyRevaluation.ts

  store/
    currencyStore.ts
    exchangeRateStore.ts
    currencyRevaluationStore.ts

  lib/
    currencyConversion.ts
    currencyFormatting.ts
    exchangeRateResolution.ts
    exchangeRateValidation.ts
    fxRealization.ts
    currencyRevaluation.ts
    currencyRevaluationPosting.ts
    currencyValidation.ts
    currencyReporting.ts

  components/
    currencies/
      CurrencyList.tsx
      CurrencyEditor.tsx
      ExchangeRateList.tsx
      ExchangeRateEditor.tsx
      CurrencySelector.tsx
      ExchangeRateField.tsx
      CurrencyConversionPreview.tsx
      CurrencyRevaluationEditor.tsx
      CurrencyRevaluationTable.tsx
      FxGainLossReport.tsx
      CurrencyExposureReport.tsx

  pages/
    CurrenciesPage.tsx
    ExchangeRatesPage.tsx
    CurrencyRevaluationPage.tsx
    FxGainLossPage.tsx
```

Keep currency and FX business logic outside React components.

---

# 52. Core Functions

Implement:

```ts
resolveDefaultCurrency(...)
resolveExchangeRate(...)
convertCurrency(...)
convertToBaseCurrency(...)
convertFromBaseCurrency(...)
roundCurrencyAmount(...)
roundExchangeRate(...)
formatCurrencyAmount(...)
formatForeignAndBaseAmount(...)
createExchangeRateSnapshot(...)
calculateRealizedFx(...)
calculatePartialSettlementFx(...)
buildCurrencyRevaluation(...)
buildRevaluationJournalEntry(...)
postCurrencyRevaluation(...)
reverseCurrencyRevaluation(...)
buildFxGainLossReport(...)
buildCurrencyExposureReport(...)
validateCurrency(...)
validateExchangeRate(...)
validateCurrencyRevaluation(...)
```

---

# 53. Persistence

Use Zustand and LocalStorage consistently.

Persist:

- Currencies
- Entity currency settings
- Exchange rates
- Rate sources
- Rate overrides
- Revaluation runs
- Journal links
- Audit metadata

Ensure refresh preserves:

- Active currencies
- Historical rates
- Draft revaluations
- Posted revaluations
- Routes
- Filters
- Currency formatting

Do not persist temporary conversion preview state as authoritative accounting data.

---

# 54. Validation

Create:

```ts
validateCurrency(...)
validateExchangeRate(...)
validateCurrencyForEntity(...)
validateCurrencyForTransaction(...)
validateCurrencyRevaluation(...)
```

Currency validation:

- Unique code
- Valid decimal places
- Valid symbol configuration
- Valid status

Exchange-rate validation:

- Positive rate
- Valid pair
- Inverse reconciliation
- Valid effective date
- No unauthorized duplicate timestamp
- Valid source
- Valid entity

Transaction validation:

- Currency enabled for entity
- Valid rate on document date
- Rate snapshot present before posting
- Base amount reconciles to foreign amount × rate
- Bank account currency compatible
- Manual override reason where required

Revaluation validation:

- Monetary accounts only
- Closing rates present
- Open period
- Valid FX accounts
- Balanced journal
- No duplicate run

---

# 55. Acceptance Scenario 1 — Foreign Invoice

Entity base currency:

```text
JOD
```

Invoice currency:

```text
USD
```

Invoice:

```text
USD 1,000.00
```

Rate:

```text
1 USD = 0.709 JOD
```

Expected:

```text
Base amount = JOD 709.000
```

Journal:

```text
Dr Trade receivables        JOD 709.000
    Cr Revenue              JOD 709.000
```

Expected:

- USD amount preserved
- JOD base amount posted
- Rate snapshot stored
- Later rate changes do not alter invoice

---

# 56. Acceptance Scenario 2 — Foreign Receipt with Realized Gain

Invoice:

```text
USD 1,000
Historical base value: JOD 709
```

Receipt:

```text
USD 1,000
Settlement base value: JOD 715
```

Expected realized difference:

```text
JOD 6
```

For a receivable settlement, determine gain/loss according to sign convention and configured accounts.

Journal must balance and invoice must settle to zero foreign amount.

---

# 57. Acceptance Scenario 3 — Partial Receipt

Invoice:

```text
USD 1,000
Historical base value: JOD 709
```

Receipt:

```text
USD 400
Settlement rate: 0.715
```

Expected:

```text
Historical carrying amount settled: JOD 283.600
Settlement base amount: JOD 286.000
Difference: JOD 2.400
Remaining foreign balance: USD 600
Remaining base carrying amount: JOD 425.400
```

---

# 58. Acceptance Scenario 4 — Foreign Bill Payment

Bill:

```text
EUR 5,000
Historical rate: 0.770
Base carrying value: JOD 3,850
```

Payment rate:

```text
0.765
```

Expected settlement base amount:

```text
JOD 3,825
```

Expected realized FX difference:

```text
JOD 25
```

Post according to payable gain/loss sign logic.

---

# 59. Acceptance Scenario 5 — Revaluation

Foreign receivable:

```text
USD 10,000
Carrying base amount: JOD 7,090
Closing rate: 0.720
Revalued amount: JOD 7,200
```

Expected unrealized difference:

```text
JOD 110
```

Journal:

```text
Dr Trade receivables        110
    Cr Unrealized FX gain   110
```

---

# 60. Acceptance Scenario 6 — Zero-Decimal Currency

Currency:

```text
JPY
Decimal places: 0
```

Amount:

```text
JPY 1,234.56
```

Expected posted/displayed amount according to configured rounding:

```text
JPY 1,235
```

Do not show two forced decimal places.

---

# 61. Tests

Add tests for:

1. Base currency rate equals 1
2. Foreign conversion correct
3. Inverse rate correct
4. Latest prior rate resolution
5. Future rate not used for past date
6. Missing rate blocks posting
7. Manual override requires reason
8. Rate variance warning works
9. Currency precision respected
10. JPY zero-decimal rounding works
11. JOD three-decimal rounding works
12. Historical snapshot remains unchanged
13. Invoice foreign/base amounts reconcile
14. Bill foreign/base amounts reconcile
15. Credit note currency locked to invoice
16. Supplier credit currency locked to bill
17. Receipt realized FX correct
18. Payment realized FX correct
19. Partial settlement FX correct
20. Bank account currency validation works
21. Journal balances in base currency
22. Foreign metadata preserved
23. Trial Balance base values correct
24. General Ledger dual-currency display correct
25. Monetary account revaluation works
26. Non-monetary account excluded
27. Revaluation journal balanced
28. Revaluation reversal exact
29. Duplicate revaluation blocked
30. Locked period blocks revaluation
31. Inactive currency unavailable for new transactions
32. Historical inactive currency still renders
33. Customer default currency resolution works
34. Supplier default currency resolution works
35. Tax base conversion correct
36. Aging groups by currency correctly
37. Statement of account does not mix currencies
38. Bank reconciliation uses native currency
39. Cash Flow excludes unrealized FX as cash
40. FX report totals correct
41. LocalStorage hydration works
42. Empty state safe
43. Mobile editor works
44. Route refresh works

---

# 62. QA

Run:

- TypeScript typecheck
- Unit tests
- Production build
- Currency creation smoke test
- Exchange-rate creation test
- Foreign invoice test
- Foreign bill test
- Receipt realized FX test
- Payment realized FX test
- Partial settlement test
- Revaluation test
- Revaluation reversal test
- Bank reconciliation currency test
- Statement-of-account currency test
- Tax conversion test
- Cash Flow test
- LocalStorage hydration test
- Mobile-width test
- Route refresh test

Report:

- Files created
- Files modified
- Currencies implemented
- Exchange-rate convention
- Rate-resolution logic
- Snapshot logic
- Conversion precision
- Realized FX behavior
- Unrealized FX behavior
- Revaluation behavior
- Acceptance-scenario results
- Tests
- Typecheck
- Production build
- Intentionally deferred items

---

# Core Accounting Rules

Foreign transaction:

```text
Foreign amount × historical transaction rate = posted base amount
```

Realized FX:

```text
Settlement base amount
− carrying base amount settled
= realized FX gain/loss
```

Unrealized FX:

```text
Closing-rate base value
− current carrying base value
= unrealized FX gain/loss
```

The module must preserve:

- Original transaction currency
- Original foreign amount
- Historical exchange-rate snapshot
- Base-currency amount
- Settlement rate
- Realized FX
- Revaluation rate
- Unrealized FX
- Journal links
- Audit history

Historical posted documents must never change merely because exchange rates are edited later.
