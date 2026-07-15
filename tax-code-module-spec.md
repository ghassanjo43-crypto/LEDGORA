# Tax Code Module Specification

## Objective

Build a production-quality **Tax Code module** in the existing React + TypeScript IFRS bookkeeping application.

The module must provide centralized tax configuration, calculation, posting, reporting, and historical preservation for:

- Sales invoices
- Customer credit notes
- Supplier bills
- Supplier credits
- Receipts and payments where withholding or cash-basis tax applies
- Manual General Journal adjustments
- Tax summary and reconciliation reports
- Multi-entity and multi-jurisdiction operation

Reuse the existing:

- Chart of Accounts
- General Journal and General Ledger
- Invoice, credit-note, bill, receipt, and payment stores
- AccountPicker and EntityPicker
- Zustand and LocalStorage persistence
- Zod validation
- Existing report and print/PDF infrastructure
- Ledgerly ERP design system

Do not duplicate tax rules inside transaction components.

Do not hardcode country-specific rates or reporting boxes in business logic.

---

## 1. Navigation

Under Settings add:

```text
Settings
- Company
- Chart of Accounts
- Tax Codes
- Tax Groups
- Tax Jurisdictions
- Tax Periods
```

Under Accounting add:

```text
Accounting
- Tax Summary
- Tax Detail
- Tax Reconciliation
```

Routes:

```text
/settings/tax-codes
/settings/tax-codes/new
/settings/tax-codes/:taxCodeId
/settings/tax-codes/:taxCodeId/edit
/settings/tax-groups
/settings/tax-jurisdictions
/settings/tax-periods
/accounting/tax-summary
/accounting/tax-detail
/accounting/tax-reconciliation
```

---

## 2. Supported Tax Categories

```ts
export type TaxCategory =
  | "standard"
  | "reduced"
  | "zero-rated"
  | "exempt"
  | "out-of-scope"
  | "reverse-charge"
  | "import"
  | "self-assessed"
  | "withholding"
  | "custom"
```

Important distinctions:

- **Zero-rated:** taxable base reported at 0%; not the same as exempt.
- **Exempt:** no tax charged; reported separately.
- **Out of scope:** outside the tax regime.
- **Reverse charge:** creates self-assessed output and input tax according to configuration.
- **Withholding:** recognized only at the configured transaction stage.

---

## 3. Tax Direction and Scope

```ts
export type TaxDirection =
  | "sales"
  | "purchase"
  | "both"
  | "withholding-receivable"
  | "withholding-payable"

export type TaxScope =
  | "domestic"
  | "export"
  | "import"
  | "intra-region"
  | "international"
  | "government"
  | "custom"
```

Filter transaction selectors by direction.

Do not show purchase-only codes on sales invoices or sales-only codes on supplier bills.

---

## 4. Tax Code Model

Create `src/types/taxCode.ts`.

```ts
export type TaxCode = {
  id: string
  entityId?: string

  code: string
  name: string
  description?: string

  category: TaxCategory
  direction: TaxDirection
  scope: TaxScope

  status: "active" | "inactive" | "archived"

  rate: number
  rateType: "percentage" | "fixed" | "zero"

  calculationMethod:
    | "exclusive"
    | "inclusive"
    | "compound"
    | "self-assessed"

  roundingMethod: "line" | "document"
  precision: number

  outputTaxAccountId?: string
  inputTaxAccountId?: string
  taxExpenseAccountId?: string
  taxReceivableAccountId?: string
  taxPayableAccountId?: string
  withholdingAccountId?: string
  reverseChargeOutputAccountId?: string
  reverseChargeInputAccountId?: string

  reportingBoxIds: string[]

  jurisdictionId?: string
  countryCode?: string
  regionCode?: string

  effectiveFrom: string
  effectiveTo?: string

  recoverabilityPercent?: number
  nonRecoverableAccountId?: string

  customerTypes?: string[]
  supplierTypes?: string[]
  productTaxCategories?: string[]

  isDefaultSales?: boolean
  isDefaultPurchase?: boolean
  isDefaultExport?: boolean
  isDefaultImport?: boolean

  requiresTaxNumber?: boolean
  requiresReason?: boolean
  requiresReverseChargeNote?: boolean

  displayLabel?: string
  invoiceLabel?: string
  billLabel?: string

  createdAt: string
  updatedAt: string
  createdBy?: string
  updatedBy?: string
}
```

---

## 5. Effective-Dated Rate Versions

Do not overwrite historical tax rates.

Create:

```ts
export type TaxRateVersion = {
  id: string
  taxCodeId: string

  rate: number
  effectiveFrom: string
  effectiveTo?: string

  outputTaxAccountId?: string
  inputTaxAccountId?: string
  taxPayableAccountId?: string
  taxReceivableAccountId?: string

  createdAt: string
  createdBy?: string
}
```

Create:

```ts
resolveTaxRateVersion(taxCodeId, transactionDate)
```

Rules:

- End-date the old version when the rate changes.
- Create a new version for the new rate.
- Block overlapping effective periods.
- Historical documents retain their original rate and mappings.
- New documents resolve the version applicable on their document/posting date.

---

## 6. Tax Snapshot

Every posted line must preserve a frozen tax snapshot.

```ts
export type TaxSnapshot = {
  taxCodeId: string
  taxCode: string
  taxName: string

  category: TaxCategory
  direction: TaxDirection

  rate: number
  rateType: string
  calculationMethod: string
  roundingMethod: string
  precision: number

  taxableAmount: number
  taxAmount: number
  grossAmount: number

  recoverabilityPercent?: number
  recoverableTaxAmount?: number
  nonRecoverableTaxAmount?: number

  outputTaxAccountId?: string
  inputTaxAccountId?: string
  taxExpenseAccountId?: string
  taxReceivableAccountId?: string
  taxPayableAccountId?: string
  withholdingAccountId?: string
  reverseChargeOutputAccountId?: string
  reverseChargeInputAccountId?: string

  reportingBoxIds: string[]

  effectiveFrom: string
  effectiveTo?: string
  capturedAt: string
}
```

Posted documents must use the snapshot for rendering, reversals, credits, and tax reporting.

Later edits to a tax code must not alter historical documents.

---

## 7. Tax Groups

Support multiple tax codes on one line.

```ts
export type TaxGroup = {
  id: string
  entityId?: string

  code: string
  name: string
  description?: string

  status: "active" | "inactive"
  taxCodeIds: string[]

  calculationOrder: "parallel" | "sequential"

  createdAt: string
  updatedAt: string
}
```

### Parallel

All taxes calculate on the same base.

### Sequential / compound

A later tax can calculate on base plus prior taxes.

Create:

```ts
calculateTaxGroup(...)
```

---

## 8. Tax Calculation Methods

```ts
export type TaxCalculationMethod =
  | "exclusive"
  | "inclusive"
  | "compound"
  | "self-assessed"
```

### Exclusive

```text
Net = quantity × unit price − discount
Tax = Net × rate
Gross = Net + Tax
```

### Inclusive

```text
Net = Gross / (1 + rate)
Tax = Gross − Net
```

### Compound

Tax is calculated in configured sequence.

### Self-assessed

Creates both tax debit and credit lines according to mapping.

---

## 9. Decimal-Safe Tax Utilities

Create centralized functions:

```ts
calculateTaxExclusive(...)
calculateTaxInclusive(...)
calculateCompoundTax(...)
calculateRecoverableTax(...)
calculateTaxLine(...)
calculateDocumentTaxTotals(...)
```

Use decimal-safe monetary utilities.

Do not use raw floating-point arithmetic for posted tax amounts.

Support separate:

- Currency precision
- Tax precision

---

## 10. Rounding

Support:

```ts
export type TaxRoundingMethod = "line" | "document"
```

### Line rounding

Calculate and round each line, then sum.

### Document rounding

Calculate on the aggregated taxable base, then round once.

Do not mix rounding methods inside one document.

Show a tax rounding adjustment when required.

---

## 11. Recoverable and Non-Recoverable Input Tax

Support partial recoverability.

Example:

```text
Input VAT: 100
Recoverable: 80%
Recoverable VAT: 80
Non-recoverable VAT: 20
```

Possible posting:

```text
Dr Expense / Asset                 1,020
Dr Input VAT recoverable              80
    Cr Trade payables                  1,100
```

Fields:

```ts
recoverabilityPercent?: number
nonRecoverableAccountId?: string
```

Do not assume all input tax is recoverable.

---

## 12. Sales Tax Posting

Example:

```text
Net sale: 1,000
Output tax: 160
Invoice total: 1,160
```

Journal:

```text
Dr Trade receivables              1,160
    Cr Revenue                           1,000
    Cr Output tax payable                  160
```

The tax code must resolve:

- Rate version
- Output-tax account
- Reporting boxes
- Snapshot

---

## 13. Purchase Tax Posting

Example:

```text
Expense: 1,000
Input tax: 160
Bill total: 1,160
```

Journal:

```text
Dr Expense                         1,000
Dr Input tax recoverable             160
    Cr Trade payables                    1,160
```

---

## 14. Credit Note and Supplier Credit Reversals

Customer credit note:

```text
Dr Sales returns / Revenue
Dr Output tax payable
    Cr Trade receivables
```

Supplier credit:

```text
Dr Trade payables
    Cr Expense / Asset / Inventory
    Cr Input tax recoverable
```

Use the original invoice or bill line tax snapshot.

Do not resolve today’s tax rate for a historical reversal.

Block reversing more tax than remains creditable.

---

## 15. Zero-Rated, Exempt, and Out-of-Scope

### Zero-rated

- Rate = 0
- Taxable base remains reportable
- No tax-account amount
- Separate reporting box

### Exempt

- Rate = 0
- Exempt base reported separately
- No tax-account amount

### Out-of-scope

- No tax calculation
- No tax-account posting
- Optional separate reporting classification

Do not treat these three categories as interchangeable.

---

## 16. Reverse Charge

Example purchase:

```text
Service purchase: 1,000
Reverse-charge tax: 160
```

Journal:

```text
Dr Expense                         1,000
Dr Input tax recoverable             160
    Cr Trade payables                    1,000
    Cr Output tax payable                  160
```

Support partial input-tax recoverability.

Require configured:

- Reverse-charge output account
- Reverse-charge input account
- Reporting boxes
- Optional document note

---

## 17. Import Tax

Support:

- Import VAT paid separately
- Deferred import tax
- Customs documents
- Import tax included or excluded from supplier payable

Do not assume import tax is always payable to the supplier.

Require explicit account and document-reference configuration.

---

## 18. Withholding Tax

Support timing:

```ts
export type WithholdingTiming =
  | "invoice"
  | "bill"
  | "receipt"
  | "payment"
```

Customer withholding:

```text
Dr Bank
Dr Withholding tax receivable
    Cr Trade receivables
```

Supplier withholding:

```text
Dr Trade payables
    Cr Bank
    Cr Withholding tax payable
```

Use one configured timing policy.

Do not recognize withholding twice.

---

## 19. Tax Jurisdictions

Create:

```ts
export type TaxJurisdiction = {
  id: string
  code: string
  name: string

  countryCode?: string
  regionCode?: string

  taxAuthorityName?: string
  baseCurrency?: string

  filingFrequency?:
    | "monthly"
    | "quarterly"
    | "annual"
    | "custom"

  status: "active" | "inactive"

  createdAt: string
  updatedAt: string
}
```

Filter tax-code availability by entity and jurisdiction.

---

## 20. Tax Registrations

```ts
export type TaxRegistration = {
  id: string
  entityId: string
  jurisdictionId: string

  registrationNumber: string
  registrationName?: string

  effectiveFrom: string
  effectiveTo?: string

  filingFrequency:
    | "monthly"
    | "quarterly"
    | "annual"
    | "custom"

  status: "active" | "inactive"

  createdAt: string
  updatedAt: string
}
```

Use the registration effective on the transaction date.

---

## 21. Tax Reporting Boxes

```ts
export type TaxReportingBox = {
  id: string
  jurisdictionId: string

  code: string
  name: string
  description?: string

  reportType:
    | "sales"
    | "purchases"
    | "output-tax"
    | "input-tax"
    | "reverse-charge"
    | "withholding"
    | "adjustment"
    | "custom"

  amountBasis:
    | "taxable-base"
    | "tax-amount"
    | "gross-amount"

  sign: "positive" | "negative"
  status: "active" | "inactive"
  sortOrder: number
}
```

Do not hardcode return-box numbers in invoice or bill components.

---

## 22. Tax Periods

```ts
export type TaxPeriod = {
  id: string
  entityId: string
  jurisdictionId: string

  periodStart: string
  periodEnd: string
  filingDueDate?: string

  status:
    | "open"
    | "prepared"
    | "filed"
    | "locked"
    | "reopened"

  filedAt?: string
  filedReference?: string

  createdAt: string
  updatedAt: string
}
```

Rules:

- Open: normal posting allowed
- Prepared: warn on changes
- Filed/locked: block changes without authorization
- Reopened: require permission and reason

---

## 23. Tax Summary Report

Route:

```text
/accounting/tax-summary
```

Filters:

- Entity
- Jurisdiction
- Tax period
- Date range
- Tax code
- Direction
- Category
- Currency
- Customer/supplier
- Document type

Show:

- Tax code
- Taxable base
- Tax amount
- Recoverable amount
- Non-recoverable amount
- Output tax
- Input tax
- Net payable/refundable
- Reporting boxes
- Document count

---

## 24. Tax Detail Report

Show:

- Date
- Document type
- Document number
- Customer/supplier
- Tax code
- Taxable amount
- Tax amount
- Gross amount
- Account
- Reporting box
- Journal entry
- Status
- Currency
- Exchange rate
- Base amount

Every row must drill down to the source document and journal.

---

## 25. Tax Reconciliation

Route:

```text
/accounting/tax-reconciliation
```

Compare:

```text
Tax report totals
vs
Tax control-account balances in the General Ledger
```

Show:

- Output tax report total
- Output tax GL balance
- Difference
- Input tax report total
- Input tax GL balance
- Difference
- Withholding balances
- Reverse-charge balances
- Unmapped tax transactions
- Tax-account journal lines without tax metadata

Do not create automatic balancing entries.

---

## 26. Tax Code List

Columns:

- Code
- Name
- Category
- Direction
- Rate
- Calculation method
- Output account
- Input account
- Jurisdiction
- Effective date
- Status
- Defaults
- Reporting boxes

Actions:

- View
- Edit
- Duplicate
- Create new rate version
- Deactivate
- Archive

Do not delete tax codes used by posted documents.

---

## 27. Tax Code Editor

Sections:

### General

- Code
- Name
- Description
- Category
- Direction
- Scope
- Jurisdiction
- Status

### Calculation

- Rate
- Rate type
- Calculation method
- Rounding method
- Precision
- Recoverability percentage

### Accounts

- Output tax account
- Input tax account
- Tax payable account
- Tax receivable account
- Tax expense account
- Non-recoverable account
- Withholding account
- Reverse-charge output account
- Reverse-charge input account

### Effective dates

- Effective from
- Effective to

### Reporting

- Reporting boxes
- Invoice label
- Bill label
- Return classification

### Defaults and restrictions

- Default sales
- Default purchase
- Default export
- Default import
- Customer types
- Supplier types
- Product tax categories
- Require tax number
- Require reason
- Require reverse-charge note

---

## 28. Validation

Create:

```ts
validateTaxCodeDraft(...)
validateTaxCodeForActivation(...)
validateTaxCodeForTransaction(...)
```

Activation requires:

- Unique code within entity/jurisdiction
- Name
- Category
- Direction
- Rate
- Calculation method
- Effective date
- Required account mappings
- Reporting-box mapping where required
- Valid precision
- No overlapping rate versions

Block:

- Invalid percentage rate
- Missing output account for taxable sales code
- Missing input account for taxable purchase code
- Missing reverse-charge accounts
- Missing withholding account
- Header/non-posting accounts
- Duplicate active defaults
- Overlapping effective periods

---

## 29. Default Tax Resolution

Create:

```ts
resolveDefaultTaxCode(...)
```

Priority:

1. Explicit line tax code
2. Product/service tax category
3. Customer/supplier tax profile
4. Transaction type
5. Entity default
6. No tax

Never override an explicitly selected tax code silently.

Show where a default came from.

---

## 30. Party Tax Profiles

```ts
export type PartyTaxProfile = {
  taxRegistrationNumber?: string
  taxJurisdictionId?: string
  taxExempt?: boolean
  exemptionReason?: string
  defaultSalesTaxCodeId?: string
  defaultPurchaseTaxCodeId?: string
  reverseChargeEligible?: boolean
  withholdingApplicable?: boolean
}
```

Do not infer tax exemption only because a tax number is missing.

---

## 31. Product Tax Categories

```ts
export type ProductTaxCategory = {
  id: string
  code: string
  name: string
  defaultSalesTaxCodeId?: string
  defaultPurchaseTaxCodeId?: string
}
```

Use these to suggest tax codes, not to override explicit party or jurisdiction rules.

---

## 32. Invoice Integration

Invoice lines must store:

- Tax code ID
- Tax snapshot
- Taxable amount
- Tax amount
- Gross amount
- Reporting boxes

Invoice summary must group tax by code/rate.

Posting uses snapshot accounts.

---

## 33. Bill Integration

Bill lines must store:

- Purchase tax code
- Tax snapshot
- Recoverable amount
- Non-recoverable amount
- Taxable amount
- Tax amount

Posting uses snapshot mappings.

---

## 34. Credit Integration

Linked customer or supplier credits default from the original tax snapshot.

Show:

- Original tax code
- Original tax rate
- Tax reversed

Block reversing more tax than remains available.

---

## 35. Receipt and Payment Integration

Ordinary receipt/payment settlement must not calculate VAT again.

Tax applies only when:

- Cash-basis recognition is configured
- Withholding applies
- Direct expense/payment uses a tax code
- Jurisdiction requires payment-stage tax

---

## 36. General Journal Integration

Allow optional tax code on manual journal lines.

When selected:

- Calculate taxable and tax split
- Create tax control line
- Preserve tax snapshot
- Require party metadata where applicable
- Include in tax reporting

Warn when a journal hits a tax control account without tax metadata.

---

## 37. Tax Basis

Support entity configuration:

```ts
export type TaxRecognitionBasis = "invoice" | "cash"
```

Recommended MVP default:

```text
Invoice basis
```

Do not mix bases without explicit entity configuration.

---

## 38. Locked Tax Periods

When a period is locked, block:

- Backdated taxable documents
- Tax-snapshot edits
- Reversals into the locked period
- Tax-account changes on posted records

Override requires:

- Permission
- Reason
- Audit event
- Reopened period or adjustment period

---

## 39. Tax Adjustments

```ts
export type TaxAdjustmentType =
  | "rounding"
  | "bad-debt-relief"
  | "prior-period"
  | "partial-exemption"
  | "capital-goods"
  | "error-correction"
  | "other"
```

Require:

- Tax period
- Tax code
- Reporting box
- Tax account
- Amount
- Reason
- Journal entry

Do not edit filed source documents to force return totals.

---

## 40. Deactivation and Archiving

For tax codes already used:

- Allow deactivation or archival
- Do not allow hard delete
- Preserve historical snapshots
- Prevent use after effective end date
- Continue rendering historical documents

---

## 41. Permissions

Suggested permissions:

- View tax codes
- Create tax codes
- Edit inactive tax codes
- Activate/deactivate tax codes
- Create rate versions
- Manage tax groups
- Manage jurisdictions
- Manage tax periods
- Prepare tax reports
- Lock/reopen tax periods
- Post tax adjustments
- Override validation
- View reconciliation

---

## 42. Audit Trail

Record:

- Tax code created
- Rate version created
- Account mapping changed
- Reporting box changed
- Effective dates changed
- Activated/deactivated
- Default changed
- Tax period prepared/filed/locked/reopened
- Tax adjustment posted
- Override used

Never overwrite history.

---

## 43. Recommended Files

```text
src/
  types/
    taxCode.ts
    taxReporting.ts

  store/
    taxCodeStore.ts
    taxPeriodStore.ts

  lib/
    taxCalculations.ts
    taxValidation.ts
    taxResolution.ts
    taxSnapshots.ts
    taxPosting.ts
    taxReporting.ts
    taxReconciliation.ts
    taxRounding.ts

  components/
    tax/
      TaxCodeList.tsx
      TaxCodeEditor.tsx
      TaxCodeDrawer.tsx
      TaxGroupEditor.tsx
      TaxRateVersionTable.tsx
      TaxAccountMappings.tsx
      TaxReportingBoxPicker.tsx
      TaxSummaryReport.tsx
      TaxDetailReport.tsx
      TaxReconciliationView.tsx
      TaxPeriodManager.tsx

  pages/
    TaxCodesPage.tsx
    TaxGroupsPage.tsx
    TaxSummaryPage.tsx
    TaxDetailPage.tsx
    TaxReconciliationPage.tsx
```

Keep all tax business logic outside React components.

---

## 44. Core Functions

```ts
calculateTaxExclusive(...)
calculateTaxInclusive(...)
calculateCompoundTax(...)
calculateRecoverableTax(...)
calculateTaxLine(...)
calculateDocumentTaxTotals(...)
calculateTaxGroup(...)
resolveTaxRateVersion(...)
resolveDefaultTaxCode(...)
resolveTaxAccounts(...)
createTaxSnapshot(...)
validateTaxCodeDraft(...)
validateTaxCodeForActivation(...)
validateTaxCodeForTransaction(...)
buildTaxPostingLines(...)
buildTaxSummaryReport(...)
buildTaxDetailReport(...)
reconcileTaxControlAccounts(...)
```

---

## 45. Persistence

Persist with Zustand and LocalStorage:

- Tax codes
- Rate versions
- Tax groups
- Jurisdictions
- Registrations
- Reporting boxes
- Tax periods
- Adjustments
- Audit metadata

Do not persist temporary calculation output as authoritative tax data.

---

## 46. Acceptance Scenarios

### Standard sales tax

```text
Net: 1,000.00
Tax rate: 16%
Tax: 160.00
Gross: 1,160.00
```

Journal:

```text
Dr Trade receivables          1,160.00
    Cr Revenue                      1,000.00
    Cr Output tax payable             160.00
```

### Standard purchase tax

```text
Expense: 1,000.00
Tax: 160.00
Total: 1,160.00
```

Journal:

```text
Dr Expense                    1,000.00
Dr Input tax recoverable        160.00
    Cr Trade payables                1,160.00
```

### Inclusive tax

```text
Gross: 1,160.00
Rate: 16%
Net: 1,000.00
Tax: 160.00
```

### Zero-rated

```text
Taxable base: 5,000.00
Tax rate: 0%
Tax amount: 0.00
```

Expected:

- Included in zero-rated reporting box
- Not classified as exempt
- No tax-account amount

### Partial recoverability

```text
Input tax: 160.00
Recoverability: 75%
Recoverable: 120.00
Non-recoverable: 40.00
```

### Reverse charge

```text
Net purchase: 1,000.00
Reverse-charge tax: 160.00
```

Journal:

```text
Dr Expense                    1,000.00
Dr Input tax recoverable        160.00
    Cr Trade payables                1,000.00
    Cr Output tax payable              160.00
```

### Rate change

```text
16% through 31 Dec 2026
18% from 1 Jan 2027
```

Expected:

- 2026 documents remain at 16%
- 2027 documents use 18%
- No historical mutation
- No overlapping versions

---

## 47. Tests

Add tests for:

1. Exclusive sales tax
2. Exclusive purchase tax
3. Inclusive tax extraction
4. Zero-rated vs exempt
5. Out-of-scope exclusion
6. Compound tax
7. Line rounding
8. Document rounding
9. Partial recoverability
10. Non-recoverable posting
11. Reverse-charge dual posting
12. Import tax mapping
13. Withholding timing
14. Withholding not double recognized
15. Rate resolution by date
16. Historical snapshots remain unchanged
17. Effective-date overlap blocked
18. Duplicate code blocked
19. Missing output account blocked
20. Missing input account blocked
21. Header account blocked
22. Tax group order correct
23. Invoice integration
24. Bill integration
25. Credit note uses original snapshot
26. Supplier credit uses original snapshot
27. Receipt does not duplicate invoice tax
28. Payment does not duplicate bill tax
29. Manual journal tax works
30. Generated journal not double counted
31. Tax summary totals
32. Reporting box totals
33. GL reconciliation
34. Missing tax metadata warning
35. Locked period blocking
36. Reopen permission/reason
37. Inactive code unavailable for new transactions
38. Historical inactive code still renders
39. Entity/jurisdiction filtering
40. Multi-currency base tax values
41. LocalStorage hydration
42. Empty state
43. Mobile editor
44. Route refresh

---

## 48. QA

Run:

- TypeScript typecheck
- Unit tests
- Production build
- Tax code creation smoke test
- Sales invoice tax test
- Purchase bill tax test
- Credit-note reversal test
- Inclusive tax test
- Zero-rated test
- Exempt test
- Reverse-charge test
- Recoverability test
- Rate-version test
- Tax summary test
- Tax detail test
- Tax reconciliation test
- Tax-period lock test
- LocalStorage hydration test
- Mobile-width test
- Route refresh test

Report:

- Files created
- Files modified
- Tax categories implemented
- Calculation methods implemented
- Account mappings used
- Rate-version logic
- Snapshot logic
- Reporting-box logic
- Reconciliation result
- Acceptance-scenario results
- Tests
- Typecheck
- Production build
- Deferred items

---

## Core Accounting Rules

Sales tax:

```text
Dr Trade receivables
    Cr Revenue
    Cr Output tax payable
```

Purchase tax:

```text
Dr Expense / Asset / Inventory
Dr Input tax recoverable
    Cr Trade payables
```

Customer credit:

```text
Dr Revenue / Sales returns
Dr Output tax payable
    Cr Trade receivables
```

Supplier credit:

```text
Dr Trade payables
    Cr Expense / Asset / Inventory
    Cr Input tax recoverable
```

Reverse charge:

```text
Dr Input tax recoverable
    Cr Output tax payable
```

The Tax Code module must remain the centralized source of tax calculations, account mappings, effective dates, historical snapshots, reporting boxes, validation, and audit history.

Posted documents must never change because a tax code or tax rate is edited later.
