import type { InvoiceNumberingConfig, InvoiceTemplateSnapshot, TemplateResolutionSource } from '@/types/invoice';

/**
 * Payments domain types — outgoing money. A payment is a separate, self-contained
 * accounting document that records money leaving the business (supplier payments,
 * advances, expense/tax/payroll/loan/lease payments, owner drawings, dividends
 * and customer/credit-note refunds). It is the payables-side mirror of the
 * Receipts module and reuses the invoice module's template snapshot, numbering
 * config and template-resolution source so branding and numbering stay consistent.
 *
 * The payment owns the ONE bank/cash journal entry. Applying a payment to bills
 * updates the bill subledger only (never a second cash journal).
 */

export type PaymentType =
  | 'supplier-payment'
  | 'supplier-advance'
  | 'unapplied-supplier-payment'
  | 'expense-payment'
  | 'tax-payment'
  | 'payroll-payment'
  | 'loan-repayment'
  | 'lease-payment'
  | 'owner-drawing'
  | 'dividend-payment'
  | 'customer-refund'
  | 'credit-note-refund'
  | 'other';

export type PaymentStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'posted'
  | 'partially-allocated'
  | 'fully-allocated'
  | 'reversed'
  | 'void';

export type PaymentMethod =
  | 'bank-transfer'
  | 'cash'
  | 'cheque'
  | 'card'
  | 'online-transfer'
  | 'direct-debit'
  | 'other';

export type PaymentAllocationType =
  | 'bill'
  | 'supplier-advance'
  | 'supplier-credit'
  | 'customer-refund'
  | 'other';

/** Where/when withholding tax is recognised (shared policy with bills). */
export type WithholdingRecognition = 'bill-posting' | 'payment';

/** Payments reuse the invoice template snapshot verbatim (adapted title). */
export type PaymentTemplateSnapshot = InvoiceTemplateSnapshot;
export type PaymentNumberingConfig = InvoiceNumberingConfig;

export interface PaymentAuditEvent {
  id: string;
  at: string;
  action: string;
  detail?: string;
}

export interface PaymentAllocation {
  id: string;
  entityId: string;
  paymentId: string;

  supplierId?: string;
  customerId?: string;

  billId?: string;
  billNumber?: string;
  supplierCreditId?: string;
  invoiceId?: string;
  creditNoteId?: string;

  allocationType: PaymentAllocationType;

  amount: number;
  baseCurrencyAmount: number;
  allocationDate: string;

  /** Reversed by a payment reversal — kept for audit rather than deleted. */
  reversed?: boolean;

  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  entityId: string;

  paymentNumber: string;
  paymentType: PaymentType;
  status: PaymentStatus;

  supplierId?: string;
  customerId?: string;
  employeeId?: string;
  taxAuthorityId?: string;

  paymentDate: string;
  valueDate?: string;

  currency: string;
  exchangeRate: number;

  /** Amount settling the liability/expense side (debit total ex. bank fees). */
  grossAmount: number;
  bankFeeAmount: number;
  withholdingTaxAmount: number;
  discountTakenAmount: number;
  /** Cash actually leaving the bank = gross + fee − withholding − discount. */
  netCashAmount: number;
  baseCurrencyAmount: number;

  /** Realised FX gain(+)/loss(−) on a foreign-currency settlement. */
  realizedFxAmount?: number;

  method: PaymentMethod;

  bankAccountId?: string;
  cashAccountId?: string;
  chequeClearingAccountId?: string;
  cardSettlementAccountId?: string;

  /** Explicit debit account for expense / tax / payroll / equity / refund / other types. */
  debitAccountId?: string;

  /** Bank-fee expense, withholding-payable, purchase-discount and realised-FX routing. */
  bankFeeAccountId?: string;
  withholdingTaxAccountId?: string;
  discountAccountId?: string;
  realizedFxAccountId?: string;

  /** Loan / lease split. */
  loanAccountId?: string;
  principalAmount?: number;
  interestAmount?: number;
  interestAccountId?: string;
  leaseLiabilityAccountId?: string;
  leasePrincipalAmount?: number;
  financeCostAmount?: number;
  financeCostAccountId?: string;

  /** Tax / payroll metadata. */
  taxPeriod?: string;
  filingReference?: string;
  payrollPeriod?: string;

  /** Refund metadata. */
  refundReason?: string;

  chequeNumber?: string;
  chequeDate?: string;
  chequeBankName?: string;

  transactionReference?: string;
  transferReference?: string;
  cardReference?: string;
  directDebitReference?: string;

  payeeName?: string;
  payeeAccountName?: string;
  payeeBankName?: string;

  narration?: string;
  notes?: string;
  internalMemo?: string;

  allocations: PaymentAllocation[];
  allocationTotal: number;
  unappliedAmount: number;

  journalEntryId?: string;
  reversalJournalEntryId?: string;

  templateId?: string;
  templateVersionId?: string;
  templateResolutionSource?: TemplateResolutionSource;
  templateSnapshot?: PaymentTemplateSnapshot;

  submittedAt?: string;
  approvedAt?: string;
  postedAt?: string;
  reversedAt?: string;
  voidedAt?: string;

  approvedBy?: string;
  reversalReason?: string;
  voidReason?: string;

  auditTrail: PaymentAuditEvent[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Chart-of-accounts routing for payment postings. Centralises the credit cash
 * accounts and the type-specific debit accounts so posting stays consistent.
 */
export interface PaymentPostingConfig {
  accountsPayableAccountId: string;
  supplierAdvancesAccountId?: string;
  withholdingTaxPayableAccountId?: string;
  purchaseDiscountAccountId?: string;
  bankFeeAccountId?: string;
  realizedFxAccountId?: string;
  tradeReceivablesAccountId?: string;
  bankAccountIds: string[];
  cashAccountIds: string[];
  defaultBankAccountId?: string;
  defaultCashAccountId?: string;
}

/** Centralised withholding-tax policy shared with the bills module. */
export interface PaymentWithholdingPolicy {
  recognition: WithholdingRecognition;
  payableAccountId?: string;
}
