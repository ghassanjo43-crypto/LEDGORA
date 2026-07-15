# Bills Module Specification

## Objective

Build a production-quality **Bills module** for supplier invoices and accounts payable in the existing React + TypeScript IFRS bookkeeping application.

Reuse the existing:

- Suppliers
- General Journal and General Ledger
- Chart of Accounts
- Tax codes
- Entity selector
- AccountPicker and SupplierPicker
- Zustand and LocalStorage persistence
- Zod validation
- Print/PDF utilities
- Ledgerly ERP design system
- Existing invoice numbering, calculation, validation, posting, rendering, and audit patterns

Do not create a second accounting engine or write directly to General Ledger balances.

---

## 1. Core Purpose

The Bills module records amounts owed to suppliers.

Support:

1. Supplier bills for goods
2. Supplier bills for services
3. Expense bills
4. Asset-purchase bills
5. Inventory-purchase bills where inventory exists
6. Input VAT / recoverable tax
7. Withholding tax where configured
8. Discounts and additional charges
9. Foreign-currency bills
10. Partial and full payment
11. Multiple payments against one bill
12. One payment allocated across multiple bills
13. Supplier advances
14. Supplier credits
15. Bill reversal
16. Attachments
17. Approval workflow
18. Purchase-order matching where available

Primary workflow:

```text
Supplier
→ New Bill
→ Enter supplier invoice details
→ Select expense / asset / inventory accounts
→ Validate tax
→ Approve
→ Post to Accounts Payable
→ Record payment
```

---

## 2. Navigation

Under Purchases add:

```text
Purchases
- Suppliers
- Bills
- Supplier Credits
- Payments Made
- Purchase Orders
- Expenses
```

Only show Purchase Orders if that module exists.

Routes:

```text
/purchases/bills
/purchases/bills/new
/purchases/bills/:billId
/purchases/bills/:billId/edit
```

From a supplier profile add:

```text
New Bill
```

From a posted bill add:

```text
Record Payment
Create Supplier Credit
```

---

## 3. Bill Status

```ts
export type BillStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "posted"
  | "partially-paid"
  | "paid"
  | "overdue"
  | "void"
  | "reversed"
```

Recommended workflow:

```text
Draft → Submitted → Approved → Posted → Partially paid → Paid
```

`Overdue` should normally be derived:

```text
dueDate < today
and balanceDue > tolerance
and bill is not paid, void, or reversed
```

A posted bill must not be materially edited.

For corrections:

- Create supplier credit
- Reverse and recreate
- Void only before posting

---

## 4. Bill Types

```ts
export type BillType =
  | "goods"
  | "services"
  | "expense"
  | "asset-purchase"
  | "inventory-purchase"
  | "other"
```

Bill type may suggest accounts but must not override explicit user selection.

Do not classify bills by description text alone.

---

## 5. Bill Model

Create `src/types/bill.ts`.

```ts
export type Bill = {
  id: string
  entityId: string
  supplierId: string

  billNumber: string
  supplierInvoiceNumber: string

  billType: BillType
  status: BillStatus

  billDate: string
  postingDate?: string
  dueDate: string
  paymentTerms?: string

  currency: string
  exchangeRate: number

  purchaseOrderId?: string
  goodsReceiptId?: string
  supplierReference?: string
  internalReference?: string

  projectId?: string
  costCenterId?: string
  departmentId?: string

  subtotal: number
  discountTotal: number
  taxTotal: number
  withholdingTaxTotal: number
  additionalChargesTotal: number
  grandTotal: number

  amountPaid: number
  supplierCreditsApplied: number
  balanceDue: number

  accountsPayableAccountId: string
  journalEntryId?: string
  reversalJournalEntryId?: string

  attachmentIds?: string[]

  notes?: string
  terms?: string
  internalMemo?: string

  approvedAt?: string
  postedAt?: string
  paidAt?: string
  voidedAt?: string
  reversedAt?: string

  approvedBy?: string
  voidReason?: string
  reversalReason?: string

  createdAt: string
  updatedAt: string
}
```

---

## 6. Bill Line Model

```ts
export type BillLine = {
  id: string
  billId: string

  itemId?: string
  description: string
  accountId: string

  quantity: number
  unit?: string
  unitPrice: number

  discountType?: "percentage" | "amount"
  discountValue?: number
  discountAmount: number

  taxCodeId?: string
  taxRate: number
  taxableAmount: number
  taxAmount: number

  withholdingTaxCodeId?: string
  withholdingTaxRate?: number
  withholdingTaxAmount?: number

  lineSubtotal: number
  lineTotal: number

  projectId?: string
  costCenterId?: string
  departmentId?: string

  inventoryItemId?: string
  inventoryLocationId?: string
  capitalAssetId?: string

  sortOrder: number
}
```

Each active line must use a valid posting account.

---

## 7. Internal and Supplier Numbers

Capture separately:

```text
Internal bill number: BILL-2026-0001
Supplier invoice number: SUP-INV-8842
```

Duplicate control:

- Block duplicate supplier invoice number for the same supplier and entity
- Warn if the same number exists for another supplier
- Permit override only with permission and explanation

Create:

```ts
checkDuplicateSupplierInvoiceNumber(...)
```

Internal numbering:

```text
BILL-2026-0001
```

Configuration:

- Prefix
- Include year
- Sequence length
- Next sequence
- Annual reset
- Separate sequence per entity

Create:

```ts
generateBillNumber(...)
```

Never reuse posted, voided, or reversed bill numbers.

---

## 8. Calculations

Reuse decimal-safe invoice utilities.

Per line:

```text
lineSubtotal = quantity × unitPrice
discountAmount = percentage or fixed discount
taxableAmount = lineSubtotal − discountAmount
taxAmount = taxableAmount × taxRate
lineTotal = taxableAmount + taxAmount
```

Bill totals:

```text
subtotal = sum(lineSubtotal)
discountTotal = sum(discountAmount)
taxTotal = sum(taxAmount)
withholdingTaxTotal = sum(withholdingTaxAmount)
grandTotal = subtotal − discountTotal + taxTotal + additionalChargesTotal
```

Do not use raw floating-point arithmetic without currency rounding.

---

## 9. Settlement Summary

Do not overwrite the original bill total.

```text
balanceDue = grandTotal − supplierCreditsApplied − paymentsApplied
```

Use actual payment allocations and supplier-credit applications.

```ts
export type BillSettlementSummary = {
  originalTotal: number
  supplierCreditsApplied: number
  paymentsApplied: number
  balanceDue: number
  status:
    | "outstanding"
    | "partially-paid"
    | "paid"
    | "partially-credited"
    | "fully-credited"
    | "settled"
}
```

Create:

```ts
buildBillSettlementSummary(...)
deriveBillStatus(...)
```

---

## 10. Tax Treatment

Support input VAT / recoverable tax.

Example:

```text
Expense: 1,000
Input VAT: 160
Total payable: 1,160
```

Journal:

```text
Dr Expense                         1,000
Dr Input VAT recoverable             160
    Cr Trade payables                    1,160
```

Validate:

- Tax code exists
- Input-tax account exists
- Tax rate is valid
- Tax calculation agrees within tolerance
- Supplier/entity is eligible for the selected treatment

Do not post tax to a generic account when tax-code mappings exist.

---

## 11. Withholding Tax

Centralize policy:

```ts
export type WithholdingTaxPolicy = {
  recognition: "bill-posting" | "payment"
  payableAccountId?: string
}
```

If recognized on bill posting:

```text
Dr Expense                         1,000
    Cr Trade payables                     950
    Cr Withholding tax payable              50
```

If recognized on payment, do not also recognize it on bill posting.

---

## 12. Accounts Payable Mapping

Resolution priority:

1. Supplier-specific payable account
2. Entity default trade-payables account
3. System default AP control account

Create:

```ts
resolveAccountsPayableAccount(...)
```

Do not hardcode account IDs inside React components.

---

## 13. Bill Posting

A draft bill must not affect accounting.

Post through the existing journal service.

Expense bill:

```text
Dr Expense account
Dr Input VAT recoverable
    Cr Trade payables
```

Asset bill:

```text
Dr Property, plant and equipment
Dr Input VAT recoverable
    Cr Trade payables
```

Inventory bill:

```text
Dr Inventory
Dr Input VAT recoverable
    Cr Trade payables
```

Store `journalEntryId` on the bill.

Journal metadata must include:

- Internal bill number
- Supplier invoice number
- Supplier ID
- Bill ID
- Purchase order
- Project
- Cost center
- Tax references
- Currency
- Exchange rate
- Memo

Create:

```ts
buildBillJournalEntry(...)
postBill(...)
```

Do not modify ledger balances directly.

---

## 14. Posting Aggregation

```ts
export type BillPostingPolicy = {
  aggregateSameAccounts: boolean
  separateTaxLines: boolean
  separateProjectLines: boolean
}
```

Do not aggregate across different:

- Projects
- Cost centers
- Tax codes requiring audit detail
- Assets
- Inventory items
- Currencies

---

## 15. Approval Workflow

Support:

```text
Draft → Submitted → Approved → Posted
```

Optional controls:

- Approval thresholds
- Role-based approval
- Rejection reason
- Return to draft
- Resubmission

If approval functionality does not exist, permit authorized direct posting.

---

## 16. Attachments

Support:

- Supplier PDF invoice
- Images
- Purchase order
- Delivery note
- Contract
- Tax invoice
- Other evidence

```ts
export type BillAttachment = {
  id: string
  billId: string
  fileName: string
  mimeType: string
  sizeBytes: number
  storageReference: string
  uploadedAt: string
}
```

Do not store temporary object URLs.

Use the project’s persistent asset mechanism.

---

## 17. Purchase Order Matching

Where purchase orders exist, support:

- 2-way match: PO vs Bill
- 3-way match: PO vs Goods Receipt vs Bill

Show:

- Quantity variance
- Price variance
- Tax variance
- Total variance

```ts
matchStatus?:
  | "not-required"
  | "matched"
  | "partially-matched"
  | "variance"
```

Do not block non-PO bills unless entity policy requires it.

---

## 18. Supplier Credits

Supplier credits reduce AP.

Typical posting:

```text
Dr Trade payables
    Cr Expense / Asset / Inventory
    Cr Input VAT recoverable
```

Supplier credits must:

- Have their own number and status
- Link to supplier
- Optionally link to original bill
- Apply to one or more bills
- Preserve original bill total

Do not use negative bill lines as a substitute.

---

## 19. Supplier Payments

From a posted bill add:

```text
Record Payment
```

Payment journal:

```text
Dr Trade payables
    Cr Bank / Cash
```

Support:

- Full payment
- Partial payment
- Multiple bills in one payment
- Multiple payments against one bill
- Bank fees
- Withholding tax
- Foreign exchange differences

---

## 20. Payment Allocation

```ts
export type BillPaymentAllocation = {
  id: string
  entityId: string
  supplierId: string
  paymentId: string
  billId: string
  amount: number
  baseCurrencyAmount: number
  allocationDate: string
  createdAt: string
}
```

Rules:

```text
Allocation ≤ Payment amount
Allocation ≤ Bill balance due
```

Do not double count payment totals and allocations.

---

## 21. Supplier Advances

Supplier prepayment:

```text
Dr Supplier advances / Prepayments
    Cr Bank
```

Application to bill:

```text
Dr Trade payables
    Cr Supplier advances / Prepayments
```

Do not recognize expense when paying an advance.

---

## 22. Multi-Currency

Store:

- Bill currency
- Exchange rate
- Base-currency amount

```text
Base amount = foreign amount × exchange rate
```

Use the rate stored at posting.

On payment, calculate realized FX gain/loss when required.

```text
Dr Trade payables
Dr/Cr Realized FX gain/loss
    Cr Bank
```

Use configured FX accounts.

---

## 23. Additional Charges

Support:

- Freight
- Customs
- Insurance
- Handling
- Other charges

Allow posting to:

- Expense
- Inventory capitalization
- Asset capitalization

Explicitly define whether each charge is taxable.

Do not hide charges inside totals without posting detail.

---

## 24. Bill Editor

Header fields:

- Entity
- Supplier
- Internal bill number
- Supplier invoice number
- Bill type
- Bill date
- Posting date
- Due date
- Payment terms
- Currency
- Exchange rate
- Purchase order
- Supplier reference
- Project
- Cost center

Line table:

- Item/service
- Description
- Account
- Quantity
- Unit
- Unit price
- Discount
- Tax
- Withholding tax
- Project
- Cost center
- Line total

Summary:

```text
Subtotal
Discount
Input tax
Additional charges
Withholding tax
Bill total
Amount paid
Supplier credits
Balance due
```

Actions:

- Save draft
- Submit
- Approve
- Post bill
- Preview
- Cancel

---

## 25. Bill List

Columns:

- Bill number
- Supplier invoice number
- Supplier
- Bill date
- Due date
- Currency
- Total
- Amount paid
- Credits applied
- Balance due
- Status
- Journal status
- Purchase order
- Attachments

Filters:

- Entity
- Supplier
- Status
- Date range
- Due date
- Currency
- Bill type
- Paid/unpaid
- Overdue only
- PO match status
- Has attachments
- Project
- Cost center

Actions:

- View
- Edit draft
- Duplicate
- Preview
- Print
- Record payment
- Create supplier credit
- Reverse
- Void draft

---

## 26. Bill Detail Page

Show:

- Supplier details
- Bill header
- Supplier invoice number
- Lines
- Tax summary
- Journal entry
- Payment history
- Supplier credits
- Settlement summary
- Attachments
- Approval history
- Audit trail

Posted bills must expose journal drill-down.

---

## 27. Bill Renderer

Provide a clean internal bill document.

Show:

- Entity
- Supplier
- Internal bill number
- Supplier invoice number
- Bill and due dates
- Currency
- Lines
- Tax
- Total
- Balance due
- PO
- Project/cost center
- Approval and posting status
- Journal reference

Do not pretend to recreate the supplier’s original invoice; display the original attachment separately.

---

## 28. Validation

Create:

```ts
validateBillDraft(...)
validateBillForPosting(...)
```

Posting requires:

- Entity
- Supplier
- Unique internal bill number
- Supplier invoice number
- Bill date
- Due date
- Currency
- Valid exchange rate
- At least one valid line
- Positive total
- Valid posting account per line
- Valid AP account
- Valid tax mapping
- Valid withholding mapping
- Balanced journal
- No duplicate supplier invoice
- Approval where required

Block:

- Zero bill
- Negative bill total
- Header accounts
- Draft/void supplier
- Duplicate posting
- Invalid currency
- Invalid tax

---

## 29. AccountPicker Requirements

Reuse the corrected picker:

- Portal to `document.body`
- Collision-aware positioning
- Flip above near the footer
- Internal scrolling
- Search input remains visible
- Consistent string IDs
- Non-posting accounts disabled
- Selected account preserved when reopening

Apply to all account fields in bills and payment dialogs.

---

## 30. Reversal

A posted bill cannot be deleted.

Create:

```ts
reverseBill(...)
```

Reversal must:

- Require reason
- Create exact opposite journal lines
- Recalculate supplier balance
- Recalculate bill status
- Preserve original bill and number
- Link reversal journal

Example:

```text
Original:
Dr Expense
Dr Input VAT
    Cr Trade payables

Reversal:
Dr Trade payables
    Cr Expense
    Cr Input VAT
```

Use the original posted journal, not approximate reconstruction.

---

## 31. Supplier Statement and AP Aging

Bills must appear in supplier statements.

AP aging buckets:

```text
Current
1-30 days overdue
31-60 days overdue
61-90 days overdue
91-120 days overdue
Over 120 days
```

Age remaining bill balances after payments and supplier credits.

Use due date.

---

## 32. Cash Flow Classification

Bill posting is non-cash.

Supplier payment drives cash flow:

- Operating expense payment → Operating outflow
- Inventory payment → Operating outflow
- Asset payment → Investing outflow
- Loan-related payment → Financing outflow

Use payment counterpart accounts and bill metadata.

---

## 33. Dashboard Metrics

Optional:

- Bills due today
- Bills due this week
- Overdue bills
- Total AP
- Bills awaiting approval
- Supplier payments this month
- Average payment period
- Top suppliers by payable balance

Do not double count bills with multiple payments.

---

## 34. Permissions

Suggested:

- View bills
- Create bills
- Edit drafts
- Submit bills
- Approve bills
- Post bills
- Record payments
- Create supplier credits
- Reverse bills
- Upload/view attachments
- Override duplicate warning
- View tax details
- Manage AP configuration

---

## 35. Audit Trail

Record:

- Bill created
- Supplier selected
- Supplier invoice number entered
- Line/account/tax changes
- Attachment upload
- Submission
- Approval/rejection
- Posting
- Journal creation
- Payment
- Supplier credit
- Reversal
- Replacement bill

---

## 36. Recommended Files

```text
src/
  types/
    bill.ts

  store/
    billStore.ts

  lib/
    billCalculations.ts
    billValidation.ts
    billNumbering.ts
    billPosting.ts
    billSettlement.ts
    billTax.ts
    billReversal.ts

  components/
    bills/
      BillList.tsx
      BillEditor.tsx
      BillDrawer.tsx
      BillLineTable.tsx
      BillSummary.tsx
      BillDetails.tsx
      BillPreview.tsx
      BillAttachments.tsx
      BillPaymentDialog.tsx
      BillReverseDialog.tsx
      BillApprovalPanel.tsx

  pages/
    BillsPage.tsx
    BillDetailsPage.tsx
```

Reuse generic pickers and journal/print components.

Keep business logic outside React components.

---

## 37. Core Functions

```ts
calculateBillLine(...)
calculateBillTotals(...)
calculateBillBalance(...)
buildBillSettlementSummary(...)
checkDuplicateSupplierInvoiceNumber(...)
resolveAccountsPayableAccount(...)
validateBillDraft(...)
validateBillForPosting(...)
generateBillNumber(...)
buildBillJournalEntry(...)
postBill(...)
reverseBill(...)
deriveBillStatus(...)
calculateBillAging(...)
```

---

## 38. Persistence

Use Zustand and LocalStorage consistently.

Persist:

- Bills and lines
- Attachment metadata
- Numbering configuration
- Journal links
- Approval metadata
- Payment allocations
- Supplier-credit applications
- Reversal links

Refresh must preserve all statuses and links.

Do not store temporary object URLs.

---

## 39. Acceptance Scenario 1 — Expense Bill

```text
Supplier: ABC Services
Supplier invoice: ABC-8842
Expense: 1,000.00
Input VAT: 160.00
Total: 1,160.00
```

Expected journal:

```text
Dr Professional fees expense       1,000.00
Dr Input VAT recoverable             160.00
    Cr Trade payables                       1,160.00
```

Expected:

- Bill posted
- Journal balanced
- Supplier balance +1,160.00
- AP aging +1,160.00
- No cash-flow movement until payment

---

## 40. Acceptance Scenario 2 — Partial Payment

```text
Bill total: 1,160.00
Payment: 500.00
```

Journal:

```text
Dr Trade payables                   500.00
    Cr Bank                                  500.00
```

Expected:

```text
Amount paid: 500.00
Balance due: 660.00
Status: Partially paid
```

---

## 41. Acceptance Scenario 3 — Supplier Credit

```text
Original bill total: 1,160.00
Supplier credit: 580.00
```

Expected:

```text
Original total:      1,160.00
Supplier credits:     (580.00)
Balance due:           580.00
```

Credit journal:

```text
Dr Trade payables                   580.00
    Cr Expense / returns                     500.00
    Cr Input VAT recoverable                  80.00
```

---

## 42. Acceptance Scenario 4 — Asset Bill

```text
Equipment: 25,000.00
Input VAT: 4,000.00
Total: 29,000.00
```

Journal:

```text
Dr Equipment                       25,000.00
Dr Input VAT recoverable            4,000.00
    Cr Trade payables                      29,000.00
```

No cash movement occurs until payment.

---

## 43. Tests

Add tests for:

1. Draft bill does not affect accounting
2. Posted expense bill is balanced
3. Expense debit is correct
4. Input VAT debit is correct
5. AP credit is correct
6. Asset bill posts correctly
7. Inventory bill posts correctly where supported
8. Duplicate supplier invoice blocked
9. Bill number unique per entity
10. Partial payment reduces balance
11. Full payment marks paid
12. Multiple payments work
13. Supplier credit reduces balance
14. Original bill total remains unchanged
15. Settlement does not double count
16. Draft/void supplier credits excluded
17. Tax calculation correct
18. Withholding policy consistent
19. Multi-currency base amount correct
20. FX payment difference correct where supported
21. Supplier advance does not create expense
22. Posted bill cannot be edited directly
23. Reversal is exact
24. Reversal restores supplier balance
25. AP aging uses remaining balance
26. Overdue uses due date
27. Attachments persist
28. PO matching works where supported
29. Generated journal not double counted in supplier statement
30. Bill creation excluded from cash flow
31. Payment classified correctly in cash flow
32. Valid leaf accounts accepted
33. Header accounts blocked
34. LocalStorage hydration works
35. Empty dataset safe
36. Mobile editor works
37. Print preview works
38. Route refresh works

---

## 44. QA

Run:

- TypeScript typecheck
- Unit tests
- Production build
- Expense bill smoke test
- Asset bill test
- Tax test
- Partial/full payment tests
- Supplier credit test
- Reversal test
- Duplicate supplier invoice test
- AP aging test
- Supplier statement test
- Cash Flow classification test
- Attachment persistence test
- LocalStorage hydration test
- Mobile-width test
- Print preview test
- Route refresh test

Report:

- Files created
- Files modified
- Bill types implemented
- Posting accounts used
- Tax logic
- AP resolution
- Numbering
- Settlement logic
- Acceptance results
- Journal results
- AP aging
- Supplier statement
- Cash Flow result
- Tests
- Typecheck
- Production build
- Deferred items

---

## Core Accounting Rules

Expense bill:

```text
Dr Expense
Dr Input VAT recoverable
    Cr Trade payables
```

Asset bill:

```text
Dr Asset
Dr Input VAT recoverable
    Cr Trade payables
```

Supplier payment:

```text
Dr Trade payables
    Cr Bank / Cash
```

Supplier credit:

```text
Dr Trade payables
    Cr Expense / Asset / Inventory
    Cr Input VAT recoverable
```

The original bill total must never be silently rewritten because of later payments or supplier credits.
