# Payments Module Specification

## Objective

Build a production-quality Payments module for outgoing money in the existing React + TypeScript IFRS bookkeeping application.

Reuse the existing:

- Suppliers
- Bills
- Supplier credits
- Customers
- Invoices
- Credit notes
- Receipts
- General Journal
- General Ledger
- Chart of Accounts
- Bank and cash accounts
- EntityPicker, SupplierPicker, CustomerPicker, AccountPicker
- Zustand and LocalStorage persistence
- Zod validation
- Existing print/PDF infrastructure
- Ledgerly ERP design system

Do not create a separate accounting engine, AP engine, bank ledger, or duplicate supplier-balance store.

---

## 1. Core payment types

Support:

```ts
export type PaymentType =
  | "supplier-payment"
  | "supplier-advance"
  | "unapplied-supplier-payment"
  | "expense-payment"
  | "tax-payment"
  | "payroll-payment"
  | "loan-repayment"
  | "lease-payment"
  | "owner-drawing"
  | "dividend-payment"
  | "customer-refund"
  | "credit-note-refund"
  | "other"
```

Primary workflow:

```text
Supplier / Bill
→ Record Payment
→ Select bank or cash account
→ Allocate payment
→ Validate fees, withholding, discount, and FX
→ Post journal entry
→ Update bill balances
→ Generate payment voucher
```

---

## 2. Navigation

Under Purchases:

```text
Purchases
- Suppliers
- Bills
- Supplier Credits
- Payments Made
```

Optional Banking shortcut:

```text
Banking
- Receipts
- Payments
- Reconciliation
```

Routes:

```text
/purchases/payments
/purchases/payments/new
/purchases/payments/:paymentId
/purchases/payments/:paymentId/edit
```

Add actions:

- Bill → `Record Payment`
- Supplier → `Make Payment`
- Credit note → `Refund Customer`
- Dashboard → `New Payment`

---

## 3. Status workflow

```ts
export type PaymentStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "posted"
  | "partially-allocated"
  | "fully-allocated"
  | "reversed"
  | "void"
```

Recommended flow:

```text
Draft
→ Submitted
→ Approved
→ Posted
→ Partially allocated / Fully allocated
```

Posted payments cannot be materially edited.

For correction:

```text
Reverse payment
→ Create replacement payment
```

---

## 4. Payment methods

```ts
export type PaymentMethod =
  | "bank-transfer"
  | "cash"
  | "cheque"
  | "card"
  | "online-transfer"
  | "direct-debit"
  | "other"
```

Conditional requirements:

- Bank transfer: bank account, transfer reference
- Cash: cash account
- Cheque: cheque number, date, payee, bank account
- Card: card/bank account, card reference
- Direct debit: bank account, mandate/reference
- Other: explanation

---

## 5. Payment model

Create `src/types/payment.ts`.

```ts
export type Payment = {
  id: string
  entityId: string

  paymentNumber: string
  paymentType: PaymentType
  status: PaymentStatus

  supplierId?: string
  customerId?: string
  employeeId?: string
  taxAuthorityId?: string

  paymentDate: string
  valueDate?: string

  currency: string
  exchangeRate: number

  grossAmount: number
  bankFeeAmount: number
  withholdingTaxAmount: number
  discountTakenAmount: number
  netCashAmount: number
  baseCurrencyAmount: number

  method: PaymentMethod

  bankAccountId?: string
  cashAccountId?: string
  chequeClearingAccountId?: string
  cardSettlementAccountId?: string

  chequeNumber?: string
  chequeDate?: string
  chequeBankName?: string

  transactionReference?: string
  transferReference?: string
  cardReference?: string
  directDebitReference?: string

  payeeName?: string
  payeeAccountName?: string
  payeeBankName?: string

  narration?: string
  notes?: string
  internalMemo?: string

  allocationTotal: number
  unappliedAmount: number

  journalEntryId?: string
  reversalJournalEntryId?: string

  templateId?: string
  templateVersionId?: string
  templateSnapshot?: PaymentTemplateSnapshot

  submittedAt?: string
  approvedAt?: string
  postedAt?: string
  reversedAt?: string
  voidedAt?: string

  approvedBy?: string
  reversalReason?: string
  voidReason?: string

  createdAt: string
  updatedAt: string
}
```

---

## 6. Allocation model

```ts
export type PaymentAllocation = {
  id: string
  entityId: string
  paymentId: string

  supplierId?: string
  customerId?: string

  billId?: string
  supplierCreditId?: string
  invoiceId?: string
  creditNoteId?: string

  allocationType:
    | "bill"
    | "supplier-advance"
    | "supplier-credit"
    | "customer-refund"
    | "other"

  amount: number
  baseCurrencyAmount: number
  allocationDate: string

  createdAt: string
  updatedAt: string
}
```

Rules:

```text
Allocation total ≤ Payment gross amount
Unapplied amount = Gross amount − Allocation total
```

Block allocation above:

- Payment amount
- Bill balance
- Refundable credit
- Supplier/customer-compatible balance
- Currency-compatible amount unless FX settlement exists

---

## 7. Supplier payment workflow

From a bill, prefill:

- Entity
- Supplier
- Bill
- Bill currency
- Outstanding balance
- Due date
- Payment amount equal to balance
- Payment date
- Suggested bank account
- Suggested method

From supplier profile, show open bills:

- Bill number
- Supplier invoice number
- Bill date
- Due date
- Original total
- Supplier credits
- Previous payments
- Outstanding
- Amount to allocate

Actions:

- Auto-allocate oldest first
- Auto-allocate by due date
- Allocate selected only
- Clear allocations

Default: oldest due first.

---

## 8. Partial and full payments

Partial example:

```text
Bill total: 1,160.00
Payment: 500.00
Balance due: 660.00
Status: Partially paid
```

Full example:

```text
Balance due: 660.00
Payment: 660.00
Balance due: 0.00
Status: Paid
```

Do not change the original bill total.

---

## 9. Multiple-bill payment

One payment may settle multiple bills.

Example:

```text
Payment: 5,000.00

BILL-001: 2,000.00
BILL-002: 1,500.00
BILL-003: 1,500.00
```

Expected:

- One payment journal entry
- Three allocation records
- Independent bill status updates
- No double counting

---

## 10. Overpayment and supplier advance

If payment exceeds selected bill balances, offer:

1. Leave as supplier advance
2. Allocate to another bill
3. Reduce payment amount
4. Leave unapplied

Supplier advance posting:

```text
Dr Supplier advances / Prepayments
    Cr Bank / Cash
```

When applied later:

```text
Dr Trade payables
    Cr Supplier advances / Prepayments
```

Do not recognize expense merely because an advance was paid.

---

## 11. Unapplied payments

Show:

```text
Payment amount
Allocated amount
Unapplied amount
```

Add action:

```text
Apply Payment
```

Eligible bills must match:

- Entity
- Supplier
- Currency unless FX allocation exists
- Posted and open status

Applying a posted payment later must not create a second bank payment journal.

---

## 12. Numbering

Entity-specific numbering:

```text
PAY-2026-0001
```

Create:

```ts
generatePaymentNumber(...)
```

Support:

- Prefix
- Include year
- Sequence length
- Annual reset
- Separate sequence by entity

Do not reuse posted, reversed, or voided numbers.

---

## 13. Posting rules

Draft payments do not affect accounting.

Post through the existing General Journal service.

### Supplier payment

```text
Dr Trade payables
    Cr Bank / Cash
```

### Supplier advance

```text
Dr Supplier advances
    Cr Bank / Cash
```

### Expense payment

```text
Dr Expense
    Cr Bank / Cash
```

### Tax payment

```text
Dr Tax payable
    Cr Bank
```

### Payroll payment

```text
Dr Payroll payable
    Cr Bank
```

### Loan repayment

```text
Dr Loan liability
Dr Interest expense
    Cr Bank
```

### Lease payment

```text
Dr Lease liability
Dr Finance cost
    Cr Bank
```

### Owner drawing or dividend

```text
Dr Drawings / Dividends payable / Equity
    Cr Bank
```

### Customer refund

```text
Dr Customer credit / Trade receivables
    Cr Bank
```

Store `journalEntryId` on the payment.

---

## 14. Posting metadata

Journal metadata must include:

- Payment number
- Payment type
- Supplier/customer/payee
- Bill or credit-note references
- Payment date
- Bank/cash account
- Transaction reference
- Payment ID
- Entity
- Currency
- Exchange rate
- Allocation summary
- Clear memo

Create:

```ts
buildPaymentJournalEntry(...)
postPayment(...)
```

---

## 15. Bank fees

Example:

```text
Supplier liability settled: 1,000.00
Bank fee: 10.00
Bank withdrawal: 1,010.00
```

Journal:

```text
Dr Trade payables            1,000.00
Dr Bank fees expense            10.00
    Cr Bank                         1,010.00
```

Bank fee must not increase bill settlement.

---

## 16. Withholding tax

Example:

```text
Bill liability: 1,000.00
Cash paid: 950.00
Withholding: 50.00
```

Payment-stage journal:

```text
Dr Trade payables            1,000.00
    Cr Bank                         950.00
    Cr Withholding tax payable       50.00
```

Use centralized policy:

```ts
type WithholdingRecognition =
  | "bill-posting"
  | "payment"
```

Do not recognize withholding twice.

---

## 17. Discounts taken

Example:

```text
Bill balance: 1,000.00
Cash paid: 980.00
Discount: 20.00
```

Journal:

```text
Dr Trade payables            1,000.00
    Cr Bank                         980.00
    Cr Purchase discounts           20.00
```

Or reduce expense according to configured policy.

Do not silently reduce bill balance without a visible discount and journal line.

---

## 18. Multi-currency and realized FX

Fields:

- Payment currency
- Exchange rate
- Foreign amount
- Base amount

Use the historical bill rate and payment rate.

When rates differ:

```text
Dr Trade payables
Dr/Cr Realized FX gain or loss
    Cr Bank
```

Use configured FX accounts.

Do not revalue historical bills using current exchange rates.

---

## 19. Loan repayment split

Require:

- Loan account
- Principal
- Interest
- Fees
- Reference

Validation:

```text
Principal + Interest + Fees = Net cash payment
```

Journal:

```text
Dr Loan liability       principal
Dr Interest expense     interest
Dr Bank fees expense    fees
    Cr Bank             total
```

---

## 20. Lease payment split

Where lease accounting exists, support:

- Lease principal
- Finance cost
- Service component
- Tax
- Other fees

Use actual lease schedule data.

Do not fabricate lease schedules in the payment module.

---

## 21. Tax payments

Support:

- VAT payable
- Income tax payable
- Payroll tax payable
- Withholding tax payable
- Other statutory liabilities

Require:

- Tax authority
- Tax period
- Tax account
- Filing/reference number
- Payment reference

Journal:

```text
Dr Tax payable
    Cr Bank
```

---

## 22. Payroll payments

Require:

- Payroll period
- Payroll payable account
- Bank account
- Reference

Journal:

```text
Dr Payroll payable
    Cr Bank
```

Do not recognize salary expense again if payroll posting already did.

---

## 23. Customer refunds

Link to:

- Customer
- Credit note
- Original invoice where relevant
- Refund reason

Journal:

```text
Dr Customer credit / Trade receivables
    Cr Bank
```

Do not reverse the original credit note journal merely to record the refund.

---

## 24. Payment voucher

Provide a printable document titled:

```text
Payment Voucher
```

Include:

- Company logo and legal information
- Payment number/date
- Payee
- Amount
- Amount in words
- Currency
- Method
- Bank/cash account
- Cheque details
- Reference
- Bill allocations
- Bank fee
- Withholding tax
- Discount taken
- Narration
- Prepared by
- Approved by
- Authorized signature
- Footer
- Page number

---

## 25. Payment templates

Provide a system default voucher template.

Allow:

- Logo
- Colors
- Font
- Title
- Labels
- Signature areas
- Allocation columns
- Footer
- Language
- LTR/RTL

Resolution priority:

1. Payment-specific template
2. Supplier/payee preference where supported
3. Entity default
4. System default

Freeze the template snapshot when posted.

---

## 26. Editor UI

Header:

- Entity
- Payment type
- Payment number
- Payment date/value date
- Supplier/customer/payee
- Currency/exchange rate
- Gross amount
- Method
- Bank/cash account
- Reference

Conditional fields:

- Cheque details
- Card reference
- Direct-debit reference
- Tax authority
- Loan account
- Lease account
- Payroll period
- Withholding tax
- Bank fees
- Discount taken

Allocation section:

- Open bills
- Original total
- Credits
- Payments
- Outstanding
- Allocation amount
- Remaining payment

Summary:

```text
Gross payment
Allocated
Unapplied
Bank fee
Withholding tax
Discount taken
Net cash outflow
```

Actions:

- Save draft
- Submit
- Approve
- Preview
- Post payment
- Cancel

---

## 27. Payment list

Columns:

- Payment number
- Date
- Payee
- Type
- Method
- Currency
- Gross amount
- Net cash
- Allocated
- Unapplied
- Status
- Journal status
- Bank/cash account
- Reference

Filters:

- Entity
- Date range
- Supplier
- Customer
- Type
- Method
- Status
- Bank account
- Cash account
- Currency
- Fully allocated
- Partially allocated
- Unapplied only
- Reversed only
- Approval status

Actions:

- View
- Edit draft
- Preview
- Print
- Download PDF
- Apply payment
- Duplicate
- Reverse
- Void draft

---

## 28. Validation

Create:

```ts
validatePaymentDraft(...)
validatePaymentForPosting(...)
```

Posting requires:

- Entity
- Unique payment number
- Payment date
- Payment type
- Positive amount
- Currency
- Valid exchange rate
- Method
- Valid bank/cash account
- Valid debit account or AP mapping
- Supplier/customer/payee where required
- Allocation total not above payment
- Bill allocation not above bill balance
- Entity and party compatibility
- Currency compatibility
- Balanced journal
- Valid fee/withholding/discount accounts
- Approval where required

Block:

- Negative or zero amount
- Header/non-posting accounts
- Duplicate posting
- Draft/void bill allocation
- Over-allocation
- Missing required references

---

## 29. Reversal

Create:

```ts
reversePayment(...)
```

A posted payment reversal must:

- Require reason
- Create exact opposite journal
- Reverse allocations
- Recalculate bill balances and statuses
- Recalculate supplier/customer balances
- Mark payment reversed
- Preserve original payment and journal
- Link reversal journal

Use the exact original journal lines.

---

## 30. Bill integration

On bill details show:

```text
Original bill total
Less supplier credits
Less payments
Balance due
```

Add Payments table:

- Payment number
- Date
- Method
- Amount allocated
- Status
- Reference
- View

Add `Record Payment`.

---

## 31. Supplier statement integration

Payments reduce supplier payable balances.

Show:

- Payment number
- Date
- Method
- Reference
- Amount
- Allocation details
- Unapplied advance

Do not double count payment and allocation rows.

---

## 32. Bank reconciliation

Posted payments must appear in bank reconciliation with:

- Payment number
- Date
- Value date
- Bank account
- Amount
- Reference
- Cleared status
- Reconciliation ID

Posting does not automatically mean cleared.

---

## 33. Cash Flow classification

Examples:

- Operating supplier payment → Operating outflow
- Asset bill payment → Investing outflow
- Loan principal → Financing outflow
- Interest → Operating or financing by policy
- Dividend/drawing → Financing outflow
- Tax payment → Operating outflow

Use payment type, source bill metadata, and counterpart accounts.

Do not classify every payment as operating.

---

## 34. AccountPicker behavior

Reuse the corrected picker:

- Portal to `document.body`
- Collision-aware flip
- Internal scrolling
- Search input remains visible
- Correct account IDs
- Non-posting accounts disabled
- High z-index
- Keyboard navigation

Apply to all payment account fields.

---

## 35. Recommended files

```text
src/
  types/
    payment.ts

  store/
    paymentStore.ts

  lib/
    paymentCalculations.ts
    paymentValidation.ts
    paymentNumbering.ts
    paymentPosting.ts
    paymentAllocations.ts
    paymentSettlement.ts
    paymentTemplate.ts
    paymentReversal.ts

  components/
    payments/
      PaymentList.tsx
      PaymentEditor.tsx
      PaymentDrawer.tsx
      PaymentAllocationTable.tsx
      PaymentMethodFields.tsx
      PaymentSummary.tsx
      PaymentRenderer.tsx
      PaymentPreview.tsx
      PaymentApplyDialog.tsx
      PaymentReverseDialog.tsx
      PaymentApprovalPanel.tsx

  pages/
    PaymentsPage.tsx
    PaymentDetailsPage.tsx
```

Keep business logic outside React components.

---

## 36. Core functions

```ts
calculatePaymentTotals(...)
calculatePaymentUnappliedAmount(...)
getEligibleBillsForPayment(...)
autoAllocatePayment(...)
validatePaymentDraft(...)
validatePaymentForPosting(...)
generatePaymentNumber(...)
buildPaymentJournalEntry(...)
postPayment(...)
applyPaymentToBills(...)
unapplyPaymentAllocation(...)
reversePayment(...)
resolvePaymentTemplate(...)
createPaymentTemplateSnapshot(...)
calculateBillBalanceAfterPayment(...)
derivePaymentStatus(...)
```

---

## 37. Persistence

Persist with Zustand and LocalStorage:

- Payments
- Allocations
- Numbering
- Journal links
- Templates
- Approval metadata
- Reversal links
- References
- Audit data

Ensure browser refresh preserves drafts, posted payments, allocations, statuses, routes, and filters.

---

## 38. Acceptance scenarios

### Full bill payment

```text
Bill balance: 1,160.00
Payment: 1,160.00
```

Journal:

```text
Dr Trade payables      1,160.00
    Cr Bank                  1,160.00
```

Expected:

- Bill paid
- Balance 0.00
- Supplier statement updated
- Bank ledger updated

### Partial payment

```text
Payment: 500.00
Balance due: 660.00
Status: Partially paid
```

### Supplier advance

```text
Dr Supplier advances   10,000.00
    Cr Bank                  10,000.00
```

No expense recognized.

### Bank fee

```text
Dr Trade payables       1,000.00
Dr Bank fees               10.00
    Cr Bank                  1,010.00
```

### Withholding

```text
Dr Trade payables       1,000.00
    Cr Bank                    950.00
    Cr Withholding payable      50.00
```

---

## 39. Tests

Add tests for:

1. Draft payment does not post
2. Supplier payment journal balanced
3. AP debit correct
4. Bank/cash credit correct
5. Full payment marks bill paid
6. Partial payment works
7. Multi-bill allocation works
8. Over-allocation blocked
9. Supplier advance does not create expense
10. Later allocation does not duplicate bank posting
11. Expense payment requires debit account
12. Tax payment posts correctly
13. Payroll payment posts correctly
14. Loan split correct
15. Lease split correct where supported
16. Customer refund correct
17. Bank fee balanced
18. Withholding balanced
19. Discount balanced
20. FX gain/loss correct where supported
21. Posted template frozen
22. Number unique per entity
23. Posted payment not directly editable
24. Reversal exact opposite
25. Reversal restores bill balance/status
26. Allocations reversed
27. Supplier statement updated
28. Bank reconciliation includes payment
29. Cash Flow classification correct
30. Draft/void bills blocked
31. Entity/party mismatch blocked
32. Currency mismatch blocked unless supported
33. LocalStorage hydration works
34. Empty state safe
35. Mobile editor works
36. Print preview works
37. Amount in words correct
38. RTL works where supported
39. No allocation double counting
40. Route refresh works

---

## 40. QA

Run:

- TypeScript typecheck
- Unit tests
- Production build
- Full payment test
- Partial payment test
- Multi-bill allocation test
- Supplier advance test
- Bank fee test
- Withholding test
- FX test
- Reversal test
- Supplier statement test
- General Ledger drill-down test
- Cash Flow test
- LocalStorage refresh test
- Print/PDF test
- Mobile test
- RTL test
- Route refresh test

Report:

- Files created
- Files modified
- Payment types implemented
- Posting accounts used
- Numbering logic
- Allocation logic
- Fee/withholding/discount logic
- FX logic
- Template logic
- Acceptance-scenario results
- Journal results
- Bill balance results
- Supplier statement result
- Cash Flow classification
- Tests
- Typecheck
- Production build
- Deferred items

---

## Core accounting rules

Supplier payment:

```text
Dr Trade payables
    Cr Bank / Cash
```

Supplier advance:

```text
Dr Supplier advances
    Cr Bank / Cash
```

Expense payment:

```text
Dr Expense
    Cr Bank / Cash
```

Loan repayment:

```text
Dr Loan liability
Dr Interest expense
    Cr Bank
```

Customer refund:

```text
Dr Customer credit / Trade receivables
    Cr Bank
```

The payment must remain a separate accounting document with its own number, status, journal entry, allocations, voucher, template snapshot, approvals, and audit trail.

The original bill or invoice total must never be silently changed because of later payments.
