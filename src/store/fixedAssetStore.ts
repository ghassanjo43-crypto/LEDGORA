/**
 * Fixed Assets store — the asset register, categories, transactions and
 * depreciation runs for the active organization.
 *
 * ── Accounting flow ───────────────────────────────────────────────────────────
 * The asset transaction is the SOURCE DOCUMENT. Posting one builds a balanced
 * voucher (lib/fixedAssetCalculations) and inserts it atomically through
 * `journalStore.insertPostedEntry` — the same seam Inventory and Manufacturing
 * use — so it appears in the General Journal and flows to the General Ledger,
 * Trial Balance and financial statements exactly once. If the journal insert
 * fails, NOTHING is recorded here: no transaction, no register change, no
 * duplicate. Posted vouchers are immutable; corrections go through
 * `reverseTransaction`, which posts a mirrored voucher and restores the
 * register from the transaction's before-snapshot.
 *
 * ── Controls ──────────────────────────────────────────────────────────────────
 * - permissions follow the organization role model (lib/fixedAssetPermissions);
 * - postings on/before `settings.postingLockDate` are rejected (closed period);
 * - configurable approvals per transaction kind;
 * - cost-center / project dimensions are validated against their registries;
 * - audit entries name the real actor — a platform operator in full-access mode
 *   is recorded as the administrator, never as the subscriber.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type {
  AssetAttachment,
  AssetCategory,
  AssetEffect,
  DepreciationRun,
  DepreciationRunLine,
  DepreciationRunScope,
  FixedAsset,
  FixedAssetApprovable,
  FixedAssetAuditEntry,
  FixedAssetAuditEvent,
  FixedAssetSettings,
  FixedAssetStatus,
  FixedAssetTransaction,
  FixedAssetTransactionType,
} from '@/types/fixedAssets';
import {
  buildAcquisitionVoucher,
  buildCapitalizationVoucher,
  buildDepreciationVoucher,
  buildDisposalVoucher,
  buildImpairmentReversalVoucher,
  buildImpairmentVoucher,
  buildIntercompanyTransferVoucher,
  buildRevaluationVoucher,
  computeDepreciation,
  computeDisposal,
  netBookValue,
  portionFraction,
  remainingDepreciable,
  round2,
  type DisposalPortion,
  type VoucherPlan,
} from '@/lib/fixedAssetCalculations';
import { assertFaPermission, type FixedAssetPermission } from '@/lib/fixedAssetPermissions';
import { makeSeedCategories } from '@/lib/fixedAssetSeed';
import { useJournalStore } from './journalStore';
import { useStore } from './useStore';
import { useCostCenterStore } from './costCenterStore';
import { useProjectStore } from './projectStore';
import { useCompanyStore } from './companyStore';
import { getCurrentUser } from './authStore';
import { isPlatformAdminFullAccess, operatorAuditContext, resolveAuditActor } from './platformFullAccess';
import { orgHasModule } from './entitlementHooks';
import { useEntitlementStore } from './entitlementStore';
import { generateId, nowIso } from '@/lib/utils';

export interface FaResult {
  ok: boolean;
  error?: string;
  id?: string;
  journalEntryId?: string;
  transactionId?: string;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const auditActor = (): string => resolveAuditActor('Finance Manager');

/** Effective organization role for permission checks. A verified platform
 * administrator in full-access operator mode acts with admin grants (their
 * identity — not the subscriber's — goes on the audit trail). A workspace with
 * no signed-in member record (local demo) defaults to owner. */
function currentRole(): 'owner' | 'admin' | 'accountant' | 'member' | 'viewer' {
  if (isPlatformAdminFullAccess()) return 'admin';
  return getCurrentUser()?.role ?? 'owner';
}

function makeAudit(event: FixedAssetAuditEvent, detail: string): FixedAssetAuditEntry {
  const operator = operatorAuditContext();
  return {
    id: generateId('faaud'),
    at: nowIso(),
    actor: auditActor(),
    event,
    detail,
    ...(operator ? { operator } : {}),
  };
}

/** Next sequential number for a prefix, e.g. FA-0007. */
function nextSeq(prefix: string, existing: string[]): string {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`, 'u');
  for (const n of existing) {
    const m = re.exec(n.trim());
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

function baseCurrency(): string {
  return useStore.getState().settings.baseCurrency || 'USD';
}

function activeCompanyId(): string {
  return useCompanyStore.getState().activeCompanyId || '';
}

/** Validate optional cost-center / project dimensions against their registries. */
function validateDims(costCenterId: string, projectId: string): string | null {
  if (costCenterId && !useCostCenterStore.getState().costCenters.some((c) => c.id === costCenterId)) {
    return 'The selected cost center does not exist.';
  }
  if (projectId && !useProjectStore.getState().projects.some((p) => p.id === projectId)) {
    return 'The selected project does not exist.';
  }
  return null;
}

const APPROVABLE_FOR_TYPE: Partial<Record<FixedAssetTransactionType, FixedAssetApprovable>> = {
  acquisition: 'acquisition',
  auc_acquisition: 'acquisition',
  capitalization: 'capitalization',
  depreciation: 'depreciation',
  transfer: 'transfer',
  intercompany_transfer: 'transfer',
  impairment: 'impairment',
  impairment_reversal: 'impairment',
  revaluation: 'revaluation',
  disposal: 'disposal',
  partial_disposal: 'disposal',
  reversal: 'reversal',
};

export interface FixedAssetState {
  settings: FixedAssetSettings;
  categories: AssetCategory[];
  assets: FixedAsset[];
  transactions: FixedAssetTransaction[];
  runs: DepreciationRun[];
  auditTrail: FixedAssetAuditEntry[];
  seeded: boolean;

  ensureSeeded: () => void;
  updateSettings: (patch: Partial<FixedAssetSettings>) => FaResult;
  saveCategory: (category: AssetCategory) => FaResult;

  createAsset: (input: Partial<FixedAsset> & { name: string; categoryId: string }) => FaResult;
  updateAsset: (id: string, patch: Partial<FixedAsset>) => FaResult;
  submitAsset: (id: string) => FaResult;
  cancelAsset: (id: string, reason: string) => FaResult;
  setAssetStatus: (id: string, status: Extract<FixedAssetStatus, 'active' | 'suspended' | 'held_for_sale'>, reason: string) => FaResult;

  postAcquisition: (input: {
    assetId: string;
    date: string;
    /** Base cost before tax/other capitalized elements. */
    baseCost: number;
    recoverableTax?: number;
    nonRecoverableTax?: number;
    /** Freight, installation, testing, professional fees… capitalized per setup. */
    otherCapitalizedCosts?: number;
    /** 'credit' | 'bank' | 'cash' | 'auc' | 'manual' — drives description only; the
     * credit side always comes from `creditAccountId` (AP, bank, cash or other). */
    funding: 'credit' | 'bank' | 'cash' | 'auc' | 'manual';
    creditAccountId: string;
    taxCode?: string;
    supplierId?: string;
    supplierName?: string;
    invoiceRef?: string;
    approvedBy?: string;
    attachments?: AssetAttachment[];
  }) => FaResult;

  capitalizeAsset: (input: { assetId: string; date: string; approvedBy?: string }) => FaResult;

  /**
   * Manual single-asset depreciation/amortization charge (used by the Journal
   * Voucher module). Clamped to the remaining depreciable amount; updates the
   * register exactly like a run line.
   */
  postManualDepreciation: (input: {
    assetId: string;
    date: string;
    /** Explicit charge; omitted = computed through `date` by the asset's method. */
    amount?: number;
    approvedBy?: string;
  }) => FaResult;

  previewDepreciationRun: (input: {
    periodFrom: string;
    periodTo: string;
    frequency?: FixedAssetSettings['defaultFrequency'];
    scope?: Partial<DepreciationRunScope>;
    unitsUsedByAsset?: Record<string, number>;
  }) => FaResult;
  approveDepreciationRun: (runId: string, approvedBy?: string) => FaResult;
  postDepreciationRun: (runId: string) => FaResult;
  reverseDepreciationRun: (runId: string, reason: string) => FaResult;

  transferAsset: (input: {
    assetId: string;
    date: string;
    changes: Partial<Pick<FixedAsset, 'branch' | 'department' | 'costCenterId' | 'projectId' | 'location' | 'custodian'>>;
    reason?: string;
    approvedBy?: string;
  }) => FaResult;
  intercompanyTransfer: (input: { assetId: string; date: string; targetCompany: string; reason: string; approvedBy?: string }) => FaResult;

  impairAsset: (input: { assetId: string; date: string; recoverableAmount: number; reason: string; approvedBy?: string; attachments?: AssetAttachment[] }) => FaResult;
  reverseImpairment: (input: { assetId: string; date: string; amount: number; reason: string; approvedBy?: string }) => FaResult;

  revalueAsset: (input: { assetId: string; date: string; revaluedAmount: number; reason: string; approvedBy?: string; attachments?: AssetAttachment[] }) => FaResult;

  disposeAsset: (input: {
    assetId: string;
    date: string;
    portion?: DisposalPortion;
    proceeds: number;
    disposalCosts?: number;
    outputTax?: number;
    outputTaxAccountId?: string;
    receiptAccountId?: string;
    taxCode?: string;
    buyerName?: string;
    invoiceRef?: string;
    reason?: string;
    approvedBy?: string;
    /** Post catch-up depreciation to the disposal date first. */
    catchUpDepreciation?: boolean;
    /** Documented reason for skipping catch-up depreciation (authorized users). */
    depreciationOverrideReason?: string;
    attachments?: AssetAttachment[];
  }) => FaResult;

  reverseTransaction: (transactionId: string, reason: string, approvedBy?: string) => FaResult;

  resetToDefault: () => void;
}

const DEFAULT_SETTINGS: FixedAssetSettings = {
  postingLockDate: '',
  approvalRequired: {
    acquisition: false,
    capitalization: false,
    depreciation: false,
    transfer: false,
    impairment: true,
    revaluation: true,
    disposal: true,
    reversal: true,
  },
  defaultFrequency: 'monthly',
  allowIntercompanyTransfers: false,
  intercompanyDueFromAccountId: '',
  intercompanyDueToAccountId: '',
};

const EMPTY_STATE = {
  settings: DEFAULT_SETTINGS,
  categories: [] as AssetCategory[],
  assets: [] as FixedAsset[],
  transactions: [] as FixedAssetTransaction[],
  runs: [] as DepreciationRun[],
  auditTrail: [] as FixedAssetAuditEntry[],
  seeded: false,
};

export function makeBlankAsset(categoryId: string): FixedAsset {
  const now = nowIso();
  return {
    id: generateId('fa'),
    assetCode: '',
    name: '',
    description: '',
    categoryId,
    companyId: activeCompanyId(),
    branch: '',
    department: '',
    costCenterId: '',
    projectId: '',
    location: '',
    custodian: '',
    supplierId: '',
    supplierName: '',
    purchaseInvoiceRef: '',
    acquisitionDate: now.slice(0, 10),
    capitalizationDate: '',
    originalCost: 0,
    aucBalance: 0,
    recoverableTax: 0,
    nonRecoverableTax: 0,
    residualValue: 0,
    usefulLifeMonths: 60,
    method: 'straight_line',
    reducingBalanceRatePercent: 25,
    unitsTotal: 0,
    unitsDepreciated: 0,
    depreciationStartDate: '',
    depreciatedThrough: '',
    accumulatedDepreciation: 0,
    impairmentBalance: 0,
    revaluationSurplusBalance: 0,
    quantity: 1,
    status: 'draft',
    disposalDate: '',
    disposalProceeds: 0,
    disposalGainLoss: 0,
    attachments: [],
    notes: '',
    createdAt: now,
    createdBy: auditActor(),
    updatedAt: now,
    updatedBy: auditActor(),
  };
}

export const useFixedAssetStore = create<FixedAssetState>()(
  persist(
    (set, get) => {
      /* ── Internal guards ─────────────────────────────────────────────── */

      const perm = (p: FixedAssetPermission): FaResult => {
        const r = assertFaPermission(currentRole(), p);
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      };

      /** Closed-period + module + date sanity guard for every posting. */
      const postingGuard = (date: string): FaResult => {
        if (!orgHasModule('fixed_assets')) return { ok: false, error: 'The Fixed Assets module is not enabled for this organization.' };
        if (!date || Number.isNaN(Date.parse(date))) return { ok: false, error: 'A valid transaction date is required.' };
        const lock = get().settings.postingLockDate;
        if (lock && date <= lock) {
          return { ok: false, error: `The accounting period through ${lock} is closed. Choose a later posting date or reopen the period.` };
        }
        return { ok: true };
      };

      /** Approval guard: when the kind requires approval, an approver must be named. */
      const approvalGuard = (type: FixedAssetTransactionType, approvedBy?: string): FaResult => {
        const kind = APPROVABLE_FOR_TYPE[type];
        if (kind && get().settings.approvalRequired[kind] && !approvedBy?.trim()) {
          return { ok: false, error: `This ${type.replaceAll('_', ' ')} requires approval — provide the approver.` };
        }
        return { ok: true };
      };

      /** Post a voucher plan and record the linked transaction atomically. */
      const postTransaction = (input: {
        type: FixedAssetTransactionType;
        asset: FixedAsset;
        date: string;
        description: string;
        amount: number;
        plan: VoucherPlan | null; // null = dimension-only (no voucher)
        effects: AssetEffect[];
        applyAfter: (a: FixedAsset) => FixedAsset;
        details?: Record<string, string | number | boolean>;
        counterpartyName?: string;
        invoiceRef?: string;
        reason?: string;
        approvedBy?: string;
        attachments?: AssetAttachment[];
        reversalOfTransactionId?: string;
        auditEvent?: FixedAssetAuditEvent;
      }): FaResult => {
        const { transactions, assets } = get();
        let journalEntryId = '';
        let journalEntryNumber = '';

        if (input.plan) {
          if (!input.plan.ok) return { ok: false, error: input.plan.error };
          const number = nextSeq('FA', transactions.map((t) => t.number));
          const res = useJournalStore.getState().insertPostedEntry({
            entryDate: input.date,
            reference: `FA:${number}`,
            description: input.description,
            currency: baseCurrency(),
            exchangeRate: 1,
            transactionType: 'Fixed Assets',
            notes: `Source: Fixed Assets · ${input.type} · asset ${input.asset.assetCode || input.asset.id}`,
            lines: input.plan.lines.map((l) => ({
              accountId: l.accountId,
              debit: l.debit,
              credit: l.credit,
              description: l.description,
              costCenter: l.costCenter,
              project: l.project,
              taxCode: l.taxCode,
              taxAmount: l.taxAmount,
            })),
          });
          if (!res.ok || !res.id) return { ok: false, error: res.error ?? 'Journal posting failed.' };
          journalEntryId = res.id;
          journalEntryNumber = useJournalStore.getState().entries.find((e) => e.id === res.id)?.entryNumber ?? '';
        }

        const now = nowIso();
        const txn: FixedAssetTransaction = {
          id: generateId('fatx'),
          number: nextSeq('FA', get().transactions.map((t) => t.number)),
          type: input.type,
          status: 'posted',
          assetId: input.asset.id,
          assetCode: input.asset.assetCode,
          date: input.date,
          postingDate: now.slice(0, 10),
          description: input.description,
          counterpartyName: input.counterpartyName ?? '',
          invoiceRef: input.invoiceRef ?? '',
          amount: round2(input.amount),
          currency: baseCurrency(),
          exchangeRate: 1,
          journalEntryId,
          journalEntryNumber,
          reversalOfTransactionId: input.reversalOfTransactionId ?? '',
          reversedByTransactionId: '',
          details: input.details ?? {},
          effects: input.effects,
          reason: input.reason ?? '',
          attachments: input.attachments ?? [],
          createdAt: now,
          createdBy: auditActor(),
          approvedBy: input.approvedBy ?? '',
          postedBy: auditActor(),
        };
        set({
          transactions: [...get().transactions, txn],
          assets: assets.map((a) => (a.id === input.asset.id ? { ...input.applyAfter(a), updatedAt: now, updatedBy: auditActor() } : a)),
          auditTrail: [
            ...get().auditTrail,
            makeAudit(input.auditEvent ?? 'transaction-posted', `${txn.number} ${input.type} — ${input.asset.assetCode || input.asset.name} (${journalEntryNumber || 'no voucher'}).`),
          ],
        });
        return { ok: true, id: txn.id, transactionId: txn.id, journalEntryId };
      };

      return {
        ...EMPTY_STATE,

        ensureSeeded: () => {
          if (get().seeded) return;
          if (!orgHasModule('fixed_assets')) return;
          const categories = makeSeedCategories(useStore.getState().accounts);
          set({ categories, seeded: true, auditTrail: [...get().auditTrail, makeAudit('category-saved', `Seeded ${categories.length} default asset categories from the chart of accounts.`)] });
        },

        updateSettings: (patch) => {
          const p = perm('fa.configure');
          if (!p.ok) return p;
          set({
            settings: { ...get().settings, ...patch, approvalRequired: { ...get().settings.approvalRequired, ...(patch.approvalRequired ?? {}) } },
            auditTrail: [...get().auditTrail, makeAudit('settings-updated', 'Fixed-asset settings updated.')],
          });
          return { ok: true };
        },

        saveCategory: (category) => {
          const p = perm('fa.configure');
          if (!p.ok) return p;
          if (!category.code.trim() || !category.name.trim()) return { ok: false, error: 'Category code and name are required.' };
          const { categories } = get();
          if (categories.some((c) => c.code === category.code && c.id !== category.id)) {
            return { ok: false, error: `Category code "${category.code}" already exists.` };
          }
          const exists = categories.some((c) => c.id === category.id);
          const now = nowIso();
          const next = { ...category, updatedAt: now, createdAt: exists ? category.createdAt : now };
          set({
            categories: exists ? categories.map((c) => (c.id === category.id ? next : c)) : [...categories, next],
            auditTrail: [...get().auditTrail, makeAudit('category-saved', `Category ${category.code} — ${category.name} saved.`)],
          });
          return { ok: true, id: category.id };
        },

        createAsset: (input) => {
          const p = perm('fa.create');
          if (!p.ok) return p;
          if (!input.name.trim()) return { ok: false, error: 'Asset name is required.' };
          const category = get().categories.find((c) => c.id === input.categoryId);
          if (!category) return { ok: false, error: 'Select a valid asset category.' };
          const dims = validateDims(input.costCenterId ?? '', input.projectId ?? '');
          if (dims) return { ok: false, error: dims };
          const { assets } = get();
          const blank = makeBlankAsset(category.id);
          const asset: FixedAsset = {
            ...blank,
            ...input,
            id: blank.id,
            assetCode: input.assetCode?.trim() || nextSeq('AST', assets.map((a) => a.assetCode)),
            method: input.method ?? category.defaultMethod,
            usefulLifeMonths: input.usefulLifeMonths ?? category.defaultUsefulLifeMonths,
            status: 'draft',
            // Register balances always start empty — they are built by postings.
            originalCost: 0,
            aucBalance: 0,
            accumulatedDepreciation: 0,
            impairmentBalance: 0,
            revaluationSurplusBalance: 0,
          };
          if (assets.some((a) => a.assetCode === asset.assetCode)) {
            return { ok: false, error: `Asset code "${asset.assetCode}" already exists.` };
          }
          set({ assets: [...assets, asset], auditTrail: [...get().auditTrail, makeAudit('asset-created', `Asset ${asset.assetCode} — ${asset.name} created (draft).`)] });
          return { ok: true, id: asset.id };
        },

        updateAsset: (id, patch) => {
          const p = perm('fa.edit_draft');
          if (!p.ok) return p;
          const asset = get().assets.find((a) => a.id === id);
          if (!asset) return { ok: false, error: 'Asset not found.' };
          if (asset.status !== 'draft' && asset.status !== 'pending_approval') {
            // Non-financial fields move via transferAsset; financial fields are immutable after posting.
            return { ok: false, error: 'Only draft assets can be edited. Use transfers, impairment, revaluation or disposal for posted assets.' };
          }
          const dims = validateDims(patch.costCenterId ?? asset.costCenterId, patch.projectId ?? asset.projectId);
          if (dims) return { ok: false, error: dims };
          const now = nowIso();
          set({
            assets: get().assets.map((a) => (a.id === id ? { ...a, ...patch, id, status: a.status, updatedAt: now, updatedBy: auditActor() } : a)),
            auditTrail: [...get().auditTrail, makeAudit('asset-updated', `Asset ${asset.assetCode} updated.`)],
          });
          return { ok: true, id };
        },

        submitAsset: (id) => {
          const asset = get().assets.find((a) => a.id === id);
          if (!asset) return { ok: false, error: 'Asset not found.' };
          if (asset.status !== 'draft') return { ok: false, error: 'Only draft assets can be submitted for approval.' };
          set({
            assets: get().assets.map((a) => (a.id === id ? { ...a, status: 'pending_approval', updatedAt: nowIso() } : a)),
            auditTrail: [...get().auditTrail, makeAudit('asset-submitted', `Asset ${asset.assetCode} submitted for approval.`)],
          });
          return { ok: true, id };
        },

        cancelAsset: (id, reason) => {
          const asset = get().assets.find((a) => a.id === id);
          if (!asset) return { ok: false, error: 'Asset not found.' };
          if (asset.status !== 'draft' && asset.status !== 'pending_approval') {
            return { ok: false, error: 'Only draft or pending assets can be cancelled. Posted assets must be disposed or written off.' };
          }
          set({
            assets: get().assets.map((a) => (a.id === id ? { ...a, status: 'cancelled', notes: reason ? `${a.notes}\nCancelled: ${reason}`.trim() : a.notes, updatedAt: nowIso() } : a)),
            auditTrail: [...get().auditTrail, makeAudit('asset-cancelled', `Asset ${asset.assetCode} cancelled${reason ? `: ${reason}` : ''}.`)],
          });
          return { ok: true, id };
        },

        setAssetStatus: (id, status, reason) => {
          const p = perm('fa.edit_draft');
          if (!p.ok) return p;
          const asset = get().assets.find((a) => a.id === id);
          if (!asset) return { ok: false, error: 'Asset not found.' };
          const allowedFrom: FixedAssetStatus[] = ['active', 'impaired', 'suspended', 'held_for_sale', 'fully_depreciated'];
          if (!allowedFrom.includes(asset.status)) return { ok: false, error: `Cannot change status of a ${asset.status} asset.` };
          set({
            assets: get().assets.map((a) => (a.id === id ? { ...a, status, updatedAt: nowIso() } : a)),
            auditTrail: [...get().auditTrail, makeAudit('asset-updated', `Asset ${asset.assetCode} status → ${status}${reason ? ` (${reason})` : ''}.`)],
          });
          return { ok: true, id };
        },

        /* ── Acquisition & capitalization ────────────────────────────────── */

        postAcquisition: (input) => {
          const p = perm('fa.post_journals');
          if (!p.ok) return p;
          const g = postingGuard(input.date);
          if (!g.ok) return g;
          const asset = get().assets.find((a) => a.id === input.assetId);
          if (!asset) return { ok: false, error: 'Asset not found.' };
          if (asset.status !== 'draft' && asset.status !== 'pending_approval') {
            return { ok: false, error: 'Acquisitions can only be posted against a draft asset.' };
          }
          const type: FixedAssetTransactionType = input.funding === 'auc' ? 'auc_acquisition' : 'acquisition';
          const appr = approvalGuard(type, input.approvedBy);
          if (!appr.ok) return appr;
          const category = get().categories.find((c) => c.id === asset.categoryId);
          if (!category) return { ok: false, error: 'The asset category no longer exists.' };
          const dims = validateDims(asset.costCenterId, asset.projectId);
          if (dims) return { ok: false, error: dims };

          const recoverableTax = round2(input.recoverableTax ?? 0);
          // Non-recoverable tax and directly attributable costs are capitalized.
          const cost = round2(input.baseCost + (input.nonRecoverableTax ?? 0) + (input.otherCapitalizedCosts ?? 0));
          const toAuc = input.funding === 'auc';
          const plan = buildAcquisitionVoucher({
            category,
            assetName: asset.name,
            cost,
            recoverableTax,
            creditAccountId: input.creditAccountId,
            toAuc,
            dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined },
            taxCode: input.taxCode,
          });

          const before: Partial<FixedAsset> = {
            status: asset.status, originalCost: asset.originalCost, aucBalance: asset.aucBalance,
            recoverableTax: asset.recoverableTax, nonRecoverableTax: asset.nonRecoverableTax,
            capitalizationDate: asset.capitalizationDate, depreciationStartDate: asset.depreciationStartDate,
            supplierId: asset.supplierId, supplierName: asset.supplierName, purchaseInvoiceRef: asset.purchaseInvoiceRef,
          };
          const applyAfter = (a: FixedAsset): FixedAsset =>
            toAuc
              ? { ...a, aucBalance: round2(a.aucBalance + cost), recoverableTax: round2(a.recoverableTax + recoverableTax), nonRecoverableTax: round2(a.nonRecoverableTax + (input.nonRecoverableTax ?? 0)), supplierId: input.supplierId ?? a.supplierId, supplierName: input.supplierName ?? a.supplierName, purchaseInvoiceRef: input.invoiceRef ?? a.purchaseInvoiceRef }
              : {
                  ...a,
                  status: 'active',
                  originalCost: round2(a.originalCost + cost),
                  recoverableTax: round2(a.recoverableTax + recoverableTax),
                  nonRecoverableTax: round2(a.nonRecoverableTax + (input.nonRecoverableTax ?? 0)),
                  acquisitionDate: a.acquisitionDate || input.date,
                  capitalizationDate: input.date,
                  depreciationStartDate: a.depreciationStartDate || input.date,
                  supplierId: input.supplierId ?? a.supplierId,
                  supplierName: input.supplierName ?? a.supplierName,
                  purchaseInvoiceRef: input.invoiceRef ?? a.purchaseInvoiceRef,
                };

          return postTransaction({
            type,
            asset,
            date: input.date,
            description: `${toAuc ? 'Asset under construction' : `Asset acquisition (${input.funding})`} — ${asset.assetCode} ${asset.name}`,
            amount: round2(cost + recoverableTax),
            plan,
            effects: [{ assetId: asset.id, before, after: {} }],
            applyAfter,
            details: { funding: input.funding, baseCost: input.baseCost, recoverableTax, nonRecoverableTax: input.nonRecoverableTax ?? 0, otherCapitalizedCosts: input.otherCapitalizedCosts ?? 0 },
            counterpartyName: input.supplierName ?? '',
            invoiceRef: input.invoiceRef ?? '',
            approvedBy: input.approvedBy,
            attachments: input.attachments,
          });
        },

        capitalizeAsset: (input) => {
          const p = perm('fa.approve_capitalization');
          if (!p.ok) return p;
          const g = postingGuard(input.date);
          if (!g.ok) return g;
          const asset = get().assets.find((a) => a.id === input.assetId);
          if (!asset) return { ok: false, error: 'Asset not found.' };
          if (asset.aucBalance <= 0) return { ok: false, error: 'This asset has no asset-under-construction balance to capitalize.' };
          const appr = approvalGuard('capitalization', input.approvedBy);
          if (!appr.ok) return appr;
          const category = get().categories.find((c) => c.id === asset.categoryId);
          if (!category) return { ok: false, error: 'The asset category no longer exists.' };

          const amount = asset.aucBalance;
          const plan = buildCapitalizationVoucher({
            category,
            assetName: asset.name,
            amount,
            dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined },
          });
          const before: Partial<FixedAsset> = {
            status: asset.status, originalCost: asset.originalCost, aucBalance: asset.aucBalance,
            capitalizationDate: asset.capitalizationDate, depreciationStartDate: asset.depreciationStartDate,
          };
          return postTransaction({
            type: 'capitalization',
            asset,
            date: input.date,
            description: `Capitalization — ${asset.assetCode} ${asset.name}`,
            amount,
            plan,
            effects: [{ assetId: asset.id, before, after: {} }],
            applyAfter: (a) => ({
              ...a,
              status: 'active',
              originalCost: round2(a.originalCost + amount),
              aucBalance: 0,
              capitalizationDate: input.date,
              depreciationStartDate: a.depreciationStartDate || input.date,
            }),
            approvedBy: input.approvedBy,
          });
        },

        /* ── Depreciation runs ───────────────────────────────────────────── */

        postManualDepreciation: (input) => {
          const p = perm('fa.run_depreciation');
          if (!p.ok) return p;
          const g = postingGuard(input.date);
          if (!g.ok) return g;
          const asset = get().assets.find((a) => a.id === input.assetId);
          if (!asset) return { ok: false, error: 'Asset not found.' };
          if (asset.status !== 'active' && asset.status !== 'impaired') {
            return { ok: false, error: `A ${asset.status} asset cannot be depreciated.` };
          }
          const appr = approvalGuard('depreciation', input.approvedBy);
          if (!appr.ok) return appr;
          const category = get().categories.find((c) => c.id === asset.categoryId);
          if (!category) return { ok: false, error: 'The asset category no longer exists.' };

          const remaining = remainingDepreciable(asset);
          const computed = computeDepreciation({ asset, periodFrom: asset.depreciationStartDate || asset.acquisitionDate, periodTo: input.date });
          const amount = round2(input.amount !== undefined ? input.amount : computed);
          if (amount <= 0) return { ok: false, error: 'There is no depreciation to charge for this asset and date.' };
          if (amount > remaining + 0.005) {
            return { ok: false, error: `The charge (${amount.toFixed(2)}) exceeds the remaining depreciable amount (${remaining.toFixed(2)}).` };
          }
          const plan = buildDepreciationVoucher([{ category, assetName: `${asset.assetCode} ${asset.name}`, amount, dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined } }]);
          const before: Partial<FixedAsset> = {
            accumulatedDepreciation: asset.accumulatedDepreciation, depreciatedThrough: asset.depreciatedThrough, status: asset.status,
          };
          return postTransaction({
            type: 'depreciation',
            asset,
            date: input.date,
            description: `Manual depreciation — ${asset.assetCode} ${asset.name}`,
            amount,
            plan,
            effects: [{ assetId: asset.id, before, after: {} }],
            applyAfter: (a) => {
              const next: FixedAsset = { ...a, accumulatedDepreciation: round2(a.accumulatedDepreciation + amount), depreciatedThrough: input.date };
              return remainingDepreciable(next) <= 0 && next.method !== 'none' ? { ...next, status: 'fully_depreciated' } : next;
            },
            details: { manual: true, amount },
            approvedBy: input.approvedBy,
          });
        },

        previewDepreciationRun: (input) => {
          const p = perm('fa.run_depreciation');
          if (!p.ok) return p;
          if (!input.periodFrom || !input.periodTo || input.periodFrom > input.periodTo) {
            return { ok: false, error: 'Provide a valid depreciation period.' };
          }
          const scope: DepreciationRunScope = {
            companyId: input.scope?.companyId ?? '', branch: input.scope?.branch ?? '',
            costCenterId: input.scope?.costCenterId ?? '', projectId: input.scope?.projectId ?? '',
            categoryId: input.scope?.categoryId ?? '', assetIds: input.scope?.assetIds ?? [],
          };
          const inScope = get().assets.filter((a) =>
            (a.status === 'active' || a.status === 'impaired') &&
            (!scope.companyId || a.companyId === scope.companyId) &&
            (!scope.branch || a.branch === scope.branch) &&
            (!scope.costCenterId || a.costCenterId === scope.costCenterId) &&
            (!scope.projectId || a.projectId === scope.projectId) &&
            (!scope.categoryId || a.categoryId === scope.categoryId) &&
            (scope.assetIds.length === 0 || scope.assetIds.includes(a.id)),
          );
          const lines: DepreciationRunLine[] = [];
          for (const a of inScope) {
            const unitsUsed = input.unitsUsedByAsset?.[a.id] ?? 0;
            const amount = computeDepreciation({ asset: a, periodFrom: input.periodFrom, periodTo: input.periodTo, unitsUsed });
            if (amount <= 0) continue;
            const nbvBefore = netBookValue(a);
            lines.push({
              assetId: a.id, assetCode: a.assetCode, assetName: a.name, categoryId: a.categoryId,
              amount, unitsUsed, nbvBefore, nbvAfter: round2(nbvBefore - amount),
              before: {
                accumulatedDepreciation: a.accumulatedDepreciation, depreciatedThrough: a.depreciatedThrough,
                unitsDepreciated: a.unitsDepreciated, status: a.status,
              },
            });
          }
          const { runs } = get();
          const run: DepreciationRun = {
            id: generateId('farun'),
            number: nextSeq('DR', runs.map((r) => r.number)),
            periodFrom: input.periodFrom,
            periodTo: input.periodTo,
            frequency: input.frequency ?? get().settings.defaultFrequency,
            scope,
            lines,
            total: round2(lines.reduce((s, l) => s + l.amount, 0)),
            status: 'preview',
            journalEntryId: '', journalEntryNumber: '', reversalJournalEntryId: '',
            createdAt: nowIso(), createdBy: auditActor(),
            approvedBy: '', postedAt: '', postedBy: '', reversedAt: '', reversedBy: '', reversalReason: '',
          };
          set({ runs: [...runs, run], auditTrail: [...get().auditTrail, makeAudit('depreciation-previewed', `${run.number} previewed: ${lines.length} asset(s), total ${run.total}.`)] });
          return { ok: true, id: run.id };
        },

        approveDepreciationRun: (runId, approvedBy) => {
          const p = perm('fa.approve_depreciation');
          if (!p.ok) return p;
          const run = get().runs.find((r) => r.id === runId);
          if (!run) return { ok: false, error: 'Depreciation run not found.' };
          if (run.status !== 'preview') return { ok: false, error: `Only a preview run can be approved (this one is ${run.status}).` };
          set({
            runs: get().runs.map((r) => (r.id === runId ? { ...r, status: 'approved', approvedBy: approvedBy?.trim() || auditActor() } : r)),
            auditTrail: [...get().auditTrail, makeAudit('depreciation-approved', `${run.number} approved.`)],
          });
          return { ok: true, id: runId };
        },

        postDepreciationRun: (runId) => {
          const p = perm('fa.run_depreciation');
          if (!p.ok) return p;
          const run = get().runs.find((r) => r.id === runId);
          if (!run) return { ok: false, error: 'Depreciation run not found.' };
          if (run.status === 'posted') return { ok: false, error: `${run.number} is already posted — a run can only post once.` };
          if (run.status === 'reversed') return { ok: false, error: 'A reversed run cannot be posted again. Create a new run.' };
          if (get().settings.approvalRequired.depreciation && run.status !== 'approved') {
            return { ok: false, error: 'This depreciation run requires approval before posting.' };
          }
          const g = postingGuard(run.periodTo);
          if (!g.ok) return g;
          if (run.lines.length === 0) return { ok: false, error: 'The run has no depreciation lines.' };

          // Validate against the CURRENT register: a stale preview must not post.
          const { assets, categories } = get();
          for (const l of run.lines) {
            const a = assets.find((x) => x.id === l.assetId);
            if (!a) return { ok: false, error: `Asset ${l.assetCode} no longer exists — re-preview the run.` };
            if (Math.abs(netBookValue(a) - l.nbvBefore) > 0.005) {
              return { ok: false, error: `Asset ${l.assetCode} changed since the preview — re-preview the run.` };
            }
            if (l.amount > remainingDepreciable(a) + 0.005) {
              return { ok: false, error: `Depreciation for ${l.assetCode} exceeds its remaining depreciable amount — re-preview the run.` };
            }
          }
          const voucher = buildDepreciationVoucher(
            run.lines.map((l) => {
              const a = assets.find((x) => x.id === l.assetId)!;
              const category = categories.find((c) => c.id === l.categoryId)!;
              return { category, assetName: `${l.assetCode} ${l.assetName}`, amount: l.amount, dims: { costCenter: a.costCenterId || undefined, project: a.projectId || undefined } };
            }),
          );
          if (!voucher.ok) return { ok: false, error: voucher.error };

          const res = useJournalStore.getState().insertPostedEntry({
            entryDate: run.periodTo,
            reference: `FA:${run.number}`,
            description: `Depreciation run ${run.number} (${run.periodFrom} → ${run.periodTo})`,
            currency: baseCurrency(),
            exchangeRate: 1,
            transactionType: 'Fixed Assets',
            notes: `Source: Fixed Assets · depreciation run ${run.number}`,
            lines: voucher.lines,
          });
          if (!res.ok || !res.id) return { ok: false, error: res.error ?? 'Journal posting failed.' };
          const entryNumber = useJournalStore.getState().entries.find((e) => e.id === res.id)?.entryNumber ?? '';

          const now = nowIso();
          set({
            assets: get().assets.map((a) => {
              const l = run.lines.find((x) => x.assetId === a.id);
              if (!l) return a;
              const accum = round2(a.accumulatedDepreciation + l.amount);
              const next: FixedAsset = {
                ...a,
                accumulatedDepreciation: accum,
                depreciatedThrough: run.periodTo,
                unitsDepreciated: a.unitsDepreciated + l.unitsUsed,
                updatedAt: now,
              };
              return remainingDepreciable(next) <= 0 && next.method !== 'none' ? { ...next, status: 'fully_depreciated' } : next;
            }),
            runs: get().runs.map((r) => (r.id === runId ? { ...r, status: 'posted', journalEntryId: res.id!, journalEntryNumber: entryNumber, postedAt: now, postedBy: auditActor() } : r)),
            auditTrail: [...get().auditTrail, makeAudit('depreciation-posted', `${run.number} posted (${entryNumber}, total ${run.total}).`)],
          });
          return { ok: true, id: runId, journalEntryId: res.id };
        },

        reverseDepreciationRun: (runId, reason) => {
          const p = perm('fa.reverse');
          if (!p.ok) return p;
          if (!reason.trim()) return { ok: false, error: 'A documented reason is required to reverse a depreciation run.' };
          const run = get().runs.find((r) => r.id === runId);
          if (!run) return { ok: false, error: 'Depreciation run not found.' };
          if (run.status !== 'posted') return { ok: false, error: 'Only a posted run can be reversed.' };
          const original = useJournalStore.getState().entries.find((e) => e.id === run.journalEntryId);
          if (!original) return { ok: false, error: 'The original voucher could not be found.' };

          const res = useJournalStore.getState().insertPostedEntry({
            entryDate: nowIso().slice(0, 10),
            reference: `FA:REV:${run.number}`,
            description: `Reversal of depreciation run ${run.number}: ${reason}`,
            currency: original.currency,
            exchangeRate: original.exchangeRate,
            transactionType: 'Fixed Assets',
            notes: `Reversal of ${original.entryNumber} (${run.number}).`,
            lines: original.lines.map((l) => ({
              accountId: l.accountId, debit: l.credit, credit: l.debit, description: `Reversal — ${l.description}`,
              costCenter: l.costCenter || undefined, project: l.project || undefined,
            })),
          });
          if (!res.ok || !res.id) return { ok: false, error: res.error ?? 'Reversal posting failed.' };

          const now = nowIso();
          set({
            assets: get().assets.map((a) => {
              const l = run.lines.find((x) => x.assetId === a.id);
              return l ? { ...a, ...l.before, updatedAt: now } : a;
            }),
            runs: get().runs.map((r) => (r.id === runId ? { ...r, status: 'reversed', reversalJournalEntryId: res.id!, reversedAt: now, reversedBy: auditActor(), reversalReason: reason } : r)),
            auditTrail: [...get().auditTrail, makeAudit('depreciation-reversed', `${run.number} reversed: ${reason}.`)],
          });
          return { ok: true, id: runId, journalEntryId: res.id };
        },

        /* ── Transfers ───────────────────────────────────────────────────── */

        transferAsset: (input) => {
          const p = perm('fa.transfer');
          if (!p.ok) return p;
          const asset = get().assets.find((a) => a.id === input.assetId);
          if (!asset) return { ok: false, error: 'Asset not found.' };
          if (asset.status === 'disposed' || asset.status === 'cancelled') return { ok: false, error: `A ${asset.status} asset cannot be transferred.` };
          const appr = approvalGuard('transfer', input.approvedBy);
          if (!appr.ok) return appr;
          const dims = validateDims(input.changes.costCenterId ?? asset.costCenterId, input.changes.projectId ?? asset.projectId);
          if (dims) return { ok: false, error: dims };
          const keys = Object.keys(input.changes) as Array<keyof typeof input.changes>;
          if (keys.length === 0) return { ok: false, error: 'Nothing to transfer — choose at least one new dimension.' };

          const before: Partial<FixedAsset> = {};
          for (const k of keys) (before as Record<string, unknown>)[k] = asset[k];
          // Same-legal-entity transfer: dimensions move, NO gain/loss, NO voucher.
          return postTransaction({
            type: 'transfer',
            asset,
            date: input.date,
            description: `Transfer — ${asset.assetCode} ${asset.name} (${keys.join(', ')})`,
            amount: 0,
            plan: null,
            effects: [{ assetId: asset.id, before, after: { ...input.changes } }],
            applyAfter: (a) => ({ ...a, ...input.changes }),
            details: Object.fromEntries(keys.map((k) => [`new_${k}`, String(input.changes[k] ?? '')])),
            reason: input.reason,
            approvedBy: input.approvedBy,
          });
        },

        intercompanyTransfer: (input) => {
          const p = perm('fa.transfer');
          if (!p.ok) return p;
          const g = postingGuard(input.date);
          if (!g.ok) return g;
          const { settings } = get();
          if (!settings.allowIntercompanyTransfers) {
            return { ok: false, error: 'Intercompany transfers are not enabled. They require due-to/due-from intercompany accounts and must not be treated as an internal location change.' };
          }
          const asset = get().assets.find((a) => a.id === input.assetId);
          if (!asset) return { ok: false, error: 'Asset not found.' };
          if (asset.status === 'disposed' || asset.status === 'cancelled' || asset.status === 'draft') {
            return { ok: false, error: `A ${asset.status} asset cannot be transferred intercompany.` };
          }
          const appr = approvalGuard('intercompany_transfer', input.approvedBy);
          if (!appr.ok) return appr;
          const category = get().categories.find((c) => c.id === asset.categoryId);
          if (!category) return { ok: false, error: 'The asset category no longer exists.' };
          const plan = buildIntercompanyTransferVoucher({
            category,
            assetName: `${asset.assetCode} ${asset.name}`,
            asset,
            dueFromAccountId: settings.intercompanyDueFromAccountId,
            dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined },
          });
          const before: Partial<FixedAsset> = {
            status: asset.status, originalCost: asset.originalCost,
            accumulatedDepreciation: asset.accumulatedDepreciation, impairmentBalance: asset.impairmentBalance,
            disposalDate: asset.disposalDate, disposalGainLoss: asset.disposalGainLoss,
          };
          return postTransaction({
            type: 'intercompany_transfer',
            asset,
            date: input.date,
            description: `Intercompany transfer to ${input.targetCompany} — ${asset.assetCode} ${asset.name}`,
            amount: netBookValue(asset),
            plan,
            effects: [{ assetId: asset.id, before, after: {} }],
            applyAfter: (a) => ({
              ...a, status: 'disposed', originalCost: 0, accumulatedDepreciation: 0, impairmentBalance: 0,
              disposalDate: input.date, disposalGainLoss: 0,
            }),
            details: { targetCompany: input.targetCompany, carryingAmount: netBookValue(asset) },
            reason: input.reason,
            approvedBy: input.approvedBy,
          });
        },

        /* ── Impairment ──────────────────────────────────────────────────── */

        impairAsset: (input) => {
          const p = perm('fa.impair');
          if (!p.ok) return p;
          const g = postingGuard(input.date);
          if (!g.ok) return g;
          const asset = get().assets.find((a) => a.id === input.assetId);
          if (!asset) return { ok: false, error: 'Asset not found.' };
          if (asset.status !== 'active' && asset.status !== 'impaired' && asset.status !== 'held_for_sale') {
            return { ok: false, error: `A ${asset.status} asset cannot be impaired.` };
          }
          if (!input.reason.trim()) return { ok: false, error: 'A documented reason is required for impairment.' };
          const appr = approvalGuard('impairment', input.approvedBy);
          if (!appr.ok) return appr;
          const category = get().categories.find((c) => c.id === asset.categoryId);
          if (!category) return { ok: false, error: 'The asset category no longer exists.' };
          const carryingBefore = netBookValue(asset);
          const amount = round2(carryingBefore - input.recoverableAmount);
          if (amount <= 0) return { ok: false, error: 'Recoverable amount is not below the carrying amount — no impairment to record.' };

          const plan = buildImpairmentVoucher({ category, assetName: `${asset.assetCode} ${asset.name}`, amount, dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined } });
          const before: Partial<FixedAsset> = { status: asset.status, impairmentBalance: asset.impairmentBalance };
          return postTransaction({
            type: 'impairment',
            asset,
            date: input.date,
            description: `Impairment — ${asset.assetCode} ${asset.name}`,
            amount,
            plan,
            effects: [{ assetId: asset.id, before, after: {} }],
            applyAfter: (a) => ({ ...a, impairmentBalance: round2(a.impairmentBalance + amount), status: 'impaired' }),
            details: { carryingAmountBefore: carryingBefore, recoverableAmount: input.recoverableAmount, impairmentAmount: amount },
            reason: input.reason,
            approvedBy: input.approvedBy,
            attachments: input.attachments,
          });
        },

        reverseImpairment: (input) => {
          const p = perm('fa.impair');
          if (!p.ok) return p;
          const g = postingGuard(input.date);
          if (!g.ok) return g;
          const asset = get().assets.find((a) => a.id === input.assetId);
          if (!asset) return { ok: false, error: 'Asset not found.' };
          if (!input.reason.trim()) return { ok: false, error: 'A documented reason is required for an impairment reversal.' };
          const appr = approvalGuard('impairment_reversal', input.approvedBy);
          if (!appr.ok) return appr;
          const amount = round2(Math.min(input.amount, asset.impairmentBalance));
          if (amount <= 0) return { ok: false, error: 'This asset has no impairment balance to reverse.' };
          const category = get().categories.find((c) => c.id === asset.categoryId);
          if (!category) return { ok: false, error: 'The asset category no longer exists.' };

          const plan = buildImpairmentReversalVoucher({ category, assetName: `${asset.assetCode} ${asset.name}`, amount, dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined } });
          const before: Partial<FixedAsset> = { status: asset.status, impairmentBalance: asset.impairmentBalance };
          return postTransaction({
            type: 'impairment_reversal',
            asset,
            date: input.date,
            description: `Impairment reversal — ${asset.assetCode} ${asset.name}`,
            amount,
            plan,
            effects: [{ assetId: asset.id, before, after: {} }],
            applyAfter: (a) => {
              const balance = round2(a.impairmentBalance - amount);
              return { ...a, impairmentBalance: balance, status: balance <= 0 && a.status === 'impaired' ? 'active' : a.status };
            },
            details: { reversalAmount: amount, impairmentBalanceBefore: asset.impairmentBalance },
            reason: input.reason,
            approvedBy: input.approvedBy,
          });
        },

        /* ── Revaluation ─────────────────────────────────────────────────── */

        revalueAsset: (input) => {
          const p = perm('fa.revalue');
          if (!p.ok) return p;
          const g = postingGuard(input.date);
          if (!g.ok) return g;
          const asset = get().assets.find((a) => a.id === input.assetId);
          if (!asset) return { ok: false, error: 'Asset not found.' };
          if (asset.status !== 'active' && asset.status !== 'impaired' && asset.status !== 'fully_depreciated') {
            return { ok: false, error: `A ${asset.status} asset cannot be revalued.` };
          }
          if (!input.reason.trim()) return { ok: false, error: 'A documented reason (valuation basis) is required for revaluation.' };
          const appr = approvalGuard('revaluation', input.approvedBy);
          if (!appr.ok) return appr;
          const category = get().categories.find((c) => c.id === asset.categoryId);
          if (!category) return { ok: false, error: 'The asset category no longer exists.' };

          const priorCarrying = netBookValue(asset);
          const delta = round2(input.revaluedAmount - priorCarrying);
          const plan = buildRevaluationVoucher({ category, assetName: `${asset.assetCode} ${asset.name}`, asset, revaluedAmount: input.revaluedAmount, dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined } });
          const before: Partial<FixedAsset> = {
            status: asset.status, originalCost: asset.originalCost,
            accumulatedDepreciation: asset.accumulatedDepreciation, impairmentBalance: asset.impairmentBalance,
            revaluationSurplusBalance: asset.revaluationSurplusBalance, depreciatedThrough: asset.depreciatedThrough,
          };
          return postTransaction({
            type: 'revaluation',
            asset,
            date: input.date,
            description: `Revaluation — ${asset.assetCode} ${asset.name}`,
            amount: Math.abs(delta),
            plan,
            effects: [{ assetId: asset.id, before, after: {} }],
            applyAfter: (a) => ({
              ...a,
              originalCost: round2(input.revaluedAmount),
              accumulatedDepreciation: 0,
              impairmentBalance: 0,
              revaluationSurplusBalance: round2(a.revaluationSurplusBalance + Math.max(0, delta)),
              status: a.status === 'fully_depreciated' && delta > 0 ? 'active' : a.status,
            }),
            details: { priorCarryingAmount: priorCarrying, revaluedAmount: input.revaluedAmount, revaluationDelta: delta },
            reason: input.reason,
            approvedBy: input.approvedBy,
            attachments: input.attachments,
          });
        },

        /* ── Disposal ────────────────────────────────────────────────────── */

        disposeAsset: (input) => {
          const p = perm('fa.dispose');
          if (!p.ok) return p;
          const g = postingGuard(input.date);
          if (!g.ok) return g;
          const found = get().assets.find((a) => a.id === input.assetId);
          if (!found) return { ok: false, error: 'Asset not found.' };
          let asset: FixedAsset = found;
          const disposable: FixedAssetStatus[] = ['active', 'impaired', 'fully_depreciated', 'held_for_sale', 'suspended'];
          if (!disposable.includes(asset.status)) return { ok: false, error: `A ${asset.status} asset cannot be disposed.` };
          if (input.date < asset.acquisitionDate) {
            return { ok: false, error: 'The disposal date cannot precede the acquisition date.' };
          }
          const appr = approvalGuard('disposal', input.approvedBy);
          if (!appr.ok) return appr;
          const category = get().categories.find((c) => c.id === asset.categoryId);
          if (!category) return { ok: false, error: 'The asset category no longer exists.' };

          // Depreciation must be brought up to the disposal date first — unless
          // an authorized user overrides it with a documented reason.
          const pending = computeDepreciation({ asset, periodFrom: asset.depreciationStartDate || asset.acquisitionDate, periodTo: input.date, unitsUsed: 0 });
          if (pending > 0.005) {
            if (input.catchUpDepreciation) {
              const catchBefore: Partial<FixedAsset> = {
                accumulatedDepreciation: asset.accumulatedDepreciation, depreciatedThrough: asset.depreciatedThrough, status: asset.status,
              };
              const catchPlan = buildDepreciationVoucher([{ category, assetName: `${asset.assetCode} ${asset.name}`, amount: pending, dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined } }]);
              const catchRes = postTransaction({
                type: 'depreciation',
                asset,
                date: input.date,
                description: `Catch-up depreciation to disposal date — ${asset.assetCode} ${asset.name}`,
                amount: pending,
                plan: catchPlan,
                effects: [{ assetId: asset.id, before: catchBefore, after: {} }],
                applyAfter: (a) => ({ ...a, accumulatedDepreciation: round2(a.accumulatedDepreciation + pending), depreciatedThrough: input.date }),
                details: { catchUpForDisposal: true, amount: pending },
                approvedBy: input.approvedBy,
              });
              if (!catchRes.ok) return catchRes;
              asset = get().assets.find((a) => a.id === input.assetId)!;
            } else if (!input.depreciationOverrideReason?.trim()) {
              return { ok: false, error: `Depreciation of ${pending.toFixed(2)} is pending up to the disposal date. Post catch-up depreciation, or override with a documented reason.` };
            }
          }

          const portion: DisposalPortion = input.portion ?? { kind: 'full' };
          const pf = portionFraction(asset, portion);
          if (!pf.ok) return { ok: false, error: pf.error };
          const computation = computeDisposal(asset, pf.fraction, input.proceeds, input.disposalCosts ?? 0);
          const plan = buildDisposalVoucher({
            category,
            assetName: `${asset.assetCode} ${asset.name}`,
            computation,
            proceeds: input.proceeds,
            disposalCosts: input.disposalCosts ?? 0,
            outputTax: input.outputTax ?? 0,
            outputTaxAccountId: input.outputTaxAccountId ?? '',
            receiptAccountId: input.receiptAccountId ?? '',
            dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined },
            taxCode: input.taxCode,
          });

          const full = pf.fraction >= 0.999999;
          const before: Partial<FixedAsset> = {
            status: asset.status, originalCost: asset.originalCost,
            accumulatedDepreciation: asset.accumulatedDepreciation, impairmentBalance: asset.impairmentBalance,
            quantity: asset.quantity, disposalDate: asset.disposalDate,
            disposalProceeds: asset.disposalProceeds, disposalGainLoss: asset.disposalGainLoss,
          };
          return postTransaction({
            type: full ? 'disposal' : 'partial_disposal',
            asset,
            date: input.date,
            description: `${full ? 'Disposal' : `Partial disposal (${(pf.fraction * 100).toFixed(2)}%)`} — ${asset.assetCode} ${asset.name}`,
            amount: computation.netProceeds,
            plan,
            effects: [{ assetId: asset.id, before, after: {} }],
            applyAfter: (a) => full
              ? {
                  ...a, status: 'disposed', originalCost: 0, accumulatedDepreciation: 0, impairmentBalance: 0,
                  disposalDate: input.date,
                  disposalProceeds: round2(a.disposalProceeds + input.proceeds),
                  disposalGainLoss: round2(a.disposalGainLoss + computation.gainLoss),
                }
              : {
                  ...a,
                  originalCost: round2(a.originalCost - computation.costPortion),
                  accumulatedDepreciation: round2(a.accumulatedDepreciation - computation.accumDepPortion),
                  impairmentBalance: round2(a.impairmentBalance - computation.impairmentPortion),
                  quantity: portion.kind === 'units' ? a.quantity - portion.value : a.quantity,
                  disposalProceeds: round2(a.disposalProceeds + input.proceeds),
                  disposalGainLoss: round2(a.disposalGainLoss + computation.gainLoss),
                },
            details: {
              fraction: pf.fraction, proceeds: input.proceeds, disposalCosts: input.disposalCosts ?? 0,
              outputTax: input.outputTax ?? 0, gainLoss: computation.gainLoss, nbvDisposed: computation.nbvPortion,
              ...(input.depreciationOverrideReason ? { depreciationOverrideReason: input.depreciationOverrideReason } : {}),
            },
            counterpartyName: input.buyerName ?? '',
            invoiceRef: input.invoiceRef ?? '',
            reason: input.reason,
            approvedBy: input.approvedBy,
            attachments: input.attachments,
          });
        },

        /* ── Reversal & correction ───────────────────────────────────────── */

        reverseTransaction: (transactionId, reason, approvedBy) => {
          const p = perm('fa.reverse');
          if (!p.ok) return p;
          if (!reason.trim()) return { ok: false, error: 'A documented reason is required for a reversal.' };
          const appr = approvalGuard('reversal', approvedBy);
          if (!appr.ok) return appr;
          const txn = get().transactions.find((t) => t.id === transactionId);
          if (!txn) return { ok: false, error: 'Transaction not found.' };
          if (txn.status === 'reversed') return { ok: false, error: `${txn.number} has already been reversed.` };
          if (txn.type === 'reversal') return { ok: false, error: 'A reversal voucher cannot itself be reversed — post a new transaction instead.' };
          // Snapshot restoration is only exact for the asset's LATEST posting.
          const later = get().transactions.find((t) => t.assetId === txn.assetId && t.status === 'posted' && t.type !== 'reversal' && t.createdAt > txn.createdAt);
          if (later) return { ok: false, error: `Reverse ${later.number} first — reversals must unwind in order (latest transaction first).` };
          const asset = get().assets.find((a) => a.id === txn.assetId);
          if (!asset) return { ok: false, error: 'The transaction asset no longer exists.' };

          let journalEntryId = '';
          let journalEntryNumber = '';
          if (txn.journalEntryId) {
            const original = useJournalStore.getState().entries.find((e) => e.id === txn.journalEntryId);
            if (!original) return { ok: false, error: 'The original voucher could not be found.' };
            const res = useJournalStore.getState().insertPostedEntry({
              entryDate: nowIso().slice(0, 10),
              reference: `FA:REV:${txn.number}`,
              description: `Reversal of ${txn.number}: ${reason}`,
              currency: original.currency,
              exchangeRate: original.exchangeRate,
              transactionType: 'Fixed Assets',
              notes: `Reversal of voucher ${original.entryNumber} (source ${txn.number}). Original preserved.`,
              lines: original.lines.map((l) => ({
                accountId: l.accountId, debit: l.credit, credit: l.debit, description: `Reversal — ${l.description}`,
                costCenter: l.costCenter || undefined, project: l.project || undefined,
              })),
            });
            if (!res.ok || !res.id) return { ok: false, error: res.error ?? 'Reversal posting failed.' };
            journalEntryId = res.id;
            journalEntryNumber = useJournalStore.getState().entries.find((e) => e.id === res.id)?.entryNumber ?? '';
          }

          const now = nowIso();
          const reversal: FixedAssetTransaction = {
            id: generateId('fatx'),
            number: nextSeq('FA', get().transactions.map((t) => t.number)),
            type: 'reversal',
            status: 'posted',
            assetId: txn.assetId,
            assetCode: txn.assetCode,
            date: now.slice(0, 10),
            postingDate: now.slice(0, 10),
            description: `Reversal of ${txn.number} — ${txn.description}`,
            counterpartyName: txn.counterpartyName,
            invoiceRef: txn.invoiceRef,
            amount: txn.amount,
            currency: txn.currency,
            exchangeRate: txn.exchangeRate,
            journalEntryId,
            journalEntryNumber,
            reversalOfTransactionId: txn.id,
            reversedByTransactionId: '',
            details: { reversedType: txn.type },
            effects: [],
            reason,
            attachments: [],
            createdAt: now,
            createdBy: auditActor(),
            approvedBy: approvedBy ?? '',
            postedBy: auditActor(),
          };
          set({
            // Restore the register exactly as it was before the original posting.
            assets: get().assets.map((a) => {
              const eff = txn.effects.find((e) => e.assetId === a.id);
              return eff ? { ...a, ...eff.before, updatedAt: now, updatedBy: auditActor() } : a;
            }),
            transactions: [
              ...get().transactions.map((t) => (t.id === txn.id ? { ...t, status: 'reversed' as const, reversedByTransactionId: reversal.id } : t)),
              reversal,
            ],
            auditTrail: [...get().auditTrail, makeAudit('transaction-reversed', `${txn.number} reversed by ${reversal.number}: ${reason}.`)],
          });
          return { ok: true, id: reversal.id, transactionId: reversal.id, journalEntryId };
        },

        resetToDefault: () => set({ ...EMPTY_STATE, settings: { ...DEFAULT_SETTINGS, approvalRequired: { ...DEFAULT_SETTINGS.approvalRequired } } }),
      };
    },
    {
      name: 'ledgora-fixed-assets',
      storage: businessJSONStorage,
      version: 1,
      partialize: (s) => ({
        settings: s.settings, categories: s.categories, assets: s.assets,
        transactions: s.transactions, runs: s.runs, auditTrail: s.auditTrail, seeded: s.seeded,
      }),
    },
  ),
);

/**
 * Whether the active organization is entitled to fixed assets. Deliberately the
 * REAL entitlement — never the operator full-access override — for data-writing
 * integrations (seeding), mirroring inventory/manufacturing.
 */
export function fixedAssetsEnabled(): boolean {
  return useEntitlementStore.getState().effectiveModuleIds.includes('fixed_assets');
}
