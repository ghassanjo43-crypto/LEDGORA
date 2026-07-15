# Credit Note Module Specification

## Project context

Implement a production-quality Credit Note module in the existing React + TypeScript IFRS bookkeeping application.

The application already contains:

- Customers
- Invoices
- Invoice templates and versions
- General Journal
- General Ledger
- Trial Balance
- Income Statement
- Balance Sheet
- Cash Flow Statement
- Chart of Accounts
- Tax codes
- Entity selector
- Zustand stores
- Zod validation
- LocalStorage persistence
- Ledgerly ERP design system

Existing invoice-related paths include:

- `src/components/invoices/`
- `src/store/invoiceStore.ts`
- `src/types/invoice.ts`
- `src/lib/invoicePosting.ts`
- existing invoice numbering, validation, rendering, and template logic

The Credit Note module must reuse those patterns and the existing journal-posting engine.

Do not create a separate accounting engine.

---

## 1. Core purpose

A credit note must reduce or reverse all or part of a previously issued invoice.

Support:

1. Full invoice credit
2. Partial invoice credit
3. Specific-line credit
4. Quantity-based return
5. Amount-based adjustment
6. Tax correction
7. Price correction
8. Discount correction
9. Customer goodwill credit
10. Optional inventory return when inventory functionality exists

For the first release, the primary workflow must be:

`Issued invoice → Create Credit Note`

Do not allow a draft or void invoice to be credited.

---

## 2. Navigation and routes

Under Sales, add:

- Customers
- Invoices
- Credit Notes
- Payments
- Invoice Templates

Routes:

```text
/sales/credit-notes
/sales/credit-notes/new
/sales/credit-notes/:creditNoteId
/sales/credit-notes/:creditNoteId/edit
```

On each eligible issued invoice, add a visible action:

```text
Create Credit Note
```

---

## 3. Creation workflow

From an invoice:

```text
Invoice
→ Actions
→ Create Credit Note
```

Prefill the editor with:

- Entity
- Customer
- Original invoice number
- Original invoice date
- Currency and exchange rate
- Original template and branding
- Invoice lines
- Original tax codes
- Original revenue accounts
- Project and cost-center assignments
- Remaining creditable quantities
- Remaining creditable amounts

Credit types:

- Full credit
- Partial credit
- Selected lines
- Price adjustment
- General customer credit

Default to:

```text
Selected lines
```

For invoice-linked credit notes:

- Customer is locked
- Entity is locked
- Currency is locked
- Original invoice link is permanent

---

## 4. Types

Create `src/types/creditNote.ts`.

```ts
export type CreditNoteStatus =
  | "draft"
  | "approved"
  | "issued"
  | "applied"
  | "partially-applied"
  | "refunded"
  | "void"

export type CreditType =
  | "full"
  | "partial"
  | "selected-lines"
  | "price-adjustment"
  | "general-credit"

export type CreditNoteReasonCode =
  | "goods-returned"
  | "service-cancelled"
  | "invoice-overcharge"
  | "pricing-error"
  | "quantity-error"
  | "tax-error"
  | "discount-adjustment"
  | "damaged-goods"
  | "customer-goodwill"
  | "duplicate-invoice"
  | "other"

export type CreditNote = {
  id: string
  entityId: string
  customerId: string

  creditNoteNumber: string
  originalInvoiceId?: string
  originalInvoiceNumber?: string
  originalInvoiceDate?: string

  status: CreditNoteStatus
  creditType: CreditType

  issueDate: string
  currency: string
  exchangeRate: number

  reasonCode: CreditNoteReasonCode
  reasonDescription: string

  templateId: string
  templateVersionId: string
  templateSnapshot: CreditNoteTemplateSnapshot

  subtotal: number
  discountTotal: number
  taxTotal: number
  grandTotal: number

  amountApplied: number
  amountRefunded: number
  remainingCredit: number

  journalEntryId?: string
  inventoryJournalEntryId?: string
  reversalJournalEntryId?: string

  issuedAt?: string
  appliedAt?: string
  refundedAt?: string
  voidedAt?: string
  voidReason?: string

  createdAt: string
  updatedAt: string
}

export type CreditNoteLine = {
  id: string
  creditNoteId: string

  originalInvoiceLineId?: string
  itemId?: string
  description: string

  revenueAccountId: string
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
  lineTotal: number

  projectId?: string
  costCenterId?: string
  entityId?: string

  returnToInventory?: boolean
  inventoryAccountId?: string
  costOfGoodsSoldAccountId?: string
  costAmount?: number

  sortOrder: number
}

export type CreditApplication = {
  id: string
  entityId: string
  customerId: string
  creditNoteId: string
  invoiceId: string
  amount: number
  applicationDate: string
  createdAt: string
}
```

Use the existing invoice snapshot types where practical.

---

## 5. Reason handling

Require a controlled reason code.

If:

```ts
reasonCode === "other"
```

then `reasonDescription` is mandatory.

Display the reason prominently in:

- Editor
- Renderer
- Print/PDF
- Credit-note details
- Audit trail

---

## 6. Creditable balance controls

Prevent over-crediting.

Per invoice line:

```text
Remaining creditable quantity
= Original invoiced quantity
− Quantity already credited by issued, non-void credit notes
```

```text
Remaining creditable amount
= Original invoice line total
− Amount already credited by issued, non-void credit notes
```

Invoice level:

```text
Maximum remaining credit
= Original invoice grand total
− Total issued non-void credits
```

Exclude draft and void credit notes from previous-credit calculations.

Show:

- Original invoice total
- Previously credited
- Available to credit
- This credit note
- Remaining after credit

Do not allow a new credit note to exceed the available invoice or line-level amount.

---

## 7. Full credit

When Full Credit is selected:

- Copy only remaining creditable lines
- Use remaining creditable quantities
- Use remaining creditable discounts
- Use remaining creditable taxes
- Use the remaining invoice creditable balance

If earlier partial credits exist, do not copy the already credited part.

---

## 8. Partial and selected-line credits

Allow:

- Select/deselect invoice lines
- Credit quantity
- Credit amount
- Discount adjustment
- Tax adjustment
- Return-to-inventory toggle where supported

Block:

- Negative quantities
- Zero-value active lines
- Credits above original quantities
- Credits above remaining taxable amounts
- Tax credits above remaining original tax
- Total credits above the invoice’s remaining creditable value

---

## 9. Calculations

Reuse the invoice module’s decimal-safe monetary utilities.

Per line:

```text
lineSubtotal = quantity × unitPrice
discountAmount = percentage or fixed amount
taxableAmount = lineSubtotal − discountAmount
taxAmount = taxableAmount × taxRate
lineTotal = taxableAmount + taxAmount
```

Totals:

```text
subtotal = sum(lineSubtotal)
discountTotal = sum(discountAmount)
taxTotal = sum(taxAmount)
grandTotal = subtotal − discountTotal + taxTotal
```

Display customer-facing credit-note amounts as positive values.

Do not use negative quantities or negative prices merely to force accounting direction.

---

## 10. Store

Create `src/store/creditNoteStore.ts` using the same Zustand and LocalStorage conventions as `invoiceStore.ts`.

Store:

- Credit notes
- Credit-note lines
- Credit applications
- Refund references
- Numbering configuration if not centralized elsewhere

Required store actions should include:

```ts
createCreditNoteFromInvoice(...)
saveCreditNoteDraft(...)
updateCreditNote(...)
approveCreditNote(...)
issueCreditNote(...)
applyCreditNote(...)
refundCreditNote(...)
voidCreditNote(...)
getCreditNoteById(...)
getCreditNotesForInvoice(...)
getCreditNotesForCustomer(...)
```

Historical issued credit notes must remain immutable except for application, refund, and void metadata.

---

## 11. Numbering

Reuse the invoice-numbering pattern.

Create a centralized helper such as:

```ts
generateCreditNoteNumber(...)
```

Default format:

```text
CN-2026-0001
```

Configuration:

- Prefix
- Include year
- Sequence length
- Next sequence
- Annual reset

Requirements:

- Unique per entity
- Never reuse voided numbers
- Do not permanently consume a number for an abandoned unsaved editor unless current invoice behavior already does so
- Follow the same persistence policy as invoices

---

## 12. Accounting posting

A draft credit note must not affect accounting.

On issue, create a balanced journal entry through the existing General Journal posting service.

Do not write directly to General Ledger balances.

Original invoice example:

```text
Dr Trade receivables              1,160
    Cr Sales revenue                        1,000
    Cr VAT payable                           160
```

Credit-note example:

```text
Dr Sales returns and allowances   1,000
Dr VAT payable                      160
    Cr Trade receivables                    1,160
```

Recommended posting configuration:

```ts
export type CreditNotePostingConfig = {
  salesReturnsAccountId?: string
  serviceAdjustmentsAccountId?: string
  customerReceivablesAccountId: string
  outputTaxAccountId?: string
  inventoryAccountId?: string
  costOfGoodsSoldAccountId?: string
}
```

Posting policy:

- Debit configured sales-returns/allowance account where available
- Otherwise debit the original revenue account
- Preserve each original invoice line’s revenue classification
- Debit the same output-tax account originally credited
- Credit the customer receivables/control account for the gross amount

Store the generated `journalEntryId` on the credit note.

Journal references must include:

- Credit note number
- Original invoice number
- Customer ID
- Credit note ID
- Project
- Cost center
- Entity
- Tax references
- Clear memo

The posting must pass the same balancing and posting-account validation used by invoices.

---

## 13. Inventory return

Only implement inventory reversal if the current inventory module and original cost data exist.

When goods are physically returned:

```text
Dr Inventory
    Cr Cost of goods sold
```

Rules:

- Use original cost basis
- Never derive inventory cost from selling price
- Post only for inventory-managed items
- Require `returnToInventory`
- Require original cost data

If inventory support is incomplete, preserve the fields but defer posting rather than creating fake accounting.

---

## 14. Credit application

Issuing a credit note creates customer credit.

Allow:

1. Apply to the original invoice
2. Apply to another open invoice
3. Leave unapplied
4. Refund later

For an unpaid or partially paid linked invoice, default to:

```text
Apply to original invoice
```

but require user confirmation before issue.

Applying an already issued credit note is a subledger allocation.

Do not create another revenue reversal journal entry merely for application.

Rules:

- Total applications cannot exceed remaining credit
- Applications cannot exceed target invoice balance
- Customer and entity must match
- Recalculate both credit-note and invoice balances after application

---

## 15. Invoice balance integration

Do not overwrite the original invoice total.

Show:

```text
Original total
Less payments
Less credit notes
Balance due
```

Calculation:

```text
adjustedInvoiceBalance
= originalInvoiceTotal
− paymentsApplied
− creditsApplied
```

Possible invoice outcomes:

- Fully credited
- Partially credited
- Paid after credit
- Partially paid
- Outstanding

Add a Credit Notes section to invoice details with:

- Credit note number
- Date
- Amount
- Applied amount
- Status

---

## 16. Paid invoice behavior

When the original invoice is already fully paid:

- Issue the credit note
- Create an unapplied customer credit
- Do not automatically create a bank transaction
- Offer:
  - Leave as customer credit
  - Apply to another invoice
  - Refund customer

---

## 17. Refund workflow

A refund is a separate transaction.

Example:

```text
Dr Customer credit / Trade receivables    580
    Cr Bank                                        580
```

Require:

- Bank or cash account
- Refund date
- Payment reference
- Amount
- Optional memo

Create a separate journal entry and link it to the credit note.

Do not alter the original credit-note journal entry to record a refund.

Reduce:

- Remaining credit
- Customer available credit

---

## 18. Template and rendering

Create a built-in default Credit Note renderer.

A credit note created from an invoice should inherit the invoice’s visual identity.

Resolution priority:

1. Credit-note template explicitly selected
2. Original invoice’s frozen template snapshot adapted to Credit Note
3. Customer preferred credit-note template
4. Entity default credit-note template
5. System default credit-note template

Centralize in:

```ts
resolveCreditNoteTemplate(...)
```

When adapting the invoice snapshot:

- Preserve logo
- Preserve colors
- Preserve fonts
- Preserve company information
- Preserve customer information
- Change title to `Credit Note`
- Add original invoice reference
- Show reason
- Replace invoice totals with credit totals

Freeze the credit-note template snapshot when issued.

Later changes to:

- Logo
- Company details
- Customer details
- Template colors
- Labels
- Terms
- Bank details

must not alter issued credit notes.

The document must include:

- Company logo
- Company legal information
- Credit note number
- Issue date
- Customer details
- Original invoice reference
- Reason
- Credited lines
- Subtotal
- Discount
- Tax reversal
- Total credit
- Amount applied
- Remaining credit
- Notes
- Terms
- Signature
- Footer
- Page number

Default line columns:

- Item/service
- Description
- Original quantity
- Credited quantity
- Unit price
- Discount
- Tax
- Credit total

Reuse the existing invoice renderer and print/PDF utilities where practical.

---

## 19. Editing rules

Draft credit notes may be edited.

Issued credit notes must not be materially edited.

For corrections:

- Void the credit note
- Create a replacement credit note

Preserve the original document, number, snapshot, journal link, and audit history.

---

## 20. Voiding

Voiding an issued credit note must:

- Require a reason
- Create an exact reversing journal entry
- Reverse inventory return entries where applicable
- Reverse/remove credit applications
- Recalculate affected invoice balances
- Recalculate customer available credit
- Mark the credit note void
- Preserve the original document and number

Do not delete issued credit notes or journal entries.

---

## 21. Editor UI

Create an editor consistent with the invoice editor.

Header:

- Entity
- Customer
- Credit note number
- Original invoice
- Issue date
- Currency
- Reason code
- Reason description
- Credit type
- Credit-note template

Summary:

- Original invoice total
- Previous credits
- Available credit
- Current credit-note total
- Remaining credit after issue
- Invoice balance after application

Line table:

- Select line
- Item/service
- Original quantity
- Previously credited quantity
- Available quantity
- Credit quantity
- Unit price
- Discount
- Tax
- Credit total
- Return to inventory
- Revenue account
- Project
- Cost center

Actions:

- Save draft
- Preview
- Approve
- Issue credit note
- Cancel

Draft saving may permit incomplete data.

Issue must run full validation.

---

## 22. List page

Create Credit Notes page with:

Columns:

- Credit note number
- Original invoice
- Customer
- Issue date
- Reason
- Currency
- Total
- Amount applied
- Remaining credit
- Status
- Journal status

Filters:

- Entity
- Customer
- Original invoice
- Status
- Date range
- Reason
- Applied/unapplied
- Refunded
- Currency

Actions:

- View
- Edit draft
- Preview
- Print
- Download PDF
- Apply credit
- Refund
- Duplicate
- Void

---

## 23. Customer integration

On customer details, add:

```text
Customer Credits
```

Show:

- Available credit
- Applied credit
- Refunded credit
- Credit-note history

Allow available credits to be applied to eligible open invoices.

---

## 24. Validation

Create separate validators:

```ts
validateCreditNoteDraft(...)
validateCreditNoteForIssue(...)
```

Draft save may allow incomplete information.

Issue requires:

- Entity
- Customer
- Unique credit-note number
- Issue date
- Reason
- Currency
- Valid template/snapshot
- At least one valid line
- Positive grand total
- No over-crediting
- Valid revenue/adjustment accounts
- Valid tax reversal mapping
- Customer receivable account
- Balanced journal entry
- Original invoice for invoice-linked types

Also block:

- Zero-value notes
- Negative active amounts
- Invalid line quantities
- Tax above original remaining tax
- Currency mismatch
- Entity mismatch
- Customer mismatch
- Crediting draft or void invoices

Reuse Zod conventions from the invoice module.

---

## 25. Recommended files

Adapt to the project’s actual conventions.

```text
src/
  types/
    creditNote.ts

  store/
    creditNoteStore.ts

  lib/
    creditNoteCalculations.ts
    creditNoteValidation.ts
    creditNoteNumbering.ts
    creditNotePosting.ts
    creditNoteTemplate.ts
    creditNoteApplications.ts

  components/
    credit-notes/
      CreditNoteList.tsx
      CreditNoteEditor.tsx
      CreditNoteDrawer.tsx
      CreditNoteRenderer.tsx
      CreditNotePreview.tsx
      CreditNoteLineTable.tsx
      CreditNoteSummary.tsx
      CreditNoteApplicationDialog.tsx
      CreditNoteRefundDialog.tsx
      CreditNoteVoidDialog.tsx

  pages/
    CreditNotesPage.tsx
    CreditNoteDetailsPage.tsx
```

Keep business logic outside React components.

---

## 26. Reusable functions

Implement centralized functions such as:

```ts
calculateRemainingCreditableAmount(...)
calculateRemainingCreditableQuantity(...)
createCreditNoteFromInvoice(...)
calculateCreditNoteLine(...)
calculateCreditNoteTotals(...)
validateCreditNoteDraft(...)
validateCreditNoteForIssue(...)
generateCreditNoteNumber(...)
buildCreditNoteJournalEntry(...)
buildInventoryReturnJournalEntry(...)
issueCreditNote(...)
applyCreditNoteToInvoice(...)
refundCreditNote(...)
voidCreditNote(...)
resolveCreditNoteTemplate(...)
createCreditNoteTemplateSnapshot(...)
```

---

## 27. Persistence and audit

Use existing Zustand and LocalStorage patterns.

Persist:

- Credit notes
- Lines
- Applications
- Refund links
- Template snapshots
- Journal links
- Void metadata

Audit events:

- Created
- Original invoice linked
- Lines selected
- Amount changed
- Reason changed
- Template resolved
- Approved
- Issued
- Journal created
- Applied to invoice
- Applied to another invoice
- Refunded
- Voided
- Replacement created

---

## 28. Tests

Add tests for:

1. Draft invoice cannot be credited
2. Void invoice cannot be credited
3. Issued invoice can create a credit note
4. Full credit uses only remaining creditable value
5. Partial credit works
6. Selected-line credit works
7. Previous credits reduce available credit
8. Over-crediting is blocked
9. Draft credit notes do not reduce creditable amount
10. Void credit notes do not reduce creditable amount
11. Tax credit cannot exceed original remaining tax
12. Issue creates a balanced journal entry
13. Sales returns account is debited correctly
14. VAT payable is debited correctly
15. Receivables are credited correctly
16. Original invoice total remains unchanged
17. Applying credit reduces invoice balance due
18. Paid invoice creates unapplied customer credit
19. Refund creates a separate journal entry
20. Issued credit note retains frozen branding
21. Invoice branding is inherited correctly
22. Credit-note number is unique
23. Issued note cannot be directly edited
24. Void creates exact reversal
25. Void reverses applications
26. Customer available credit recalculates correctly
27. LocalStorage hydration preserves data
28. Empty datasets render safely
29. Customer/entity/currency are locked for linked notes
30. Full credit after prior partial credits uses only the remainder
31. Navigation survives browser refresh
32. Mobile rendering works
33. Print preview works

---

## 29. Acceptance scenario

Original invoice:

```text
Invoice number: INV-2026-0001
Customer: Customer A
Revenue: 1,000.00
VAT: 160.00
Invoice total: 1,160.00
```

Create a partial credit note:

```text
Credit note number: CN-2026-0001
Reason: Service partially cancelled
Revenue credit: 500.00
VAT reversal: 80.00
Total credit: 580.00
```

Expected journal:

```text
Dr Sales returns and allowances     500.00
Dr VAT payable                       80.00
    Cr Trade receivables                     580.00
```

Expected invoice presentation:

```text
Original total:                    1,160.00
Credit notes:                        580.00
Payments:                              0.00
Balance due:                         580.00
```

Expected results:

- Linked to `INV-2026-0001`
- Inherits invoice logo and branding
- Customer and currency cannot change
- Journal entry is balanced
- General Ledger updates through the journal
- Original invoice total remains `1,160.00`
- Invoice balance becomes `580.00`
- Maximum additional credit becomes `580.00`
- Historical invoice remains unchanged

---

## 30. QA

Run:

- TypeScript typecheck
- Unit tests
- Production build
- Credit-note creation smoke test
- Full credit test
- Partial credit test
- Over-credit prevention test
- Posting test
- Void/reversal test
- Application test
- Refund test
- Refresh/LocalStorage hydration test
- Print preview test
- Mobile-width test

Report:

- Files created
- Files modified
- Credit-note model added
- Posting logic used
- Numbering logic used
- Template-resolution logic used
- Acceptance-scenario totals
- Journal-entry result
- Invoice-balance result
- Test results
- Typecheck result
- Production-build result
- Any intentionally deferred items

---

## Core accounting rule

```text
Credit note issued
→ Reduce revenue or debit sales returns
→ Reverse output tax
→ Reduce customer receivable
```

The original invoice remains intact.

The credit note is a separate linked accounting document with its own:

- Number
- Status
- Journal entry
- Template snapshot
- Audit history
