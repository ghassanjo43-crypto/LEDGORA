import type { CostCenterAssignment } from '@/types/costCenter';

/* ─────────────────────────── Template configuration ─────────────────────── */

export type PageSize = 'A4' | 'Letter';
export type Orientation = 'portrait' | 'landscape';
export type HeaderLayout = 'logo-left' | 'logo-right' | 'centered' | 'compact' | 'custom';
export type TableStyle = 'minimal' | 'bordered' | 'striped' | 'modern';
export type TextDirection = 'ltr' | 'rtl';
export type TemplateVersionStatus = 'draft' | 'published' | 'archived';

export type LogoMode = 'entity-default' | 'custom' | 'hidden';
export type LogoPosition = 'top-left' | 'top-center' | 'top-right';
export type LogoFit = 'contain' | 'cover';

/** Per-template-version logo configuration (lives in the draft/published version). */
export interface InvoiceLogoConfig {
  mode: LogoMode;
  /** Persistent data URL when mode === 'custom'. */
  customLogoUrl?: string;
  fileName?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  fit: LogoFit;
  position: LogoPosition;
  maxWidth: number;
  maxHeight: number;
}

export interface InvoiceMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A positioned, toggleable block on the invoice (controlled layout, not free canvas). */
export type InvoiceSectionKind =
  | 'company'
  | 'customer'
  | 'invoiceDetails'
  | 'lineItems'
  | 'totals'
  | 'payment'
  | 'notes'
  | 'terms'
  | 'signature'
  | 'footer';

export interface InvoiceTemplateSection {
  kind: InvoiceSectionKind;
  visible: boolean;
  order: number;
}

/** A line-item column that can be hidden, reordered and widthed by the designer. */
export type InvoiceColumnField =
  | 'item'
  | 'description'
  | 'quantity'
  | 'unit'
  | 'unitPrice'
  | 'discount'
  | 'taxRate'
  | 'taxAmount'
  | 'lineTotal';

export interface InvoiceColumnConfig {
  field: InvoiceColumnField;
  label: string;
  visible: boolean;
  order: number;
  width?: number;
  align?: 'left' | 'right' | 'center';
}

export interface InvoiceLayoutConfig {
  pageSize: PageSize;
  orientation: Orientation;
  margins: InvoiceMargins;
  headerLayout: HeaderLayout;
  sections: InvoiceTemplateSection[];
  lineItemColumns: InvoiceColumnConfig[];
}

export interface InvoiceStyleConfig {
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  borderColor: string;
  backgroundColor: string;
  fontFamily: string;
  headingFontFamily?: string;
  baseFontSize: number;
  tableStyle: TableStyle;
  borderRadius: number;
  showTableGrid: boolean;
  /** Optional faint diagonal watermark text (e.g. "DRAFT", "ORIGINAL"). */
  watermark?: string;
}

export interface InvoiceContentConfig {
  title: string;
  customLabels: Record<string, string>;
  showLogo: boolean;
  /** Logo source + placement for this template version. */
  logo?: InvoiceLogoConfig;
  showCompanyAddress: boolean;
  showCustomerAddress: boolean;
  showTaxDetails: boolean;
  showBankDetails: boolean;
  showSignature: boolean;
  showPaymentTerms: boolean;
  showNotes: boolean;
  showTerms: boolean;
  showQrCode: boolean;
  footerText?: string;
  termsText?: string;
  paymentInstructions?: string;
  language: string;
  direction: TextDirection;
}

/* ───────────────────────────── Templates & versions ─────────────────────── */

export interface InvoiceTemplate {
  id: string;
  entityId: string;
  name: string;
  description?: string;
  isSystemDefault: boolean;
  isEntityDefault: boolean;
  isArchived: boolean;
  currentVersionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceTemplateVersion {
  id: string;
  templateId: string;
  versionNumber: number;
  versionLabel?: string;
  status: TemplateVersionStatus;
  layoutConfig: InvoiceLayoutConfig;
  styleConfig: InvoiceStyleConfig;
  contentConfig: InvoiceContentConfig;
  createdBy?: string;
  createdAt: string;
  publishedAt?: string;
}

export interface CustomerInvoiceTemplatePreference {
  id: string;
  entityId: string;
  customerId: string;
  templateId: string;
  templateVersionId: string;
  /** When true, resolve to the template's latest PUBLISHED version instead of the pinned one. */
  useLatestPublishedVersion: boolean;
  effectiveFrom?: string;
  effectiveTo?: string;
  createdAt: string;
  updatedAt: string;
}

export type TemplateResolutionSource =
  | 'invoice-override'
  | 'customer-preference'
  | 'entity-default'
  | 'system-default';

export interface ResolvedInvoiceTemplate {
  templateId: string;
  templateVersionId: string;
  resolutionSource: TemplateResolutionSource;
}

/* ─────────────────────────────── Snapshot ───────────────────────────────── */

export interface InvoiceCompanySnapshot {
  legalName: string;
  tradingName?: string;
  address?: string;
  taxNumber?: string;
  registrationNumber?: string;
  phone?: string;
  email?: string;
  website?: string;
  logoUrl?: string;
  bankDetails?: string;
}

export interface InvoiceCustomerSnapshot {
  name: string;
  billingAddress?: string;
  taxNumber?: string;
  phone?: string;
  email?: string;
}

export interface InvoiceTemplateSnapshot {
  templateId: string;
  templateVersionId: string;
  templateName: string;
  versionNumber: number;
  layoutConfig: InvoiceLayoutConfig;
  styleConfig: InvoiceStyleConfig;
  contentConfig: InvoiceContentConfig;
  companySnapshot: InvoiceCompanySnapshot;
  customerSnapshot: InvoiceCustomerSnapshot;
}

/* ─────────────────────────────── Invoice ────────────────────────────────── */

export type InvoiceStatus =
  | 'draft'
  | 'approved'
  | 'issued'
  | 'sent'
  | 'partially-paid'
  | 'paid'
  | 'void';

export type DiscountType = 'percentage' | 'amount';

export interface InvoiceLine {
  id: string;
  itemId?: string;
  accountId: string;
  description: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  discountType?: DiscountType;
  discountValue?: number;
  taxCodeId?: string;
  taxRate: number;
  taxAmount: number;
  lineSubtotal: number;
  lineTotal: number;
  projectId?: string;
  costCenterId?: string;
  /** Optional split allocation across multiple cost centers (must total the line). */
  costCenterAssignments?: CostCenterAssignment[];
  entityId?: string;
  /* ── Inventory (issue-on-invoice) ─────────────────────────────────────── */
  /** Inventory item to issue from stock (when set + mode issue-on-invoice). */
  inventoryItemId?: string;
  /** Warehouse the stock is issued from. */
  warehouseId?: string;
  inventoryFulfillmentMode?: 'none' | 'issue-on-invoice' | 'delivered-separately';
  /** Weighted-average cost the line was issued at (preserved for returns). */
  issuedUnitCost?: number;
  sortOrder: number;
}

export interface InvoicePayment {
  id: string;
  invoiceId: string;
  date: string;
  amount: number;
  method: string;
  reference?: string;
  bankAccountId: string;
  journalEntryId?: string;
  /** Set when this payment came from a posted Receipt allocation (subledger link). */
  receiptId?: string;
  createdAt: string;
}

export interface Invoice {
  id: string;
  entityId: string;
  customerId: string;
  invoiceNumber: string;
  status: InvoiceStatus;

  issueDate: string;
  dueDate: string;
  currency: string;
  exchangeRate: number;

  purchaseOrderReference?: string;
  customerReference?: string;
  salespersonId?: string;
  projectId?: string;
  costCenterId?: string;

  templateId: string;
  templateVersionId: string;
  templateResolutionSource: TemplateResolutionSource;
  /** Frozen at issuance; undefined while a draft (rendered live from the version). */
  templateSnapshot?: InvoiceTemplateSnapshot;

  lines: InvoiceLine[];

  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  additionalChargesTotal: number;
  grandTotal: number;
  amountPaid: number;
  /** Credit-note value allocated to this invoice (subledger; original total is never altered). */
  creditsApplied: number;
  balanceDue: number;

  notes?: string;
  terms?: string;
  paymentTerms?: string;

  payments: InvoicePayment[];

  /** Sales journal entry created on issue. */
  journalEntryId?: string;
  /** Reversing journal entry created on void. */
  reversalJournalEntryId?: string;
  voidReason?: string;

  issuedAt?: string;
  sentAt?: string;
  paidAt?: string;
  voidedAt?: string;

  auditTrail: InvoiceAuditEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceAuditEvent {
  id: string;
  at: string;
  action: string;
  detail?: string;
}

/* ─────────────────────────────── Numbering ──────────────────────────────── */

export interface InvoiceNumberingConfig {
  entityId: string;
  prefix: string;
  includeYear: boolean;
  sequenceLength: number;
  nextSequence: number;
  resetAnnually: boolean;
  /** Year the current sequence belongs to (for annual reset). */
  sequenceYear: number;
}
