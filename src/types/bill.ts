import type { InvoiceNumberingConfig, InvoiceTemplateSnapshot, TemplateResolutionSource } from '@/types/invoice';
import type { CostCenterAssignment } from '@/types/costCenter';

/**
 * Bills (supplier invoices / accounts payable). Mirrors the invoice module on the
 * payables side: a bill is a separate accounting document that records what the
 * business owes a supplier. Reuses the invoice template snapshot and numbering.
 */

export type BillStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'posted'
  | 'partially-paid'
  | 'paid'
  | 'void'
  | 'reversed';

export type BillType = 'goods' | 'services' | 'expense' | 'asset-purchase' | 'inventory-purchase' | 'other';

export type BillPaymentMethod = 'cash' | 'bank-transfer' | 'cheque' | 'card' | 'online-transfer' | 'other';

/** Bills reuse the invoice template snapshot verbatim (adapted title). */
export type BillTemplateSnapshot = InvoiceTemplateSnapshot;
export type BillNumberingConfig = InvoiceNumberingConfig;

export interface BillAuditEvent {
  id: string;
  at: string;
  action: string;
  detail?: string;
}

export interface BillLine {
  id: string;
  billId: string;

  itemId?: string;
  description: string;
  /** Expense / asset / inventory posting account (Dr side). */
  accountId: string;

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

  withholdingTaxRate?: number;
  withholdingTaxAmount?: number;

  lineSubtotal: number;
  lineTotal: number;

  projectId?: string;
  costCenterId?: string;
  /** Optional split allocation across multiple cost centers (must total the line). */
  costCenterAssignments?: CostCenterAssignment[];
  departmentId?: string;

  inventoryItemId?: string;
  /** Warehouse the stock is received into (when mode is receive-on-bill). */
  warehouseId?: string;
  inventoryReceiptMode?: 'none' | 'receive-on-bill' | 'received-separately';
  capitalAssetId?: string;

  sortOrder: number;
}

/** A payment made against a bill (Dr trade payables / Cr bank). */
export interface BillPayment {
  id: string;
  billId: string;
  date: string;
  amount: number;
  method: BillPaymentMethod;
  reference?: string;
  bankAccountId: string;
  /** Bank fees deducted (Dr bank charges). */
  bankFeeAmount?: number;
  bankFeeAccountId?: string;
  /** Realised FX gain(+)/loss(−) on a foreign-currency settlement. */
  realizedFxAmount?: number;
  journalEntryId?: string;
  /** Set when the payment was recorded via the Payments module (one bank journal owns it). */
  paymentId?: string;
  createdAt: string;
}

/** A supplier credit applied to a bill (Dr trade payables / Cr expense + input tax). */
export interface BillSupplierCredit {
  id: string;
  billId: string;
  supplierId: string;
  creditNumber: string;
  amount: number;
  netAmount: number;
  taxAmount: number;
  reason?: string;
  date: string;
  journalEntryId?: string;
  createdAt: string;
}

export interface BillAttachment {
  id: string;
  billId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Persistent reference (e.g. data URL / storage key) — never a temporary object URL. */
  storageReference: string;
  uploadedAt: string;
}

export interface Bill {
  id: string;
  entityId: string;
  supplierId: string;

  billNumber: string;
  supplierInvoiceNumber: string;

  billType: BillType;
  status: BillStatus;

  billDate: string;
  postingDate?: string;
  dueDate: string;
  paymentTerms?: string;

  currency: string;
  exchangeRate: number;

  purchaseOrderId?: string;
  goodsReceiptId?: string;
  supplierReference?: string;
  internalReference?: string;

  projectId?: string;
  costCenterId?: string;
  departmentId?: string;

  lines: BillLine[];

  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  withholdingTaxTotal: number;
  additionalChargesTotal: number;
  grandTotal: number;

  amountPaid: number;
  supplierCreditsApplied: number;
  balanceDue: number;

  accountsPayableAccountId: string;
  inputTaxAccountId?: string;
  withholdingTaxPayableAccountId?: string;

  templateId: string;
  templateVersionId: string;
  templateResolutionSource: TemplateResolutionSource;
  templateSnapshot?: BillTemplateSnapshot;

  journalEntryId?: string;
  reversalJournalEntryId?: string;

  payments: BillPayment[];
  supplierCredits: BillSupplierCredit[];
  attachments: BillAttachment[];

  notes?: string;
  terms?: string;
  internalMemo?: string;

  submittedAt?: string;
  approvedAt?: string;
  postedAt?: string;
  paidAt?: string;
  voidedAt?: string;
  reversedAt?: string;
  approvedBy?: string;
  voidReason?: string;
  reversalReason?: string;

  auditTrail: BillAuditEvent[];
  createdAt: string;
  updatedAt: string;
}

/** Chart-of-accounts routing for a bill posting. */
export interface BillPostingConfig {
  accountsPayableAccountId: string;
  inputTaxAccountId?: string;
  withholdingTaxPayableAccountId?: string;
  supplierAdvancesAccountId?: string;
  realizedFxAccountId?: string;
}

/** Where/when withholding tax is recognised. */
export interface WithholdingTaxPolicy {
  recognition: 'bill-posting' | 'payment';
  payableAccountId?: string;
}

export type BillSettlementStatus =
  | 'outstanding'
  | 'partially-paid'
  | 'paid'
  | 'partially-credited'
  | 'fully-credited'
  | 'settled';

export interface BillSettlementSummary {
  originalTotal: number;
  supplierCreditsApplied: number;
  paymentsApplied: number;
  balanceDue: number;
  status: BillSettlementStatus;
}
