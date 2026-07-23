/**
 * Universal Journal Voucher — type definitions.
 *
 * The Journal Voucher is a SOURCE-DOCUMENT interface over the existing General
 * Journal: one flexible form for every balanced non-document transaction
 * (transfers, accruals, prepayments, provisions, adjustments, asset entries…).
 * Posting always flows through `journalStore.insertPostedEntry` — the voucher
 * module never becomes a second ledger. Asset-linked vouchers delegate their
 * posting to the Fixed Assets store so the subledger and the ledger move
 * together through the already-proven seams.
 */

export type JournalVoucherStatus =
  | 'draft'
  | 'pending_approval'
  | 'rejected'
  | 'approved'
  | 'posted'
  | 'partially_reversed'
  | 'reversed'
  | 'cancelled';

/**
 * Built-in voucher-type behaviours the posting engine understands. Admin-added
 * custom types behave as 'general'.
 */
export type VoucherTypeKind =
  | 'general'
  | 'bank_transfer'
  | 'asset_acquisition'
  | 'asset_disposal'
  | 'asset_depreciation'
  | 'asset_impairment'
  | 'accrual'
  | 'prepayment'
  | 'opening_balance'
  | 'intercompany'
  | 'tax_adjustment';

/** Configurable voucher type. Administrators may add more (kind 'general'). */
export interface VoucherTypeConfig {
  id: string;
  code: string;
  name: string;
  kind: VoucherTypeKind;
  /** Voucher-number prefix, e.g. "JV", "BTR", "ACC". */
  prefix: string;
  defaultDescription: string;
  /** Default account suggestions (never a hard-coded number — chart IDs). */
  defaultDebitAccountId: string;
  defaultCreditAccountId: string;
  /** Dimensions every line must carry. */
  requiredDimensions: Array<'costCenter' | 'project'>;
  approvalRequired: boolean;
  allowAutoReversal: boolean;
  allowRecurring: boolean;
  allowTaxCodes: boolean;
  allowBankAccounts: boolean;
  allowAssetRefs: boolean;
  requireIntercompany: boolean;
  /**
   * Warn that this transaction is normally recorded through a formal source
   * document (invoice / bill / credit note…) — the voucher must not silently
   * replace a legally required document.
   */
  warnFormalDocument: boolean;
  isSystem: boolean;
  isActive: boolean;
}

export interface VoucherAttachment {
  id: string;
  name: string;
  url: string;
  note: string;
  uploadedAt: string;
  uploadedBy: string;
}

/** One journal line (amounts in the voucher's transaction currency). */
export interface JournalVoucherLine {
  id: string;
  lineNumber: number;
  accountId: string;
  /** Snapshot for display; refreshed from the chart while draft. */
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  description: string;
  /** Optional sub-ledger / dimension references. */
  entityId: string; // customer or supplier (business entity)
  bankAccountId: string;
  assetId: string;
  inventoryItemId: string;
  employee: string;
  relatedCompany: string;
  branch: string;
  department: string;
  costCenterId: string;
  projectId: string;
  profitCenter: string;
  location: string;
  taxCode: string;
  taxAmount: number;
  dueDate: string;
  reference: string;
  attachments: VoucherAttachment[];
}

/** Approval / lifecycle history event on one voucher. */
export interface VoucherHistoryEvent {
  id: string;
  at: string;
  actor: string;
  action:
    | 'created' | 'updated' | 'submitted' | 'reviewed' | 'approved' | 'rejected'
    | 'posted' | 'reversed' | 'corrected' | 'cancelled' | 'attachment-added';
  comment: string;
}

export interface JournalVoucher {
  id: string;
  /** e.g. JV-0007 / BTR-0002 — prefix comes from the voucher type. */
  number: string;
  typeId: string;
  status: JournalVoucherStatus;

  /** Organization scoping (single set of books per workspace today). */
  organizationId: string;
  companyId: string;
  branch: string;

  transactionDate: string;
  postingDate: string;
  /** Accounting period label (YYYY-MM), derived from the posting date. */
  period: string;
  documentDate: string;

  currency: string;
  exchangeRate: number;

  externalReference: string;
  internalReference: string;
  /** Source-document idempotency key: `${sourceModule}:${sourceTransactionId}`. */
  sourceModule: string;
  sourceTransactionId: string;

  description: string;
  narration: string;

  /** Automatic reversal on this date (accruals). '' = none. */
  autoReverseDate: string;
  /** Recurring template that generated this voucher, if any. */
  templateId: string;

  lines: JournalVoucherLine[];

  /**
   * Structured payload for asset-linked voucher kinds. The posting DELEGATES to
   * the Fixed Assets store (one engine, one journal); the resulting voucher
   * lines are snapshotted from the generated journal entry for display.
   */
  assetInput?: {
    assetId: string;
    /* acquisition */
    funding?: 'credit' | 'bank' | 'cash' | 'auc' | 'manual';
    creditAccountId?: string;
    baseCost?: number;
    recoverableTax?: number;
    nonRecoverableTax?: number;
    otherCapitalizedCosts?: number;
    /* disposal / sale */
    proceeds?: number;
    disposalCosts?: number;
    outputTax?: number;
    outputTaxAccountId?: string;
    receiptAccountId?: string;
    portionPercent?: number;
    catchUpDepreciation?: boolean;
    depreciationOverrideReason?: string;
    /* depreciation / amortization */
    amount?: number;
    /* impairment */
    recoverableAmount?: number;
  };

  /** Generated General Journal voucher (the accounting record). */
  journalEntryId: string;
  journalEntryNumber: string;
  /** Fixed-asset transaction created by an asset-linked posting. */
  assetTransactionId: string;

  /** Reversal / correction chain. */
  reversalOfVoucherId: string;
  reversedByVoucherId: string;
  replacementVoucherId: string;
  reversalReason: string;
  /** Common reference shared by an intercompany pair. */
  intercompanyRef: string;

  preparedBy: string;
  reviewedBy: string;
  approvedBy: string;
  postedBy: string;
  rejectionComment: string;

  createdAt: string;
  updatedAt: string;
  approvedAt: string;
  postedAt: string;

  attachments: VoucherAttachment[];
  history: VoucherHistoryEvent[];
}

/* ── Recurring templates ──────────────────────────────────────────────────── */

export type RecurringFrequency = 'monthly' | 'quarterly' | 'annual';

export interface RecurringVoucherTemplate {
  id: string;
  /** e.g. RVT-0001 */
  number: string;
  name: string;
  typeId: string;
  frequency: RecurringFrequency;
  startDate: string;
  endDate: string;
  nextPostingDate: string;
  description: string;
  currency: string;
  exchangeRate: number;
  lines: JournalVoucherLine[];
  autoReverse: boolean;
  approvalRequired: boolean;
  active: boolean;
  createdAt: string;
  createdBy: string;
  /** Vouchers generated from this template. */
  generatedVoucherIds: string[];
}

/* ── Module settings ──────────────────────────────────────────────────────── */

export interface JournalVoucherSettings {
  /** Posting on/before this date is rejected (module period lock). */
  postingLockDate: string;
  /** Currency-rounding differences (≤ tolerance) post here; '' = reject them. */
  roundingAccountId: string;
  roundingTolerance: number;
  fxGainAccountId: string;
  fxLossAccountId: string;
  /**
   * Once normal operations begin, opening-balance vouchers need the dedicated
   * permission AND this flag switched off by an administrator.
   */
  openingBalancesLocked: boolean;
  /** Preparer of a material voucher may not approve it. */
  segregationOfDuties: boolean;
  /** Base-currency amount at/above which a voucher is "material". */
  materialAmountThreshold: number;
}

export type JournalVoucherAuditEvent =
  | 'type-saved' | 'settings-updated' | 'voucher-created' | 'voucher-updated'
  | 'voucher-submitted' | 'voucher-approved' | 'voucher-rejected' | 'voucher-posted'
  | 'voucher-reversed' | 'voucher-corrected' | 'voucher-cancelled'
  | 'template-saved' | 'template-generated';

export interface JournalVoucherAuditEntry {
  id: string;
  at: string;
  actor: string;
  event: JournalVoucherAuditEvent;
  detail: string;
  operator?: import('@/lib/platformEntitlementOverride').OperatorAuditMetadata;
}
