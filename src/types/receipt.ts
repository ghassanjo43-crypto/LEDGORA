import type {
  InvoiceNumberingConfig,
  InvoiceTemplateSnapshot,
  TemplateResolutionSource,
} from '@/types/invoice';

/**
 * Receipts domain types. A receipt is a separate, self-contained accounting
 * document recording money received. It reuses the invoice module's template
 * snapshot, numbering config and template-resolution source so branding and
 * numbering stay consistent across the suite.
 */

export type ReceiptType =
  | 'customer-payment'
  | 'customer-advance'
  | 'unapplied-customer-receipt'
  | 'miscellaneous-income'
  | 'owner-contribution'
  | 'loan-proceeds'
  | 'interest-income'
  | 'supplier-refund'
  | 'other';

export type ReceiptStatus =
  | 'draft'
  | 'approved'
  | 'posted'
  | 'partially-allocated'
  | 'fully-allocated'
  | 'reversed'
  | 'void';

export type ReceiptMethod =
  | 'cash'
  | 'bank-transfer'
  | 'cheque'
  | 'card'
  | 'online-transfer'
  | 'other';

export type ReceiptAllocationType = 'invoice' | 'customer-advance' | 'customer-credit' | 'other';

/** The receipt document reuses the invoice template snapshot verbatim (adapted title). */
export type ReceiptTemplateSnapshot = InvoiceTemplateSnapshot;

/** Numbering config is structurally identical to the invoice's (prefix defaults to RCT). */
export type ReceiptNumberingConfig = InvoiceNumberingConfig;

export interface ReceiptAuditEvent {
  id: string;
  at: string;
  action: string;
  detail?: string;
}

export interface ReceiptAllocation {
  id: string;
  entityId: string;
  receiptId: string;

  customerId?: string;

  invoiceId?: string;
  invoiceNumber?: string;
  creditNoteId?: string;

  allocationType: ReceiptAllocationType;

  amount: number;
  baseCurrencyAmount: number;

  allocationDate: string;

  /** Reversed by a receipt reversal — kept for audit rather than deleted. */
  reversed?: boolean;

  createdAt: string;
  updatedAt: string;
}

export interface Receipt {
  id: string;
  entityId: string;

  receiptNumber: string;
  receiptType: ReceiptType;
  status: ReceiptStatus;

  customerId?: string;
  supplierId?: string;
  /** Free-text payer for non-customer receipts. */
  payerName?: string;
  payerAccountName?: string;
  payerBankName?: string;

  receiptDate: string;
  valueDate?: string;

  currency: string;
  exchangeRate: number;

  amount: number;
  baseCurrencyAmount: number;

  method: ReceiptMethod;

  /** Debit-side cash account (bank/cash/deposit) the money lands in. */
  bankAccountId?: string;
  cashAccountId?: string;
  depositAccountId?: string;

  /** Explicit credit account for non-customer receipt types. */
  creditAccountId?: string;

  chequeNumber?: string;
  chequeDate?: string;
  chequeBankName?: string;

  transactionReference?: string;
  cardReference?: string;
  transferReference?: string;

  /** Bank fees deducted from the deposit (Dr fee expense). */
  bankFeeAmount?: number;
  bankFeeAccountId?: string;
  grossReceiptAmount?: number;
  netBankAmount?: number;

  /** Withholding tax deducted by the customer (Dr WHT receivable). */
  withholdingTaxAmount?: number;
  withholdingTaxAccountId?: string;
  withholdingTaxCertificateReference?: string;

  narration?: string;
  notes?: string;

  allocations: ReceiptAllocation[];
  allocationTotal: number;
  unappliedAmount: number;

  journalEntryId?: string;
  reversalJournalEntryId?: string;

  templateId?: string;
  templateVersionId?: string;
  templateResolutionSource?: TemplateResolutionSource;
  templateSnapshot?: ReceiptTemplateSnapshot;

  postedAt?: string;
  approvedAt?: string;
  reversedAt?: string;
  voidedAt?: string;

  reverseReason?: string;
  voidReason?: string;

  auditTrail: ReceiptAuditEvent[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Chart-of-accounts routing for receipt postings. Centralizes the debit cash
 * accounts and the type-specific credit accounts so posting stays consistent.
 */
export interface ReceiptPostingConfig {
  tradeReceivablesAccountId: string;
  customerAdvanceAccountId?: string;
  unappliedReceiptsAccountId?: string;
  otherIncomeAccountId?: string;
  bankAccountIds: string[];
  cashAccountIds: string[];
  defaultBankAccountId?: string;
  defaultCashAccountId?: string;
}
