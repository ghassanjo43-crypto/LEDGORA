# Statement of Account Module Specification

## Objective

Build a production-quality customer Statement of Account module in the existing React + TypeScript IFRS bookkeeping application.

Reuse the existing:

- Customers
- Invoices
- Credit notes
- Receipts
- Receipt allocations
- General Journal and General Ledger
- Chart of Accounts
- Entity selector
- Zustand and LocalStorage persistence
- Zod validation
- Print/PDF infrastructure
- Ledgerly ERP design system

Do not create a second receivables engine or store a duplicated customer balance.

---

## 1. Navigation

Under Sales add:

```text
Sales
- Customers
- Invoices
- Credit Notes
- Receipts
- Statements of Account
- Invoice Templates
```

Routes:

```text
/sales/statements
/sales/customers/:customerId/statement
```

Add `Generate Statement` on the customer profile and `View Customer Statement` from invoices, credit notes, and receipts.

---

## 2. Statement Types

Support:

```ts
type StatementType =
  | "balance-forward"
  | "open-item"
  | "activity-only"
```

- **Balance-forward:** opening balance, period activity, closing balance.
- **Open-item:** outstanding invoices, unapplied credits, and unapplied receipts.
- **Activity-only:** transactions within the selected dates only.

Default to `balance-forward`.

---

## 3. Source of Truth

Generate the statement from live source records:

- Issued, non-void invoices
- Issued/applied, non-void credit notes
- Posted, non-reversed receipts
- Receipt and credit applications
- Customer advances
- Refunds
- Posted manual journal adjustments with a customer ID
- Opening entries and reversals

Exclude:

- Draft documents
- Void invoices and credit notes
- Reversed receipts
- Deleted records
- Other entities or customers
- Unposted journal entries

Do not infer balances from status labels alone.

---

## 4. Types

Create `src/types/statementOfAccount.ts`.

```ts
export type StatementLineType =
  | "opening-balance"
  | "invoice"
  | "credit-note"
  | "receipt"
  | "customer-advance"
  | "refund"
  | "journal-adjustment"
  | "reversal"

export type StatementLine = {
  id: string
  type: StatementLineType
  date: string
  postingDate?: string
  dueDate?: string
  documentNumber?: string
  reference?: string
  description: string
  debit: number
  credit: number
  runningBalance: number
  currency: string
  baseCurrencyAmount?: number
  invoiceId?: string
  creditNoteId?: string
  receiptId?: string
  journalEntryId?: string
  status?: string
  isOverdue?: boolean
  daysOverdue?: number
}

export type AgingBucket = {
  id: "current" | "1-30" | "31-60" | "61-90" | "91-120" | "120-plus"
  label: string
  amount: number
  invoiceIds: string[]
}

export type AgingSummary = {
  asOfDate: string
  buckets: AgingBucket[]
  total: number
}

export type OutstandingInvoiceSummary = {
  invoiceId: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  originalTotal: number
  creditNotesApplied: number
  receiptsApplied: number
  outstandingBalance: number
  daysOverdue: number
  agingBucket: AgingBucket["id"]
  status: string
}

export type StatementOfAccount = {
  entityId: string
  customerId: string
  statementType: "balance-forward" | "open-item" | "activity-only"
  periodStart: string
  periodEnd: string
  asOfDate: string
  currencyMode: "single-currency" | "base-currency" | "multi-currency"
  currency?: string
  baseCurrency: string
  openingBalance: number
  periodDebits: number
  periodCredits: number
  closingBalance: number
  unappliedReceipts: number
  customerAdvances: number
  lines: StatementLine[]
  aging: AgingSummary
  outstandingInvoices: OutstandingInvoiceSummary[]
  reconciliationDifference: number
  isReconciled: boolean
  warnings: string[]
  generatedAt: string
}
```

---

## 5. Debit and Credit Convention

Use the customer receivable perspective:

- **Debit:** increases what the customer owes.
- **Credit:** reduces what the customer owes.

Examples:

| Transaction | Debit | Credit |
|---|---:|---:|
| Invoice | Invoice total | — |
| Credit note | — | Credit amount |
| Receipt | — | Amount posted to receivables |
| Debit adjustment | Amount | — |
| Credit adjustment | — | Amount |

Running balance:

```text
New balance = Previous balance + Debit - Credit
```

Never use `Math.abs()` to hide account direction.

A negative closing balance is a customer credit and must be labeled clearly.

---

## 6. Opening Balance

For a balance-forward statement:

```text
Opening balance = customer subledger balance immediately before periodStart
```

Use all valid transactions before the start date.

Do not assume zero and do not calculate opening balance only from open invoices.

Create:

```ts
calculateCustomerOpeningBalance(...)
```

Use the same entity, customer, currency, and date-basis filters as the statement.

---

## 7. Statement Line Rules

### Invoice

```text
Debit = original issued invoice grand total
Credit = 0
```

The invoice line must remain at its original total. Later credits and receipts appear separately.

### Credit note

```text
Debit = 0
Credit = amount posted/applied to receivables
```

Show the credit note number, reason, and original invoice.

### Receipt

```text
Debit = 0
Credit = amount posted to receivables
```

Show receipt number, method, reference, allocated amount, and unapplied amount.

### Manual journal adjustment

Use the actual debit or credit effect of the posted customer receivable line.

### Reversal

Use the exact opposite of the original financial effect.

---

## 8. Avoid Double Counting

Generated journal entries must not appear as extra statement events when the source document is already shown.

Example:

```text
INV-001 → JE-001
```

Show `INV-001` once. Do not also show `JE-001`.

Rules:

- Source documents take priority.
- Linked generated journals are excluded from statement events.
- Unlinked manual journals remain included.
- Receipt allocation rows are informational and must not change the running balance if the receipt line already did.

Create:

```ts
deduplicateStatementEvents(...)
```

---

## 9. Receipt Allocation Presentation

Show one financial receipt line, with expandable allocation detail:

```text
Receipt RCT-001                 Credit 5,000.00
  Applied to INV-001                    2,000.00
  Applied to INV-002                    1,500.00
  Applied to INV-003                    1,500.00
```

Do not add each allocation as another credit in the running balance.

---

## 10. Customer Advances and Unapplied Receipts

Show a separate summary:

- Customer advances
- Unapplied receipts
- Available customer credit

If an advance is posted to a liability account, it must not reduce receivables until applied.

Follow the actual configured accounting policy consistently.

---

## 11. Invoice Settlement

Reuse the existing invoice settlement builder.

For each invoice:

```text
Outstanding balance =
Original invoice total
- Applied credit notes
- Applied receipts
```

Do not derive outstanding balances from invoice status labels.

The statement transaction line shows the original invoice total; the outstanding schedule shows the current remaining amount.

---

## 12. Aging

Calculate aging as of the statement end date.

Buckets:

```text
Current
1-30 days overdue
31-60 days overdue
61-90 days overdue
91-120 days overdue
Over 120 days
```

Age the **remaining invoice balance**, not the original invoice total.

Use due date. If missing, use invoice date or configured terms.

```text
daysOverdue = max(0, asOfDate - dueDate)
```

Current includes invoices not yet due and due today.

---

## 13. Outstanding Invoice Schedule

Add:

```text
Outstanding invoices
```

Columns:

- Invoice number
- Invoice date
- Due date
- Original total
- Credit notes
- Receipts
- Outstanding
- Days overdue
- Aging bucket
- Status
- View

The schedule total must reconcile to outstanding receivables.

---

## 14. Statement Filters

Add:

- Entity
- Customer
- Statement type
- Start date
- End date
- As-of date
- Date basis: document date or posting date
- Currency mode
- Currency
- Include fully settled invoices
- Include unapplied receipts
- Include allocation details
- Include aging
- Include outstanding invoice schedule
- Include zero-value activity

Reuse existing pickers and date controls.

---

## 15. Currency

Support:

```ts
type StatementCurrencyMode =
  | "single-currency"
  | "base-currency"
  | "multi-currency"
```

Do not add different currencies together without conversion.

For historical base-currency values, use the exchange rate stored on the posted transaction, not today's rate.

If FX information is missing, show a warning.

---

## 16. Statement Summary

At the top show:

- Customer name and code
- Billing address
- Tax number
- Statement period
- Currency
- Opening balance
- Invoice debits
- Credit notes
- Receipts
- Adjustments
- Closing balance
- Overdue amount
- Unapplied receipts
- Customer credit

Example:

```text
Opening balance               USD 2,000.00
Invoices                      USD 8,000.00
Credit notes                 (USD 3,000.00)
Receipts                     (USD 2,000.00)
Closing balance               USD 5,000.00
```

---

## 17. Transaction Table

Columns:

```text
Date
Document
Reference
Description
Due date
Debit
Credit
Balance
```

Default sort:

```text
Date ascending
Then posting timestamp
Then document number
```

The financial running balance must remain chronological.

Each document number must be clickable:

- Invoice → invoice details
- Credit note → credit-note details
- Receipt → receipt details
- Journal adjustment → journal/ledger detail

Preserve statement filters when returning.

---

## 18. Reconciliation

Calculate:

```text
Closing balance =
Opening balance
+ Period debits
- Period credits
```

Compare to the customer subledger balance at period end.

Show:

- Calculated closing balance
- Subledger closing balance
- Difference

If within currency tolerance:

```text
Reconciled
```

Otherwise show a warning with possible causes:

- Missing customer metadata
- Duplicate document/journal event
- Reversed receipt still counted
- Draft document included
- Currency mismatch
- Date-basis mismatch
- Missing allocation

Never insert a balancing line.

---

## 19. Statement Renderer

Create a professional customer-facing renderer.

Title:

```text
Statement of Account
```

Include:

- Company logo and legal information
- Statement date
- Period
- Customer details
- Opening balance
- Transaction table
- Closing balance
- Aging summary
- Outstanding invoices
- Payment instructions
- Bank details
- Contact details
- Footer
- Page numbers

Repeat transaction headers on new pages.

---

## 20. Template Resolution

Provide a system default statement template.

Optional customization:

- Logo
- Colors
- Font
- Header layout
- Labels
- Aging visibility
- Outstanding-schedule visibility
- Bank details
- Footer
- Language
- LTR/RTL

Create:

```ts
resolveStatementTemplate(...)
```

Priority:

1. Statement-specific override
2. Customer preferred statement template
3. Entity default
4. System default

For MVP, live statements are acceptable. Include generated timestamp and data-as-of date.

---

## 21. Print and Export

Add:

- Print
- PDF
- CSV
- Excel if existing utilities support it

Print/PDF must show only the statement, not app navigation, filters, buttons, or sidebars.

Requirements:

- A4 and Letter
- Repeated headers
- Page numbers
- No blank pages
- Correct RTL rendering
- Closing balance and aging clearly visible

CSV/Excel columns:

- Date
- Posting date
- Type
- Document number
- Reference
- Description
- Debit
- Credit
- Running balance
- Currency
- Base amount
- Due date
- Days overdue
- Status

---

## 22. Customer Profile Integration

Add a `Statement of Account` section with:

- Current balance
- Overdue balance
- Unapplied receipts
- Available customer credit
- Oldest overdue invoice

Actions:

- Generate statement
- Print
- Download PDF
- Record receipt
- Create invoice
- Create credit note

---

## 23. Recommended Files

Adapt to actual project conventions:

```text
src/
  types/
    statementOfAccount.ts

  lib/
    statementOfAccount.ts
    statementOpeningBalance.ts
    statementAging.ts
    statementReconciliation.ts
    statementExport.ts
    statementTemplate.ts

  components/
    statements/
      StatementFilters.tsx
      StatementSummary.tsx
      StatementTransactionTable.tsx
      StatementAgingSummary.tsx
      OutstandingInvoicesTable.tsx
      StatementRenderer.tsx
      StatementPreview.tsx
      StatementPrintDocument.tsx
      StatementWarnings.tsx

  pages/
    StatementsPage.tsx
    CustomerStatementPage.tsx
```

Use a UI store only if needed. Do not persist duplicated accounting balances.

---

## 24. Core Functions

Implement:

```ts
selectCustomerTransactions(...)
calculateCustomerOpeningBalance(...)
deduplicateStatementEvents(...)
buildStatementLines(...)
calculateRunningBalances(...)
calculateStatementTotals(...)
calculateCustomerClosingBalance(...)
calculateAgingSummary(...)
buildOutstandingInvoiceSchedule(...)
validateStatementReconciliation(...)
resolveStatementTemplate(...)
exportStatementCsv(...)
exportStatementExcel(...)
```

Recommended main function:

```ts
buildStatementOfAccount({
  entityId,
  customerId,
  periodStart,
  periodEnd,
  statementType,
  statementBasis,
  currencyMode,
  currency,
  invoices,
  creditNotes,
  creditApplications,
  receipts,
  receiptAllocations,
  journalEntries,
  customers,
  accounts,
})
```

Keep business logic outside React components.

---

## 25. Acceptance Scenario

Customer A:

```text
Opening balance                          2,000.00
Invoice INV-2026-0006                   8,000.00
Credit Note CN-2026-0004               (3,000.00)
Receipt RCT-2026-0001                  (2,000.00)
```

Expected statement:

```text
Date        Document          Debit       Credit      Balance
01 Jul      Opening balance                           2,000.00
12 Jul      INV-2026-0006     8,000.00                10,000.00
12 Jul      CN-2026-0004                  3,000.00      7,000.00
15 Jul      RCT-2026-0001                 2,000.00      5,000.00
```

Expected totals:

```text
Opening balance:            2,000.00
Period debits:              8,000.00
Period credits:             5,000.00
Closing balance:            5,000.00
Reconciliation difference:      0.00
```

---

## 26. Tests

Add tests for:

1. Opening balance includes transactions before period start
2. Opening balance is not assumed zero
3. Draft invoices excluded
4. Void invoices excluded
5. Issued invoices included
6. Draft credit notes excluded
7. Void credit notes excluded
8. Issued credit notes included
9. Draft receipts excluded
10. Reversed receipts excluded
11. Posted receipts included
12. Manual customer journal adjustment included
13. Generated journals are not double counted
14. Receipt allocations are not double counted
15. Running balance is correct
16. Closing balance formula is correct
17. Statement reconciles to customer subledger
18. Invoice original total remains unchanged
19. Credit notes reduce balance
20. Receipts reduce balance
21. Customer/entity filtering works
22. Date filtering works
23. Balance-forward statement shows opening balance
24. Activity-only statement omits opening balance
25. Open-item statement shows outstanding items
26. Aging uses remaining balances
27. Aging uses due date
28. Aging buckets are correct
29. Outstanding schedule reconciles
30. Negative balance shows customer credit
31. Multi-currency values are not mixed
32. Base-currency mode uses historical base amounts
33. Reversal restores balance
34. Missing customer metadata creates warning
35. PDF excludes app chrome
36. Multi-page headers repeat
37. RTL renders correctly where supported
38. CSV totals match the statement
39. Empty customer renders safely
40. Browser refresh preserves route and filters
41. Document drill-down works

---

## 27. QA

Run:

- TypeScript typecheck
- Unit tests
- Production build
- Statement render smoke test
- Opening-balance test
- Invoice/credit/receipt integration test
- Running-balance test
- Aging test
- Multi-currency test
- Reconciliation test
- Duplicate-prevention test
- Print/PDF test
- Mobile-width test
- RTL test where supported
- LocalStorage hydration test
- Route refresh test

Report:

- Files created
- Files modified
- Source records used
- Opening balance
- Period debits
- Period credits
- Closing balance
- Aging totals
- Reconciliation result
- Duplicate-prevention result
- Tests
- Typecheck
- Production build
- Intentionally deferred items

---

## Core Formula

```text
Opening balance
+ Invoices and debit adjustments
- Credit notes
- Receipts
- Other credit adjustments
= Closing balance
```

Every reduction in the customer balance must be explained by a visible credit note, receipt, or adjustment.
