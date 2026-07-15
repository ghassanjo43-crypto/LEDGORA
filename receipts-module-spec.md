# Receipts Module Specification

## Project Context

Implement a production-quality **Receipts module** in the existing React + TypeScript IFRS bookkeeping application.

The application already contains or is expected to contain:

- Customers
- Invoices
- Invoice templates
- Credit notes
- General Journal
- General Ledger
- Trial Balance
- Income Statement
- Balance Sheet
- Cash Flow Statement
- Chart of Accounts
- Tax codes
- Entities / companies
- Entity selector
- Bank and cash accounts
- Zustand stores
- Zod validation
- LocalStorage persistence
- Ledgerly ERP design system

Existing invoice-related paths include patterns such as:

- `src/components/invoices/`
- `src/store/invoiceStore.ts`
- `src/types/invoice.ts`
- `src/lib/invoicePosting.ts`
- invoice numbering
- invoice validation
- invoice rendering
- invoice template logic

The Receipts module must reuse the existing accounting engine, journal posting service, account pickers, customer selectors, entity selectors, formatting utilities, date controls, persistence patterns, and design system.

Do not create a separate accounting engine.

---

# 1. Core Purpose

The Receipts module records money received by the business.

It must support:

1. Customer receipt against one invoice
2. Customer receipt allocated across multiple invoices
3. Partial invoice payment
4. Full invoice payment
5. Customer advance / deposit
6. Unapplied customer receipt
7. Receipt of customer credit balance
8. Receipt by bank
9. Receipt by cash
10. Receipt by cheque
11. Receipt by card or transfer reference
12. Miscellaneous receipt not linked to a customer invoice
13. Owner capital contribution
14. Loan proceeds
15. Interest income receipt
16. Refund received from supplier
17. Other operating receipt
18. Reversal / void of an issued receipt
19. Printing and downloading an official receipt document
20. Customer statement integration

The main first-release workflow should be:

```text
Customer
→ Receive Payment
→ Select invoices
→ Allocate amount
→ Post receipt
→ Generate official receipt
```

---

# 2. Navigation

Under Sales, add:

```text
Sales
- Customers
- Invoices
- Credit Notes
- Receipts
- Invoice Templates
```

If the application has a Banking section, also add an optional shortcut:

```text
Banking
- Bank Accounts
- Receipts
- Payments
- Reconciliation
```

Primary routes:

```text
/sales/receipts
/sales/receipts/new
/sales/receipts/:receiptId
/sales/receipts/:receiptId/edit
```

Optional shortcut route:

```text
/banking/receipts
```

Both routes must use the same data and business logic.

From an invoice, add:

```text
Record Receipt
```

From a customer profile, add:

```text
Receive Payment
```

From the dashboard, optionally add:

```text
New Receipt
```

---

# 3. Receipt Types

Create a centralized receipt type:

```ts
export type ReceiptType =
  | "customer-payment"
  | "customer-advance"
  | "unapplied-customer-receipt"
  | "miscellaneous-income"
  | "owner-contribution"
  | "loan-proceeds"
  | "interest-income"
  | "supplier-refund"
  | "other"
```

Recommended behavior:

## Customer payment

Used when money is received from a customer and allocated to one or more invoices.

## Customer advance

Used when money is received before an invoice exists.

The receipt creates a customer credit / advance liability or reduces receivables according to the application’s configured accounting policy.

## Unapplied customer receipt

Used when the customer is known but the payment cannot yet be assigned to an invoice.

It must remain available for later allocation.

## Miscellaneous income

Used for non-invoice income.

Requires a selected income or other credit account.

## Owner contribution

Used for capital introduced by an owner or shareholder.

## Loan proceeds

Used for money received under a borrowing arrangement.

## Interest income

Used for interest received.

## Supplier refund

Used for money returned by a supplier.

## Other

Requires a detailed explanation and explicit credit account.

---

# 4. Receipt Status

Create:

```ts
export type ReceiptStatus =
  | "draft"
  | "approved"
  | "posted"
  | "partially-allocated"
  | "fully-allocated"
  | "reversed"
  | "void"
```

Recommended workflow:

```text
Draft
→ Approved
→ Posted
→ Partially allocated / Fully allocated
```

Additional terminal statuses:

```text
Reversed
Void
```

A posted receipt must not be materially edited.

For corrections:

- Reverse the receipt
- Create a replacement receipt

Do not delete posted receipts.

---

# 5. Receipt Model

Create `src/types/receipt.ts`.

Recommended model:

```ts
export type ReceiptMethod =
  | "cash"
  | "bank-transfer"
  | "cheque"
  | "card"
  | "online-transfer"
  | "other"

export type Receipt = {
  id: string
  entityId: string

  receiptNumber: string
  receiptType: ReceiptType
  status: ReceiptStatus

  customerId?: string
  supplierId?: string

  receiptDate: string
  valueDate?: string

  currency: string
  exchangeRate: number

  amount: number
  baseCurrencyAmount: number

  method: ReceiptMethod

  bankAccountId?: string
  cashAccountId?: string
  depositAccountId?: string

  chequeNumber?: string
  chequeDate?: string
  chequeBankName?: string

  transactionReference?: string
  cardReference?: string
  transferReference?: string

  payerName?: string
  payerAccountName?: string
  payerBankName?: string

  narration?: string
  notes?: string

  allocationTotal: number
  unappliedAmount: number

  journalEntryId?: string
  reversalJournalEntryId?: string

  templateId?: string
  templateVersionId?: string
  templateSnapshot?: ReceiptTemplateSnapshot

  postedAt?: string
  approvedAt?: string
  reversedAt?: string
  voidedAt?: string

  reverseReason?: string
  voidReason?: string

  createdAt: string
  updatedAt: string
}
```

---

# 6. Receipt Allocation Model

Create:

```ts
export type ReceiptAllocation = {
  id: string
  entityId: string
  receiptId: string

  customerId?: string

  invoiceId?: string
  creditNoteId?: string

  allocationType:
    | "invoice"
    | "customer-advance"
    | "customer-credit"
    | "other"

  amount: number
  baseCurrencyAmount: number

  allocationDate: string

  createdAt: string
  updatedAt: string
}
```

A receipt may be allocated across multiple invoices.

Example:

```text
Receipt amount: 10,000.00

Invoice INV-001: 3,000.00
Invoice INV-002: 4,000.00
Invoice INV-003: 2,000.00
Unapplied amount: 1,000.00
```

Rules:

```text
Allocation total ≤ Receipt amount
```

```text
Unapplied amount = Receipt amount − Allocation total
```

Do not allow allocations to exceed:

- Receipt amount
- Remaining invoice balance
- Customer balance
- Currency-compatible amount unless supported by exchange logic

---

# 7. Customer Receipt Workflow

From an invoice:

```text
Invoice
→ Record Receipt
```

Prefill:

- Entity
- Customer
- Invoice
- Invoice currency
- Outstanding balance
- Due date
- Receipt amount equal to outstanding balance
- Receipt date = current date
- Suggested bank account
- Suggested receipt method

Allow the user to reduce the amount for partial payment.

From a customer:

```text
Customer
→ Receive Payment
```

Show all open invoices.

Columns:

- Select
- Invoice number
- Invoice date
- Due date
- Original total
- Credits applied
- Payments received
- Outstanding balance
- Amount to allocate

Provide actions:

- Auto-allocate oldest invoices first
- Auto-allocate by due date
- Allocate selected invoice only
- Clear allocations

Default allocation policy:

```text
Oldest due invoice first
```

but allow manual override.

---

# 8. Partial Payment

Support partial invoice receipts.

Example:

```text
Invoice total: 1,160.00
Previously paid: 0.00
Receipt: 500.00
Balance remaining: 660.00
```

After posting:

- Invoice status becomes `partially-paid`
- Amount paid increases by 500.00
- Balance due becomes 660.00
- Receipt remains linked to the invoice
- Customer statement shows the receipt and allocation

Do not change the original invoice total.

---

# 9. Full Payment

When receipt allocation equals the invoice balance:

- Invoice balance becomes 0.00
- Invoice status becomes `paid`
- Paid date is updated
- Receipt is shown on the invoice
- Customer statement reflects the settlement

Do not mark an invoice paid merely because a receipt exists.

It must be fully allocated and the invoice balance must equal zero within rounding tolerance.

---

# 10. Multiple-Invoice Allocation

Allow one receipt to settle multiple invoices.

Example:

```text
Receipt: 5,000.00

INV-001 outstanding: 2,000.00
INV-002 outstanding: 1,500.00
INV-003 outstanding: 2,500.00

Allocation:
INV-001: 2,000.00
INV-002: 1,500.00
INV-003: 1,500.00

Unapplied: 0.00
```

Result:

- INV-001 paid
- INV-002 paid
- INV-003 partially paid
- Receipt allocation total = 5,000.00

---

# 11. Overpayment

If the receipt exceeds selected invoice balances:

Example:

```text
Receipt: 2,000.00
Invoice balance: 1,500.00
Excess: 500.00
```

Offer:

1. Leave 500.00 as unapplied customer credit
2. Apply to another invoice
3. Record as customer advance
4. Reduce receipt amount

Do not force the overpayment into an invoice.

Do not create fake revenue for the excess.

---

# 12. Customer Advance

A customer advance is money received before an invoice is issued.

Recommended accounting policy:

```text
Dr Bank / Cash
    Cr Customer advances / Unearned revenue
```

When later applied to an invoice:

```text
Dr Customer advances / Unearned revenue
    Cr Trade receivables
```

Do not recognize revenue merely because an advance was received.

If the project instead uses a customer-credit subledger against receivables, centralize the policy and use it consistently.

Recommended configuration:

```ts
export type ReceiptPostingConfig = {
  tradeReceivablesAccountId: string
  customerAdvanceAccountId?: string
  unappliedReceiptsAccountId?: string
  bankAccountIds: string[]
  cashAccountIds: string[]
  defaultBankAccountId?: string
  defaultCashAccountId?: string
  otherIncomeAccountId?: string
}
```

---

# 13. Unapplied Receipts

A receipt may remain partly or fully unapplied.

Show:

```text
Receipt amount
Allocated amount
Unapplied amount
```

Unapplied receipt must remain available for later application.

Create a separate action:

```text
Apply Receipt
```

From the receipt detail page, allow selecting eligible invoices for the same:

- Entity
- Customer
- Currency, unless FX allocation is supported
- Open status

Application after posting is a subledger allocation.

It must not create another bank receipt journal entry.

Where customer-advance reclassification is required, create only the necessary reclassification journal entry according to policy.

---

# 14. Receipt Methods

Support:

## Cash

Require a cash account.

## Bank transfer

Require a bank account and transfer reference.

## Cheque

Require:

- Cheque number
- Cheque date
- Bank name
- Deposit bank account

Optional future cheque statuses:

```text
Received
Deposited
Cleared
Bounced
Cancelled
```

For the MVP, the receipt may post when the cheque is treated as received or cleared according to system policy.

## Card

Require:

- Card settlement account or bank account
- Card reference
- Optional processing-fee handling

## Online transfer

Require transaction reference.

## Other

Require explanation.

---

# 15. Receipt Numbering

Create entity-specific receipt numbering.

Default format:

```text
RCT-2026-0001
```

Configuration:

- Prefix
- Include year
- Sequence length
- Next sequence
- Annual reset
- Separate sequence by entity

Create centralized helper:

```ts
generateReceiptNumber(...)
```

Rules:

- Unique per entity
- Never reuse a posted, reversed, or voided receipt number
- Follow the invoice-numbering persistence pattern
- Do not silently renumber historical receipts

---

# 16. Accounting Posting

A draft receipt must not affect accounting.

When posted, create a balanced General Journal entry through the existing posting service.

Do not modify General Ledger balances directly.

## Customer invoice receipt

Example:

```text
Dr Bank                         1,160
    Cr Trade receivables               1,160
```

## Cash receipt

```text
Dr Cash                         500
    Cr Trade receivables               500
```

## Customer advance

```text
Dr Bank                       5,000
    Cr Customer advances             5,000
```

## Miscellaneous income receipt

```text
Dr Bank                       1,000
    Cr Other income                  1,000
```

## Owner contribution

```text
Dr Bank                     100,000
    Cr Owner capital              100,000
```

## Loan proceeds

```text
Dr Bank                      50,000
    Cr Loan payable                50,000
```

## Supplier refund

Depending on the original transaction:

```text
Dr Bank
    Cr Trade payables / Expense recovery / Inventory
```

Use the selected or derived account mapping.

The generated journal entry must include:

- Receipt number
- Receipt type
- Customer or payer
- Invoice references
- Receipt date
- Bank or cash account
- Transaction reference
- Receipt ID
- Entity
- Currency
- Exchange rate
- Clear memo

Store `journalEntryId` on the receipt.

---

# 17. Journal Line Construction

Create:

```ts
buildReceiptJournalEntry(...)
```

The debit side is normally:

- Bank account
- Cash account
- Cheque clearing account
- Card settlement account

The credit side depends on receipt type:

- Trade receivables
- Customer advance liability
- Unapplied receipts liability
- Other income
- Owner capital
- Loan payable
- Supplier-related account
- Explicitly selected credit account

For customer receipts allocated to several invoices, the accounting entry may still credit the same trade-receivables control account as one aggregated line, while allocation details remain in the subledger.

Preserve customer and invoice references in metadata.

Do not create one bank debit per invoice unless required by existing journal design.

---

# 18. Multi-Currency Receipts

Support invoice currency and base currency.

Fields:

- Receipt currency
- Exchange rate
- Receipt amount
- Base-currency amount

Rules:

```text
Base amount = Receipt amount × Exchange rate
```

Use decimal-safe calculations.

When receipt currency differs from invoice currency:

- Either block allocation in the first release
- Or use the project’s existing FX settlement logic

Do not invent ad hoc FX behavior.

If FX settlement is supported, calculate realized exchange gain or loss.

Example:

```text
Dr Bank
Dr/Cr Realized FX gain or loss
    Cr Trade receivables
```

Use centralized configured FX accounts.

---

# 19. Bank Fees

Optional support for fees deducted from a receipt.

Example:

Customer pays 1,000.00, bank deposits 990.00, fee 10.00.

Journal:

```text
Dr Bank                         990
Dr Bank charges expense         10
    Cr Trade receivables             1,000
```

Recommended model fields:

```ts
bankFeeAmount?: number
bankFeeAccountId?: string
grossReceiptAmount?: number
netBankAmount?: number
```

For the first release, this may be supported only for bank/card receipts.

Do not reduce invoice payment by the bank fee if the customer actually settled the full invoice.

---

# 20. Withholding Tax

Where customers deduct withholding tax, support:

Example:

Invoice receivable: 1,000.00  
Cash received: 950.00  
Withholding tax receivable: 50.00

Journal:

```text
Dr Bank                               950
Dr Withholding tax receivable          50
    Cr Trade receivables                    1,000
```

Recommended fields:

```ts
withholdingTaxAmount?: number
withholdingTaxAccountId?: string
withholdingTaxCertificateReference?: string
```

Only enable this when tax/account mappings exist.

---

# 21. Invoice Integration

On invoice details, add:

## Receipts

Columns:

- Receipt number
- Date
- Method
- Amount
- Amount allocated
- Status
- Reference

Show invoice summary:

```text
Original total
Less credit notes
Less receipts
Balance due
```

Add action:

```text
Record Receipt
```

Disable when:

- Invoice is draft
- Invoice is void
- Invoice is fully settled
- User lacks permission

If the invoice is paid, still allow viewing linked receipts.

---

# 22. Credit Note Interaction

Credit notes reduce invoice balance before receipt allocation.

Invoice settlement should be:

```text
Balance due =
Original invoice total
− Applied credit notes
− Applied receipts
```

Do not allow receipt allocation above the current adjusted invoice balance.

Customer credit notes and unapplied receipts must be displayed separately.

Do not confuse:

- Credit note
- Customer advance
- Unapplied receipt
- Refund

---

# 23. Customer Statement

Receipts must appear in the customer statement.

Statement rows may include:

- Invoice
- Credit note
- Receipt
- Receipt allocation
- Refund
- Opening balance
- Closing balance

For a posted customer receipt:

```text
Receipt decreases customer receivable balance
```

Show:

- Receipt number
- Date
- Reference
- Amount
- Allocation
- Unapplied amount

---

# 24. Receipt Document

Provide an official receipt document.

Default title:

```text
Official Receipt
```

The document must include:

- Company logo
- Company legal name
- Company address
- Company tax number
- Receipt number
- Receipt date
- Customer / payer name
- Customer address
- Amount received
- Amount in words
- Currency
- Receipt method
- Bank or cash account description
- Cheque number where relevant
- Transaction reference
- Invoice allocations
- Unapplied amount
- Narration
- Notes
- Authorized signature
- Footer
- Page number

Example:

```text
Received from: Customer A
Amount: 1,160.00 JOD
For settlement of: INV-2026-0001
Method: Bank transfer
Reference: TRX-88421
```

---

# 25. Receipt Templates

Create a built-in default receipt format.

Support receipt template customization similar to invoice templates.

Template resolution priority:

1. Receipt-specific template selected on the receipt
2. Customer preferred receipt template, if implemented
3. Entity default receipt template
4. System default receipt template

Recommended resolver:

```ts
resolveReceiptTemplate(...)
```

Allow customization of:

- Logo
- Colors
- Font
- Header layout
- Receipt title
- Labels
- Signature
- Bank details
- Footer
- Language
- LTR / RTL

Freeze the receipt template snapshot when posted.

Later changes to:

- Company logo
- Customer name
- Company details
- Template colors
- Labels

must not alter a posted receipt.

---

# 26. Amount in Words

Create a reusable amount-to-words function.

Example:

```text
One thousand one hundred sixty Jordanian dinars only
```

Support at least:

- English
- Arabic, if the application already supports Arabic

Do not hardcode one currency.

Use the receipt currency and configured minor-unit names.

Examples:

- Dinar / fils
- Dollar / cent
- Dirham / fils

---

# 27. Receipt Editor UI

Create an editor consistent with the invoice and credit-note drawers/pages.

Header:

- Entity
- Receipt type
- Receipt number
- Receipt date
- Value date
- Customer / payer
- Currency
- Exchange rate
- Amount
- Method
- Bank or cash account
- Transaction reference

Conditional fields:

- Cheque number
- Cheque date
- Cheque bank
- Card reference
- Transfer reference
- Supplier
- Credit account
- Loan account
- Owner capital account
- Withholding tax
- Bank fees

Allocation section:

- Open invoices
- Invoice outstanding amount
- Allocation amount
- Remaining receipt amount
- Auto-allocation controls

Summary:

```text
Receipt amount
Allocated amount
Unapplied amount
Bank fee
Withholding tax
Net bank amount
```

Actions:

- Save draft
- Preview
- Approve
- Post receipt
- Cancel

Draft saving may permit incomplete data.

Posting requires full validation.

---

# 28. Receipt List

Create a Receipts page.

Columns:

- Receipt number
- Date
- Customer / payer
- Type
- Method
- Currency
- Amount
- Allocated
- Unapplied
- Status
- Journal status
- Bank / cash account
- Reference

Filters:

- Entity
- Date range
- Customer
- Receipt type
- Receipt method
- Status
- Bank account
- Cash account
- Currency
- Fully allocated
- Partially allocated
- Unapplied only
- Reversed only

Actions:

- View
- Edit draft
- Preview
- Print
- Download PDF
- Apply receipt
- Duplicate
- Reverse
- Void draft

---

# 29. Receipt Detail Page

Show:

- Receipt header
- Payer / customer
- Method
- Bank / cash account
- Currency
- Amount
- Journal entry
- Allocations
- Unapplied amount
- Audit trail
- Print preview
- Template snapshot details

Actions based on status:

Draft:

- Edit
- Approve
- Post
- Delete draft

Posted:

- Print
- Download PDF
- Apply unapplied amount
- Reverse

Reversed:

- View original
- View reversal journal
- Create replacement

---

# 30. Draft Rules

A draft receipt may be incomplete.

Draft save may permit:

- Missing bank account
- Missing allocations
- Unbalanced allocation
- Missing reference
- Missing payer

But it should require enough structure to persist safely:

- Entity
- Draft ID
- Receipt type
- Created timestamp

Do not post draft receipts to the journal.

---

# 31. Posting Validation

Create separate validators:

```ts
validateReceiptDraft(...)
validateReceiptForPosting(...)
```

Posting must require:

- Entity
- Unique receipt number
- Receipt date
- Receipt type
- Positive amount
- Currency
- Valid exchange rate
- Receipt method
- Valid debit account
- Valid credit account or customer receivable mapping
- Customer for customer-related receipts
- Supplier for supplier refund where applicable
- Allocation total not above receipt amount
- Invoice allocation not above invoice balance
- Customer/entity/currency compatibility
- Balanced journal entry
- Valid bank-fee account where bank fee exists
- Valid withholding-tax account where withholding exists

Block:

- Negative receipt amount
- Zero-value receipt
- Allocation above receipt amount
- Allocation above invoice balance
- Posting to header/non-posting accounts
- Draft invoice allocation
- Void invoice allocation
- Duplicate transaction reference where configured
- Same receipt posted twice

---

# 32. Receipt Reversal

A posted receipt cannot be deleted.

Create:

```ts
reverseReceipt(...)
```

Reversal must:

- Require a reason
- Create an exact reversing journal entry
- Reverse receipt allocations
- Recalculate invoice balances
- Recalculate invoice statuses
- Recalculate customer balances
- Mark receipt as reversed
- Preserve original receipt number
- Preserve original journal
- Link the reversal journal

Example original:

```text
Dr Bank
    Cr Trade receivables
```

Reversal:

```text
Dr Trade receivables
    Cr Bank
```

If bank fees or withholding tax were posted, reverse those exact lines too.

Do not manually reconstruct an approximate reversal.

Use the original journal lines.

---

# 33. Void Rules

Use `void` only for unposted documents or according to the application’s current document policy.

Recommended:

- Draft receipts may be deleted or voided
- Approved but unposted receipts may be voided
- Posted receipts must be reversed, not merely voided

Do not hide the audit trail.

---

# 34. Refund to Customer

A customer refund is not a receipt.

Do not model outgoing refunds inside the receipt journal.

Use the existing payment/refund workflow.

If a receipt was overpaid:

- Leave as customer credit
- Apply to another invoice
- Refund using a separate payment transaction

Receipt detail should link to the refund transaction where applicable.

---

# 35. Bank Reconciliation

Posted receipts must appear in bank reconciliation.

Expose:

- Receipt number
- Receipt date
- Value date
- Bank account
- Amount
- Transaction reference
- Cleared status
- Reconciliation ID

Do not mark receipts cleared merely because they are posted.

Clearing belongs to bank reconciliation.

Cheque receipts may require later clearance status.

---

# 36. Cash Flow Classification

Receipts must flow into the Cash Flow Statement through journal analysis.

Suggested classifications:

Customer receipt:

```text
Operating cash inflow
```

Miscellaneous operating income:

```text
Operating cash inflow
```

Owner contribution:

```text
Financing cash inflow
```

Loan proceeds:

```text
Financing cash inflow
```

Interest received:

```text
Operating or investing according to configured policy
```

Supplier refund:

```text
Operating or investing depending on original nature
```

Use chart-of-account and receipt-type metadata.

Do not hardcode all receipts as operating.

---

# 37. Dashboard Integration

Add receipt-related dashboard metrics where appropriate:

- Receipts today
- Receipts this month
- Unapplied customer receipts
- Customer advances
- Outstanding invoices
- Cash collected
- Bank collected
- Average collection period

Avoid double counting receipt amounts that have multiple invoice allocations.

---

# 38. Search and Drill-Down

Receipt lines should link to:

- Customer
- Invoice
- General Journal
- General Ledger
- Bank account
- Receipt detail
- Related reversal
- Related refund

General Ledger drill-down should show receipt metadata.

Invoice drill-down should show receipt allocations.

---

# 39. Permissions

Suggested permissions:

- View receipts
- Create receipts
- Edit draft receipts
- Approve receipts
- Post receipts
- Allocate receipts
- Reverse receipts
- Manage receipt templates
- View bank details
- Record customer advances
- Record miscellaneous receipts

---

# 40. Audit Trail

Record:

- Receipt created
- Customer selected
- Invoice selected
- Amount changed
- Method changed
- Bank account changed
- Allocation added
- Allocation removed
- Auto-allocation used
- Receipt approved
- Receipt posted
- Journal created
- Receipt printed
- Receipt downloaded
- Unapplied amount allocated
- Receipt reversed
- Replacement created
- Bank reconciliation linked

---

# 41. Recommended Files

Adapt to actual project conventions.

```text
src/
  types/
    receipt.ts

  store/
    receiptStore.ts

  lib/
    receiptCalculations.ts
    receiptValidation.ts
    receiptNumbering.ts
    receiptPosting.ts
    receiptAllocations.ts
    receiptTemplate.ts
    amountToWords.ts

  components/
    receipts/
      ReceiptList.tsx
      ReceiptEditor.tsx
      ReceiptDrawer.tsx
      ReceiptRenderer.tsx
      ReceiptPreview.tsx
      ReceiptAllocationTable.tsx
      ReceiptSummary.tsx
      ReceiptMethodFields.tsx
      ReceiptApplyDialog.tsx
      ReceiptReverseDialog.tsx

  pages/
    ReceiptsPage.tsx
    ReceiptDetailsPage.tsx
```

Reuse existing generic components:

- EntityPicker
- CustomerPicker
- AccountPicker
- DatePicker
- Currency selector
- Invoice selector
- Journal viewer
- Print/PDF renderer
- Template editor components

Keep business logic outside React components.

---

# 42. Reusable Functions

Create centralized functions such as:

```ts
calculateReceiptTotals(...)
calculateReceiptUnappliedAmount(...)
getEligibleInvoicesForReceipt(...)
autoAllocateReceipt(...)
validateReceiptDraft(...)
validateReceiptForPosting(...)
generateReceiptNumber(...)
buildReceiptJournalEntry(...)
postReceipt(...)
applyReceiptToInvoices(...)
unapplyReceiptAllocation(...)
reverseReceipt(...)
resolveReceiptTemplate(...)
createReceiptTemplateSnapshot(...)
calculateInvoiceBalanceAfterReceipt(...)
calculateCustomerUnappliedReceipts(...)
amountToWords(...)
```

---

# 43. Persistence

Use Zustand and LocalStorage consistently.

Persist:

- Receipts
- Allocations
- Numbering configuration
- Journal links
- Template snapshots
- Reversal links
- Cheque details
- Bank references
- Audit metadata

Ensure browser refresh preserves:

- Draft editor data
- Posted receipts
- Allocations
- Unapplied amounts
- Receipt statuses
- Routes
- Filters where current application persists filters

Do not store temporary object URLs for logos.

---

# 44. Tests

Add tests for:

1. Draft receipt does not affect accounting
2. Posted customer receipt creates balanced journal
3. Bank debit is correct
4. Trade receivables credit is correct
5. Cash receipt posts to cash account
6. Full invoice payment marks invoice paid
7. Partial payment marks invoice partially paid
8. Multi-invoice allocation works
9. Allocation cannot exceed receipt amount
10. Allocation cannot exceed invoice balance
11. Overpayment remains unapplied
12. Customer advance posts to advance liability
13. Unapplied receipt persists
14. Later application does not duplicate bank posting
15. Miscellaneous receipt requires credit account
16. Owner contribution posts to equity
17. Loan proceeds post to liability
18. Bank fee posting is balanced
19. Withholding-tax posting is balanced
20. Currency conversion is correct
21. Posted receipt has frozen template snapshot
22. Receipt number is unique per entity
23. Posted receipt cannot be materially edited
24. Reversal creates exact opposite journal
25. Reversal restores invoice balance
26. Reversal restores invoice status
27. Reversal removes allocations
28. Customer statement includes receipt
29. Bank reconciliation includes posted receipt
30. Draft and void invoices cannot receive allocations
31. Customer/entity mismatch is blocked
32. Currency mismatch is blocked unless FX supported
33. LocalStorage hydration preserves receipts
34. Empty dataset renders safely
35. Mobile-width editor works
36. Print preview works
37. Amount in words renders correctly
38. Arabic receipt layout renders correctly where supported
39. Cash Flow classification is correct
40. No receipt amount is double counted across allocations

---

# 45. Acceptance Scenario 1 — Full Invoice Receipt

Invoice:

```text
Invoice number: INV-2026-0001
Customer: Customer A
Invoice total: 1,160.00
Credits: 0.00
Payments: 0.00
Balance due: 1,160.00
```

Receipt:

```text
Receipt number: RCT-2026-0001
Date: 15 July 2026
Method: Bank transfer
Bank account: Bank current account
Amount: 1,160.00
Reference: TRX-10001
Allocation: INV-2026-0001 — 1,160.00
```

Expected journal:

```text
Dr Bank current account          1,160.00
    Cr Trade receivables                  1,160.00
```

Expected results:

- Receipt posted
- Journal balanced
- Invoice balance becomes 0.00
- Invoice status becomes paid
- Receipt appears on invoice
- Receipt appears on customer statement
- Receipt appears in bank ledger
- Receipt appears in operating cash flow
- Receipt printable as an official receipt

---

# 46. Acceptance Scenario 2 — Partial Receipt

Invoice balance:

```text
1,160.00
```

Receipt:

```text
500.00
```

Expected:

```text
Invoice status: Partially paid
Amount paid: 500.00
Balance due: 660.00
```

Journal:

```text
Dr Bank                          500.00
    Cr Trade receivables                  500.00
```

---

# 47. Acceptance Scenario 3 — Multiple Invoices

Receipt:

```text
5,000.00
```

Allocations:

```text
INV-001: 2,000.00
INV-002: 1,500.00
INV-003: 1,500.00
```

Expected:

- Total allocated = 5,000.00
- Unapplied = 0.00
- INV-001 paid
- INV-002 paid
- INV-003 partially paid
- One balanced receipt journal entry
- Three subledger allocation records

---

# 48. Acceptance Scenario 4 — Customer Advance

Receipt:

```text
Receipt number: RCT-2026-0004
Customer: Customer B
Amount: 10,000.00
Type: Customer advance
Allocation: none
```

Journal:

```text
Dr Bank                         10,000.00
    Cr Customer advances                10,000.00
```

Expected:

- Receipt posted
- Unapplied amount = 10,000.00
- Customer advance shown on customer account
- No invoice marked paid
- Available for later application

---

# 49. Acceptance Scenario 5 — Bank Fee

Customer settles:

```text
1,000.00
```

Bank deposits:

```text
990.00
```

Fee:

```text
10.00
```

Journal:

```text
Dr Bank                          990.00
Dr Bank fees expense              10.00
    Cr Trade receivables                1,000.00
```

Expected:

- Invoice settled by 1,000.00
- Bank ledger increases by 990.00
- Bank fees expense = 10.00
- Journal balanced
- Receipt document shows gross amount received and fee treatment only if configured for internal display

---

# 50. QA Requirements

Run:

- TypeScript typecheck
- Unit tests
- Production build
- New receipt smoke test
- Full invoice receipt test
- Partial receipt test
- Multi-invoice allocation test
- Overpayment test
- Customer advance test
- Unapplied receipt test
- Later allocation test
- Miscellaneous receipt test
- Bank fee test
- Withholding-tax test
- Reversal test
- Customer statement test
- General Ledger drill-down test
- Cash Flow classification test
- LocalStorage refresh test
- Print preview test
- Mobile-width test
- Arabic/RTL test where supported

Report exactly:

- Files created
- Files modified
- Receipt types implemented
- Posting accounts used
- Numbering logic used
- Allocation logic used
- Template logic used
- Acceptance-scenario results
- Journal results
- Invoice balance results
- Customer statement result
- Cash Flow classification result
- Test results
- Typecheck result
- Production build result
- Intentionally deferred items

---

# 51. Core Accounting Rules

Customer receipt:

```text
Dr Bank / Cash
    Cr Trade receivables
```

Customer advance:

```text
Dr Bank / Cash
    Cr Customer advances
```

Miscellaneous receipt:

```text
Dr Bank / Cash
    Cr Income / selected account
```

Owner contribution:

```text
Dr Bank / Cash
    Cr Equity
```

Loan proceeds:

```text
Dr Bank / Cash
    Cr Borrowing liability
```

The receipt must be a separate accounting document with:

- Its own number
- Its own status
- Its own journal entry
- Its own allocations
- Its own printable document
- Its own template snapshot
- Its own audit history

The original invoice remains unchanged except for:

- Amount paid
- Balance due
- Payment status
- Linked receipt allocations
