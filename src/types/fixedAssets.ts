/**
 * Fixed Assets module — core type definitions.
 *
 * The asset register is the SOURCE DOCUMENT for every asset transaction:
 * acquisition, capitalization, depreciation, transfer, impairment, revaluation
 * and disposal. Posting a transaction generates exactly one balanced General
 * Journal Voucher (via `journalStore.insertPostedEntry`) linked back to the
 * transaction; nothing here duplicates accounting records.
 */

/** Lifecycle of one asset in the register. */
export type FixedAssetStatus =
  | 'draft'
  | 'pending_approval'
  | 'active'
  | 'fully_depreciated'
  | 'suspended'
  | 'impaired'
  | 'held_for_sale'
  | 'disposed'
  | 'cancelled';

export type DepreciationMethod =
  | 'straight_line'
  | 'reducing_balance'
  | 'units_of_production'
  /** Land and other non-depreciating assets. */
  | 'none';

export type DepreciationFrequency = 'monthly' | 'quarterly' | 'annual';

/** How an acquisition is funded (drives the credit side of the voucher). */
export type AcquisitionFunding = 'credit' | 'bank' | 'cash' | 'auc' | 'manual';

/**
 * Category → Chart of Accounts mapping. Account IDs reference the live chart —
 * never hard-coded numbers. A posting that needs an unmapped account is
 * rejected with a clear error.
 */
export interface AssetCategoryAccounts {
  costAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
  impairmentLossAccountId: string;
  accumulatedImpairmentAccountId: string;
  disposalGainAccountId: string;
  disposalLossAccountId: string;
  /** Clearing / asset-under-construction account. */
  aucAccountId: string;
  /** Recoverable input tax, where applicable. */
  recoverableTaxAccountId: string;
  /** Revaluation (only used when the category enables revaluation). */
  revaluationSurplusAccountId: string;
  revaluationLossAccountId: string;
}

export interface AssetCategory {
  id: string;
  code: string;
  name: string;
  description: string;
  accounts: AssetCategoryAccounts;
  defaultMethod: DepreciationMethod;
  defaultUsefulLifeMonths: number;
  /** Residual value suggested as % of cost when creating an asset. */
  defaultResidualRatePercent: number;
  /** Revaluation must be explicitly enabled per category by policy. */
  revaluationEnabled: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AssetAttachment {
  id: string;
  name: string;
  /** Link / data URL to the supporting document. */
  url: string;
  note: string;
  uploadedAt: string;
  uploadedBy: string;
}

export interface FixedAsset {
  id: string;
  assetCode: string;
  name: string;
  description: string;
  categoryId: string;

  /** Legal entity / company (companyStore id; single set of books per workspace). */
  companyId: string;
  branch: string;
  department: string;
  costCenterId: string;
  projectId: string;
  location: string;
  custodian: string;

  supplierId: string;
  supplierName: string;
  purchaseInvoiceRef: string;

  acquisitionDate: string;
  capitalizationDate: string;

  /** Capitalized cost (incl. non-recoverable tax and attributable costs). */
  originalCost: number;
  /** Spend accumulated on the asset-under-construction account, not yet capitalized. */
  aucBalance: number;
  recoverableTax: number;
  nonRecoverableTax: number;
  residualValue: number;

  usefulLifeMonths: number;
  method: DepreciationMethod;
  /** Annual % for the reducing-balance method. */
  reducingBalanceRatePercent: number;
  /** Total production capacity for units-of-production. */
  unitsTotal: number;
  unitsDepreciated: number;
  depreciationStartDate: string;
  /** Last date through which depreciation has been posted ('' = never). */
  depreciatedThrough: string;

  accumulatedDepreciation: number;
  impairmentBalance: number;
  revaluationSurplusBalance: number;

  /** Number of identical units this record represents (for unit disposals). */
  quantity: number;

  status: FixedAssetStatus;

  disposalDate: string;
  disposalProceeds: number;
  disposalGainLoss: number;

  attachments: AssetAttachment[];
  notes: string;

  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export type FixedAssetTransactionType =
  | 'acquisition'
  | 'auc_acquisition'
  | 'capitalization'
  | 'depreciation'
  | 'transfer'
  | 'intercompany_transfer'
  | 'impairment'
  | 'impairment_reversal'
  | 'revaluation'
  | 'disposal'
  | 'partial_disposal'
  | 'reversal';

export type FixedAssetTransactionStatus = 'posted' | 'reversed';

/**
 * Snapshot of the asset fields a transaction mutated, taken BEFORE posting.
 * A reversal restores exactly this snapshot (and reverses the voucher), so the
 * register and the ledger always move together.
 */
export interface AssetEffect {
  assetId: string;
  before: Partial<FixedAsset>;
  after: Partial<FixedAsset>;
}

/** One posted (immutable) asset transaction — the source document. */
export interface FixedAssetTransaction {
  id: string;
  /** Sequential document number, e.g. FA-0007. */
  number: string;
  type: FixedAssetTransactionType;
  status: FixedAssetTransactionStatus;

  assetId: string;
  assetCode: string;
  date: string;
  postingDate: string;
  description: string;
  /** Supplier / buyer reference where applicable. */
  counterpartyName: string;
  invoiceRef: string;
  amount: number;
  currency: string;
  exchangeRate: number;

  /** The generated General Journal Voucher ('' for dimension-only transfers). */
  journalEntryId: string;
  journalEntryNumber: string;

  /** Reversal linkage (both directions preserved). */
  reversalOfTransactionId: string;
  reversedByTransactionId: string;

  /** Type-specific detail kept for history/reports (impairment amounts, portion…). */
  details: Record<string, string | number | boolean>;
  effects: AssetEffect[];

  reason: string;
  attachments: AssetAttachment[];

  createdAt: string;
  createdBy: string;
  approvedBy: string;
  postedBy: string;
}

/** Scope filters for a depreciation run. */
export interface DepreciationRunScope {
  companyId: string;
  branch: string;
  costCenterId: string;
  projectId: string;
  categoryId: string;
  /** Explicit asset selection ([] = all in scope). */
  assetIds: string[];
}

export interface DepreciationRunLine {
  assetId: string;
  assetCode: string;
  assetName: string;
  categoryId: string;
  amount: number;
  unitsUsed: number;
  nbvBefore: number;
  nbvAfter: number;
  /** Snapshot for reversal. */
  before: Partial<FixedAsset>;
}

export type DepreciationRunStatus = 'preview' | 'approved' | 'posted' | 'reversed';

export interface DepreciationRun {
  id: string;
  /** Sequential run number, e.g. DR-0003. */
  number: string;
  periodFrom: string;
  periodTo: string;
  frequency: DepreciationFrequency;
  scope: DepreciationRunScope;
  lines: DepreciationRunLine[];
  total: number;
  status: DepreciationRunStatus;
  journalEntryId: string;
  journalEntryNumber: string;
  reversalJournalEntryId: string;
  createdAt: string;
  createdBy: string;
  approvedBy: string;
  postedAt: string;
  postedBy: string;
  reversedAt: string;
  reversedBy: string;
  reversalReason: string;
}

/** Transaction kinds that can demand an approval before posting. */
export type FixedAssetApprovable =
  | 'acquisition'
  | 'capitalization'
  | 'depreciation'
  | 'transfer'
  | 'impairment'
  | 'revaluation'
  | 'disposal'
  | 'reversal';

export interface FixedAssetSettings {
  /** Posting on/before this date is rejected ('' = no closed period). */
  postingLockDate: string;
  /** Which transaction kinds require an explicit approver before posting. */
  approvalRequired: Record<FixedAssetApprovable, boolean>;
  defaultFrequency: DepreciationFrequency;
  /** Intercompany transfers are refused unless enabled AND mapped. */
  allowIntercompanyTransfers: boolean;
  intercompanyDueFromAccountId: string;
  intercompanyDueToAccountId: string;
}

export type FixedAssetAuditEvent =
  | 'category-saved'
  | 'asset-created'
  | 'asset-updated'
  | 'asset-submitted'
  | 'asset-approved'
  | 'asset-cancelled'
  | 'transaction-posted'
  | 'transaction-reversed'
  | 'depreciation-previewed'
  | 'depreciation-approved'
  | 'depreciation-posted'
  | 'depreciation-reversed'
  | 'settings-updated';

export interface FixedAssetAuditEntry {
  id: string;
  at: string;
  actor: string;
  event: FixedAssetAuditEvent;
  detail: string;
  /** Present when a platform operator performed the action (see platformFullAccess). */
  operator?: import('@/lib/platformEntitlementOverride').OperatorAuditMetadata;
}
