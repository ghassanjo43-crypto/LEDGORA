import type {
  InvoiceNumberingConfig,
  InvoiceTemplateSnapshot,
  TemplateResolutionSource,
} from '@/types/invoice';
import type { CostCenterAssignment } from '@/types/costCenter';

/**
 * Credit Note domain types. A credit note is a separate, linked accounting
 * document that reduces or reverses all or part of a previously issued invoice.
 * It reuses the invoice module's template snapshot, numbering config and
 * template-resolution source so branding, numbering and posting stay consistent.
 */

export type CreditNoteStatus =
  | 'draft'
  | 'approved'
  | 'issued'
  | 'applied'
  | 'partially-applied'
  | 'refunded'
  | 'void';

export type CreditType =
  | 'full'
  | 'partial'
  | 'selected-lines'
  | 'price-adjustment'
  | 'general-credit';

export type CreditNoteReasonCode =
  | 'goods-returned'
  | 'service-cancelled'
  | 'invoice-overcharge'
  | 'pricing-error'
  | 'quantity-error'
  | 'tax-error'
  | 'discount-adjustment'
  | 'damaged-goods'
  | 'customer-goodwill'
  | 'duplicate-invoice'
  | 'other';

/** The credit note reuses the invoice template snapshot verbatim (adapted title). */
export type CreditNoteTemplateSnapshot = InvoiceTemplateSnapshot;

/** Whether a credit line reduces the original by quantity or by a partial amount. */
export type CreditBasis = 'quantity' | 'amount';

/** Frozen per-line view of the original invoice line a credit line relates to. */
export interface CreditNoteReferenceLine {
  creditNoteLineId: string;
  originalInvoiceLineId?: string;
  itemLabel: string;
  description: string;
  originalQuantity: number;
  originalUnitPrice: number;
  originalLineTotal: number;
  previouslyCreditedQuantity: number;
  quantityCreditedByThisNote: number;
  remainingQuantity: number;
  creditNoteLineTotal: number;
  creditBasis: CreditBasis;
}

/**
 * The original-invoice financial context, frozen onto the credit note when it is
 * issued. Historical credit notes must NOT change if the invoice later receives
 * payments, further credits or customer-data edits.
 */
export interface CreditNoteInvoiceReferenceSnapshot {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  originalInvoiceTotal: number;
  paymentsAppliedBeforeCredit: number;
  previousCreditsTotal: number;
  invoiceBalanceBeforeCredit: number;
  currentCreditAmount: number;
  invoiceBalanceAfterCredit: number;
  currency: string;
  purchaseOrderReference?: string;
  customerReference?: string;
  lines: CreditNoteReferenceLine[];
}

/** Numbering config is structurally identical to the invoice's (prefix defaults to CN). */
export type CreditNoteNumberingConfig = InvoiceNumberingConfig;

export interface CreditNoteAuditEvent {
  id: string;
  at: string;
  action: string;
  detail?: string;
}

export interface CreditNoteLine {
  id: string;
  creditNoteId: string;

  originalInvoiceLineId?: string;
  itemId?: string;
  description: string;

  revenueAccountId: string;
  quantity: number;
  unit?: string;
  unitPrice: number;

  discountType?: 'percentage' | 'amount';
  discountValue?: number;
  discountAmount: number;

  taxCodeId?: string;
  taxRate: number;
  taxableAmount: number;
  taxAmount: number;
  lineTotal: number;

  projectId?: string;
  costCenterId?: string;
  /** Optional split allocation across cost centers (inherited from the original invoice line). */
  costCenterAssignments?: CostCenterAssignment[];
  entityId?: string;

  returnToInventory?: boolean;
  inventoryAccountId?: string;
  costOfGoodsSoldAccountId?: string;
  costAmount?: number;
  /** Inventory item + warehouse the physical return goes back into. */
  inventoryItemId?: string;
  returnWarehouseId?: string;

  sortOrder: number;
}

/** A subledger allocation of issued credit against a customer invoice. */
export interface CreditApplication {
  id: string;
  entityId: string;
  customerId: string;
  creditNoteId: string;
  invoiceId: string;
  amount: number;
  applicationDate: string;
  /** True once reversed by a void; kept for audit rather than deleted. */
  reversed?: boolean;
  createdAt: string;
}

/** A cash refund of remaining customer credit — its own journal entry. */
export interface CreditNoteRefund {
  id: string;
  creditNoteId: string;
  entityId: string;
  customerId: string;
  amount: number;
  refundDate: string;
  bankAccountId: string;
  reference?: string;
  memo?: string;
  journalEntryId?: string;
  createdAt: string;
}

export interface CreditNote {
  id: string;
  entityId: string;
  customerId: string;

  creditNoteNumber: string;
  originalInvoiceId?: string;
  originalInvoiceNumber?: string;
  originalInvoiceDate?: string;

  status: CreditNoteStatus;
  creditType: CreditType;

  issueDate: string;
  currency: string;
  exchangeRate: number;

  reasonCode: CreditNoteReasonCode;
  reasonDescription: string;

  templateId: string;
  templateVersionId: string;
  templateResolutionSource: TemplateResolutionSource;
  /** Frozen at issuance; undefined while a draft (rendered live from the version). */
  templateSnapshot?: CreditNoteTemplateSnapshot;
  /** Original-invoice financial context, frozen at issuance (immutable thereafter). */
  invoiceReferenceSnapshot?: CreditNoteInvoiceReferenceSnapshot;

  lines: CreditNoteLine[];

  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;

  amountApplied: number;
  amountRefunded: number;
  remainingCredit: number;

  notes?: string;
  terms?: string;

  applications: CreditApplication[];
  refunds: CreditNoteRefund[];

  /** Sales-return journal entry created on issue. */
  journalEntryId?: string;
  /** Inventory-return journal entry (when goods physically returned). */
  inventoryJournalEntryId?: string;
  /** Reversing journal entry created on void. */
  reversalJournalEntryId?: string;

  issuedAt?: string;
  appliedAt?: string;
  refundedAt?: string;
  voidedAt?: string;
  voidReason?: string;

  auditTrail: CreditNoteAuditEvent[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Chart-of-accounts routing for the credit-note posting. Mirrors the invoice
 * posting context but adds the sales-returns / adjustment accounts.
 */
export interface CreditNotePostingConfig {
  salesReturnsAccountId?: string;
  serviceAdjustmentsAccountId?: string;
  customerReceivablesAccountId: string;
  outputTaxAccountId?: string;
  inventoryAccountId?: string;
  costOfGoodsSoldAccountId?: string;
}
