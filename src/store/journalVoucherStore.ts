/**
 * Universal Journal Voucher store — the source-document workflow over the
 * existing General Journal.
 *
 * ── One engine, one ledger ────────────────────────────────────────────────────
 * Posting a voucher builds ONE balanced entry through
 * `journalStore.insertPostedEntry` (the same seam Inventory, Manufacturing and
 * Fixed Assets use). Asset-linked voucher kinds DELEGATE to the Fixed Assets
 * store's posting actions, so the subledger and the ledger always move
 * together and duplicate capitalization is structurally impossible. This store
 * never becomes a second ledger and never edits a posted journal entry.
 *
 * ── Duplicate / idempotency protection ────────────────────────────────────────
 * A voucher may carry `sourceModule` + `sourceTransactionId`. The pair forms a
 * unique source key: once any posted voucher has consumed it, a second posting
 * is refused and the existing journal number is reported. Posting a voucher
 * twice is likewise impossible (status check inside the same synchronous
 * update).
 *
 * ── Browser-storage honesty ───────────────────────────────────────────────────
 * Today the voucher, the journal entry, the asset record and the audit trail
 * live in SEPARATE persisted browser stores. The posting sequence is ordered
 * so the journal entry is written first and the voucher only records success —
 * but this is NOT database atomicity. A production backend must commit the
 * voucher, journal entry, subledger updates, idempotency record and audit
 * record in ONE PostgreSQL transaction; these client checks then remain as UX
 * affordances over server-enforced authentication, organization membership,
 * permissions, approval and posting rights.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type {
  JournalVoucher,
  JournalVoucherAuditEntry,
  JournalVoucherAuditEvent,
  JournalVoucherLine,
  JournalVoucherSettings,
  RecurringVoucherTemplate,
  VoucherAttachment,
  VoucherHistoryEvent,
  VoucherTypeConfig,
} from '@/types/journalVoucher';
import {
  activeLines,
  computeVoucherTotals,
  renumber,
  round2,
  sourceKeyOf,
  validateVoucherForPosting,
  type VoucherValidationContext,
} from '@/lib/journalVoucherValidation';
import { assertJvPermission, type JournalVoucherPermission } from '@/lib/journalVoucherPermissions';
import { makeSeedVoucherTypes } from '@/lib/journalVoucherSeed';
import { useJournalStore } from './journalStore';
import { useCurrencyStore } from './currencyStore';
import { useFixedAssetStore } from './fixedAssetStore';
import { useStore } from './useStore';
import { useCostCenterStore } from './costCenterStore';
import { useProjectStore } from './projectStore';
import { useCompanyStore } from './companyStore';
import { useOrganizationStore } from './organizationStore';
import { getCurrentUser } from './authStore';
import { isPlatformAdminFullAccess, operatorAuditContext, resolveAuditActor } from './platformFullAccess';
import { orgHasModule } from './entitlementHooks';
import { generateId, nowIso } from '@/lib/utils';

export interface JvResult {
  ok: boolean;
  error?: string;
  id?: string;
  journalEntryId?: string;
  /** For duplicate-source refusals: the journal that already exists. */
  existingJournalNumber?: string;
  /** Second voucher of an intercompany pair. */
  pairedVoucherId?: string;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const actor = (): string => resolveAuditActor('Finance Manager');

function currentRole(): 'owner' | 'admin' | 'accountant' | 'member' | 'viewer' {
  if (isPlatformAdminFullAccess()) return 'admin';
  return getCurrentUser()?.role ?? 'owner';
}

function makeAudit(event: JournalVoucherAuditEvent, detail: string): JournalVoucherAuditEntry {
  const operator = operatorAuditContext();
  return { id: generateId('jvaud'), at: nowIso(), actor: actor(), event, detail, ...(operator ? { operator } : {}) };
}

function historyEvent(action: VoucherHistoryEvent['action'], comment = ''): VoucherHistoryEvent {
  return { id: generateId('jvh'), at: nowIso(), actor: actor(), action, comment };
}

function nextNumber(prefix: string, existing: string[]): string {
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

export function makeBlankLine(): JournalVoucherLine {
  return {
    id: generateId('jvl'), lineNumber: 1, accountId: '', accountCode: '', accountName: '',
    debit: 0, credit: 0, description: '', entityId: '', bankAccountId: '', assetId: '',
    inventoryItemId: '', employee: '', relatedCompany: '', branch: '', department: '',
    costCenterId: '', projectId: '', profitCenter: '', location: '', taxCode: '', taxAmount: 0,
    dueDate: '', reference: '', attachments: [],
  };
}

export function makeBlankVoucher(type: VoucherTypeConfig): JournalVoucher {
  const now = nowIso();
  const today = now.slice(0, 10);
  return {
    id: generateId('jv'), number: '', typeId: type.id, status: 'draft',
    organizationId: useOrganizationStore.getState().organization?.id ?? '',
    companyId: useCompanyStore.getState().activeCompanyId || '',
    branch: '',
    transactionDate: today, postingDate: today, period: today.slice(0, 7), documentDate: today,
    currency: baseCurrency(), exchangeRate: 1,
    externalReference: '', internalReference: '', sourceModule: '', sourceTransactionId: '',
    description: type.defaultDescription, narration: '',
    autoReverseDate: '', templateId: '',
    lines: renumber([makeBlankLine(), makeBlankLine()]),
    journalEntryId: '', journalEntryNumber: '', assetTransactionId: '',
    reversalOfVoucherId: '', reversedByVoucherId: '', replacementVoucherId: '',
    reversalReason: '', intercompanyRef: '',
    preparedBy: actor(), reviewedBy: '', approvedBy: '', postedBy: '', rejectionComment: '',
    createdAt: now, updatedAt: now, approvedAt: '', postedAt: '',
    attachments: [], history: [historyEvent('created')],
  };
}

const DEFAULT_SETTINGS: JournalVoucherSettings = {
  postingLockDate: '',
  roundingAccountId: '',
  roundingTolerance: 0.1,
  fxGainAccountId: '',
  fxLossAccountId: '',
  openingBalancesLocked: false,
  segregationOfDuties: true,
  materialAmountThreshold: 10000,
};

export interface JournalVoucherState {
  types: VoucherTypeConfig[];
  vouchers: JournalVoucher[];
  templates: RecurringVoucherTemplate[];
  settings: JournalVoucherSettings;
  auditTrail: JournalVoucherAuditEntry[];
  seeded: boolean;

  ensureSeeded: () => void;
  updateSettings: (patch: Partial<JournalVoucherSettings>) => JvResult;
  saveType: (type: VoucherTypeConfig) => JvResult;

  saveDraft: (voucher: JournalVoucher) => JvResult;
  submitVoucher: (id: string) => JvResult;
  approveVoucher: (id: string, comment?: string) => JvResult;
  rejectVoucher: (id: string, comment: string) => JvResult;
  cancelDraft: (id: string) => JvResult;
  addAttachment: (id: string, attachment: Omit<VoucherAttachment, 'id' | 'uploadedAt' | 'uploadedBy'>) => JvResult;

  postVoucher: (id: string) => JvResult;
  reverseVoucher: (id: string, input: { reason: string; date?: string }) => JvResult;
  correctVoucher: (id: string, reason: string) => JvResult;
  copyVoucher: (id: string) => JvResult;
  /** Post automatic reversals (accruals) due on or before the given date. */
  processAutoReversals: (throughDate: string) => JvResult & { reversedCount?: number };

  saveTemplate: (template: RecurringVoucherTemplate) => JvResult;
  generateFromTemplate: (templateId: string) => JvResult;

  postIntercompanyPair: (input: {
    date: string;
    amount: number;
    currency?: string;
    exchangeRate?: number;
    description: string;
    intercompanyRef: string;
    paying: { company: string; chargeAccountId: string; dueToAccountId: string };
    receiving: { company: string; dueFromAccountId: string; creditAccountId: string };
  }) => JvResult;

  resetToDefault: () => void;
}

const EMPTY_STATE = {
  types: [] as VoucherTypeConfig[],
  vouchers: [] as JournalVoucher[],
  templates: [] as RecurringVoucherTemplate[],
  settings: DEFAULT_SETTINGS,
  auditTrail: [] as JournalVoucherAuditEntry[],
  seeded: false,
};

export const useJournalVoucherStore = create<JournalVoucherState>()(
  persist(
    (set, get) => {
      const perm = (p: JournalVoucherPermission): JvResult => {
        const r = assertJvPermission(currentRole(), p);
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      };

      const typeOf = (v: JournalVoucher): VoucherTypeConfig | undefined =>
        get().types.find((t) => t.id === v.typeId);

      /** Source keys already consumed by posted (or partially reversed) vouchers. */
      const postedSourceKeys = (excludeId?: string): Set<string> => {
        const keys = new Set<string>();
        for (const v of get().vouchers) {
          if (v.id === excludeId) continue;
          if (v.status === 'posted' || v.status === 'partially_reversed' || v.status === 'reversed') {
            const key = sourceKeyOf(v);
            if (key) keys.add(key);
          }
        }
        return keys;
      };

      const validationContext = (v: JournalVoucher): VoucherValidationContext => ({
        accounts: useStore.getState().accounts,
        baseCurrency: baseCurrency(),
        // Currency Master precision: the voucher balances at ITS currency's
        // configured decimals (JPY 0, JOD 3, BTC 8), the base check at the
        // base currency's decimals — never an assumed 2.
        precision: {
          currencyDecimals: useCurrencyStore.getState().getCurrency(v.currency)?.decimalPlaces ?? 2,
          baseCurrencyDecimals: useCurrencyStore.getState().getCurrency(baseCurrency())?.decimalPlaces ?? 2,
        },
        costCenterIds: new Set(useCostCenterStore.getState().costCenters.map((c) => c.id)),
        projectIds: new Set(useProjectStore.getState().projects.map((p) => p.id)),
        postingLockDate: get().settings.postingLockDate,
        postedSourceKeys: postedSourceKeys(v.id),
        settings: get().settings,
        type: typeOf(v),
      });

      const patchVoucher = (id: string, patch: (v: JournalVoucher) => JournalVoucher): void => {
        set({ vouchers: get().vouchers.map((v) => (v.id === id ? { ...patch(v), updatedAt: nowIso() } : v)) });
      };

      /** Snapshot the posted journal entry's lines back onto the voucher for display. */
      const linesFromJournal = (journalEntryId: string): JournalVoucherLine[] => {
        const entry = useJournalStore.getState().entries.find((e) => e.id === journalEntryId);
        if (!entry) return [];
        return entry.lines.map((l, i) => ({
          ...makeBlankLine(),
          id: generateId('jvl'), lineNumber: i + 1,
          accountId: l.accountId, accountCode: l.accountCode, accountName: l.accountName,
          debit: l.debit, credit: l.credit, description: l.description,
          costCenterId: l.costCenter, projectId: l.project, taxCode: l.taxCode, taxAmount: l.taxAmount,
        }));
      };

      /** Mark a voucher posted with its journal linkage + audit + history. */
      const markPosted = (id: string, journalEntryId: string, assetTransactionId = ''): void => {
        const entryNumber = useJournalStore.getState().entries.find((e) => e.id === journalEntryId)?.entryNumber ?? '';
        const now = nowIso();
        patchVoucher(id, (v) => ({
          ...v,
          status: 'posted',
          journalEntryId,
          journalEntryNumber: entryNumber,
          assetTransactionId,
          period: v.postingDate.slice(0, 7),
          postedBy: actor(),
          postedAt: now,
          lines: assetTransactionId ? renumber(linesFromJournal(journalEntryId)) : v.lines,
          history: [...v.history, historyEvent('posted', entryNumber)],
        }));
        const v = get().vouchers.find((x) => x.id === id)!;
        set({ auditTrail: [...get().auditTrail, makeAudit('voucher-posted', `${v.number} posted → journal ${entryNumber}.`)] });
      };

      /** Post ordinary (non-asset) voucher lines through the journal seam. */
      const postGeneral = (voucher: JournalVoucher): JvResult => {
        const lines = activeLines(voucher.lines);
        const res = useJournalStore.getState().insertPostedEntry({
          entryDate: voucher.postingDate,
          reference: `JV:${voucher.number}`,
          description: voucher.description || typeOf(voucher)?.name || 'Journal voucher',
          currency: voucher.currency,
          exchangeRate: voucher.exchangeRate,
          transactionType: 'Journal Voucher',
          notes: `Source: Journal Voucher ${voucher.number}${voucher.sourceModule ? ` · ${voucher.sourceModule}:${voucher.sourceTransactionId}` : ''}${voucher.narration ? ` · ${voucher.narration}` : ''}`,
          lines: lines.map((l) => ({
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            description: l.description,
            costCenter: l.costCenterId || undefined,
            project: l.projectId || undefined,
            taxCode: l.taxCode || undefined,
            taxAmount: l.taxAmount || undefined,
          })),
        });
        if (!res.ok || !res.id) return { ok: false, error: res.error ?? 'Journal posting failed.' };
        markPosted(voucher.id, res.id);
        return { ok: true, id: voucher.id, journalEntryId: res.id };
      };

      /** Asset-linked kinds delegate to the Fixed Assets store (one engine). */
      const postAssetKind = (voucher: JournalVoucher, kind: string): JvResult => {
        const input = voucher.assetInput;
        if (!input?.assetId) return { ok: false, error: 'Select or create the linked fixed asset first.' };
        const fa = useFixedAssetStore.getState();
        let res: { ok: boolean; error?: string; journalEntryId?: string; transactionId?: string; id?: string };
        switch (kind) {
          case 'asset_acquisition':
            res = fa.postAcquisition({
              assetId: input.assetId, date: voucher.postingDate,
              baseCost: input.baseCost ?? 0, recoverableTax: input.recoverableTax,
              nonRecoverableTax: input.nonRecoverableTax, otherCapitalizedCosts: input.otherCapitalizedCosts,
              funding: input.funding ?? 'manual', creditAccountId: input.creditAccountId ?? '',
              invoiceRef: voucher.externalReference || undefined, approvedBy: voucher.approvedBy || undefined,
            });
            break;
          case 'asset_disposal':
            res = fa.disposeAsset({
              assetId: input.assetId, date: voucher.postingDate,
              portion: input.portionPercent && input.portionPercent < 100 ? { kind: 'percentage', value: input.portionPercent } : { kind: 'full' },
              proceeds: input.proceeds ?? 0, disposalCosts: input.disposalCosts,
              outputTax: input.outputTax, outputTaxAccountId: input.outputTaxAccountId,
              receiptAccountId: input.receiptAccountId, invoiceRef: voucher.externalReference || undefined,
              reason: voucher.description, approvedBy: voucher.approvedBy || undefined,
              catchUpDepreciation: input.catchUpDepreciation, depreciationOverrideReason: input.depreciationOverrideReason,
            });
            break;
          case 'asset_depreciation':
            res = fa.postManualDepreciation({ assetId: input.assetId, date: voucher.postingDate, amount: input.amount, approvedBy: voucher.approvedBy || undefined });
            break;
          case 'asset_impairment':
            res = fa.impairAsset({ assetId: input.assetId, date: voucher.postingDate, recoverableAmount: input.recoverableAmount ?? 0, reason: voucher.description || 'Impairment via journal voucher', approvedBy: voucher.approvedBy || undefined });
            break;
          default:
            return { ok: false, error: `Unsupported asset voucher kind "${kind}".` };
        }
        if (!res.ok || !res.journalEntryId) return { ok: false, error: res.error ?? 'Asset posting failed.' };
        markPosted(voucher.id, res.journalEntryId, res.transactionId ?? res.id ?? '');
        return { ok: true, id: voucher.id, journalEntryId: res.journalEntryId };
      };

      return {
        ...EMPTY_STATE,

        ensureSeeded: () => {
          if (get().seeded) return;
          if (!orgHasModule('core_accounting')) return;
          const types = makeSeedVoucherTypes();
          set({ types, seeded: true, auditTrail: [...get().auditTrail, makeAudit('type-saved', `Seeded ${types.length} voucher types.`)] });
        },

        updateSettings: (patch) => {
          const p = perm('journalVoucher.configureTypes');
          if (!p.ok) return p;
          set({ settings: { ...get().settings, ...patch }, auditTrail: [...get().auditTrail, makeAudit('settings-updated', 'Journal-voucher settings updated.')] });
          return { ok: true };
        },

        saveType: (type) => {
          const p = perm('journalVoucher.configureTypes');
          if (!p.ok) return p;
          if (!type.code.trim() || !type.name.trim() || !type.prefix.trim()) {
            return { ok: false, error: 'Voucher-type code, name and number prefix are required.' };
          }
          const { types } = get();
          if (types.some((t) => t.code === type.code && t.id !== type.id)) {
            return { ok: false, error: `Voucher-type code "${type.code}" already exists.` };
          }
          const exists = types.some((t) => t.id === type.id);
          set({
            types: exists ? types.map((t) => (t.id === type.id ? type : t)) : [...types, type],
            auditTrail: [...get().auditTrail, makeAudit('type-saved', `Voucher type ${type.code} — ${type.name} saved.`)],
          });
          return { ok: true, id: type.id };
        },

        /* ── Drafting & workflow ─────────────────────────────────────────── */

        saveDraft: (voucher) => {
          const existing = get().vouchers.find((v) => v.id === voucher.id);
          const p = perm(existing ? 'journalVoucher.editDraft' : 'journalVoucher.create');
          if (!p.ok) return p;
          if (existing && existing.status !== 'draft' && existing.status !== 'rejected') {
            return { ok: false, error: `A ${existing.status.replaceAll('_', ' ')} voucher cannot be edited. Copy it into a new draft or use reverse/correct.` };
          }
          const type = get().types.find((t) => t.id === voucher.typeId);
          if (!type) return { ok: false, error: 'Select a valid voucher type.' };
          const accountById = new Map(useStore.getState().accounts.map((a) => [a.id, a]));
          const next: JournalVoucher = {
            ...voucher,
            number: voucher.number || nextNumber(type.prefix, get().vouchers.map((v) => v.number)),
            status: 'draft',
            // Refresh account snapshots while draft; posted lines are frozen.
            lines: renumber(voucher.lines.map((l) => {
              const a = l.accountId ? accountById.get(l.accountId) : undefined;
              return { ...l, accountCode: a?.code ?? l.accountCode, accountName: a?.name ?? l.accountName };
            })),
            history: existing ? [...existing.history, historyEvent('updated')] : voucher.history,
          };
          set({
            vouchers: existing ? get().vouchers.map((v) => (v.id === voucher.id ? next : v)) : [...get().vouchers, next],
            auditTrail: [...get().auditTrail, makeAudit(existing ? 'voucher-updated' : 'voucher-created', `${next.number} ${existing ? 'updated' : 'created'} (${type.name}).`)],
          });
          return { ok: true, id: next.id };
        },

        submitVoucher: (id) => {
          const p = perm('journalVoucher.submit');
          if (!p.ok) return p;
          const v = get().vouchers.find((x) => x.id === id);
          if (!v) return { ok: false, error: 'Voucher not found.' };
          if (v.status !== 'draft' && v.status !== 'rejected') return { ok: false, error: 'Only a draft can be submitted for approval.' };
          patchVoucher(id, (x) => ({ ...x, status: 'pending_approval', rejectionComment: '', history: [...x.history, historyEvent('submitted')] }));
          set({ auditTrail: [...get().auditTrail, makeAudit('voucher-submitted', `${v.number} submitted for approval.`)] });
          return { ok: true, id };
        },

        approveVoucher: (id, comment = '') => {
          const p = perm('journalVoucher.approve');
          if (!p.ok) return p;
          const v = get().vouchers.find((x) => x.id === id);
          if (!v) return { ok: false, error: 'Voucher not found.' };
          if (v.status !== 'pending_approval') return { ok: false, error: 'Only a voucher pending approval can be approved.' };
          // Segregation of duties: the preparer of a material voucher may not
          // approve it.
          const { settings } = get();
          const totals = computeVoucherTotals(v.lines, v.exchangeRate);
          const material = Math.max(totals.baseDebit, totals.baseCredit) >= settings.materialAmountThreshold;
          if (settings.segregationOfDuties && material && v.preparedBy === actor()) {
            return { ok: false, error: 'Segregation of duties: the preparer of a material voucher cannot approve it. Ask another authorized user.' };
          }
          const now = nowIso();
          patchVoucher(id, (x) => ({ ...x, status: 'approved', approvedBy: actor(), approvedAt: now, reviewedBy: x.reviewedBy || actor(), history: [...x.history, historyEvent('approved', comment)] }));
          set({ auditTrail: [...get().auditTrail, makeAudit('voucher-approved', `${v.number} approved.`)] });
          return { ok: true, id };
        },

        rejectVoucher: (id, comment) => {
          const p = perm('journalVoucher.review');
          if (!p.ok) return p;
          if (!comment.trim()) return { ok: false, error: 'A rejection comment is required.' };
          const v = get().vouchers.find((x) => x.id === id);
          if (!v) return { ok: false, error: 'Voucher not found.' };
          if (v.status !== 'pending_approval') return { ok: false, error: 'Only a voucher pending approval can be rejected.' };
          patchVoucher(id, (x) => ({ ...x, status: 'rejected', rejectionComment: comment, history: [...x.history, historyEvent('rejected', comment)] }));
          set({ auditTrail: [...get().auditTrail, makeAudit('voucher-rejected', `${v.number} rejected: ${comment}.`)] });
          return { ok: true, id };
        },

        cancelDraft: (id) => {
          const p = perm('journalVoucher.cancelDraft');
          if (!p.ok) return p;
          const v = get().vouchers.find((x) => x.id === id);
          if (!v) return { ok: false, error: 'Voucher not found.' };
          if (v.status !== 'draft' && v.status !== 'rejected' && v.status !== 'pending_approval') {
            return { ok: false, error: 'Only unposted vouchers can be cancelled. Posted vouchers must be reversed.' };
          }
          patchVoucher(id, (x) => ({ ...x, status: 'cancelled', history: [...x.history, historyEvent('cancelled')] }));
          set({ auditTrail: [...get().auditTrail, makeAudit('voucher-cancelled', `${v.number} cancelled.`)] });
          return { ok: true, id };
        },

        addAttachment: (id, attachment) => {
          const p = perm('journalVoucher.viewAttachments');
          if (!p.ok) return p;
          const v = get().vouchers.find((x) => x.id === id);
          if (!v) return { ok: false, error: 'Voucher not found.' };
          const att: VoucherAttachment = { ...attachment, id: generateId('jvatt'), uploadedAt: nowIso(), uploadedBy: actor() };
          patchVoucher(id, (x) => ({ ...x, attachments: [...x.attachments, att], history: [...x.history, historyEvent('attachment-added', att.name)] }));
          return { ok: true, id };
        },

        /* ── Posting ─────────────────────────────────────────────────────── */

        postVoucher: (id) => {
          const p = perm('journalVoucher.post');
          if (!p.ok) return p;
          const v = get().vouchers.find((x) => x.id === id);
          if (!v) return { ok: false, error: 'Voucher not found.' };
          const type = typeOf(v);
          if (!type) return { ok: false, error: 'The voucher type no longer exists.' };
          if (!type.isActive) return { ok: false, error: `Voucher type ${type.name} is inactive.` };

          // Specially-controlled classes need their dedicated permission.
          if (type.kind === 'opening_balance') {
            const ob = perm('journalVoucher.postOpeningBalance');
            if (!ob.ok) return ob;
            if (get().settings.openingBalancesLocked) {
              return { ok: false, error: 'Opening balances are locked: normal operations have begun. An administrator must unlock them before posting.' };
            }
          }
          if (type.kind === 'intercompany') {
            const ic = perm('journalVoucher.postIntercompany');
            if (!ic.ok) return ic;
          }
          if (type.kind === 'tax_adjustment') {
            const tx = perm('journalVoucher.postTaxAdjustment');
            if (!tx.ok) return tx;
          }

          // Approval gate.
          if (type.approvalRequired && v.status !== 'approved') {
            return { ok: false, error: `${type.name} vouchers require approval before posting (current status: ${v.status.replaceAll('_', ' ')}).` };
          }
          if (v.status !== 'draft' && v.status !== 'approved') {
            return { ok: false, error: `A ${v.status.replaceAll('_', ' ')} voucher cannot be posted.` };
          }

          // Duplicate-source refusal reports the EXISTING journal.
          const key = sourceKeyOf(v);
          if (key) {
            const existing = get().vouchers.find((x) => x.id !== v.id && sourceKeyOf(x) === key && (x.status === 'posted' || x.status === 'partially_reversed' || x.status === 'reversed'));
            if (existing) {
              return {
                ok: false,
                error: `Source transaction ${key} was already posted by ${existing.number} (journal ${existing.journalEntryNumber}). Duplicate accounting is not allowed.`,
                existingJournalNumber: existing.journalEntryNumber,
              };
            }
          }

          // Asset-linked kinds validate + post inside the Fixed Assets store
          // (mappings, period, status, depreciable clamps, duplicates).
          if (type.kind === 'asset_acquisition' || type.kind === 'asset_disposal' || type.kind === 'asset_depreciation' || type.kind === 'asset_impairment') {
            const lock = get().settings.postingLockDate;
            if (lock && v.postingDate <= lock) {
              return { ok: false, error: `The accounting period through ${lock} is closed.` };
            }
            return postAssetKind(v, type.kind);
          }

          const issues = validateVoucherForPosting(v, validationContext(v));
          if (issues.length > 0) return { ok: false, error: issues[0]!.message };
          return postGeneral(v);
        },

        /* ── Reversal / correction ───────────────────────────────────────── */

        reverseVoucher: (id, input) => {
          const p = perm('journalVoucher.reverse');
          if (!p.ok) return p;
          if (!input.reason.trim()) return { ok: false, error: 'A documented reason is required for a reversal.' };
          const v = get().vouchers.find((x) => x.id === id);
          if (!v) return { ok: false, error: 'Voucher not found.' };
          if (v.status !== 'posted' && v.status !== 'partially_reversed') {
            return { ok: false, error: v.status === 'reversed' ? `${v.number} has already been reversed.` : 'Only a posted voucher can be reversed.' };
          }
          const type = typeOf(v);
          const date = input.date ?? nowIso().slice(0, 10);
          const lock = get().settings.postingLockDate;
          if (lock && date <= lock) return { ok: false, error: `The accounting period through ${lock} is closed.` };

          let reversalJournalId = '';
          if (v.assetTransactionId) {
            // Asset-linked: the Fixed Assets store reverses journal + register.
            const res = useFixedAssetStore.getState().reverseTransaction(v.assetTransactionId, input.reason, actor());
            if (!res.ok) return { ok: false, error: res.error };
            reversalJournalId = res.journalEntryId ?? '';
          } else {
            const original = useJournalStore.getState().entries.find((e) => e.id === v.journalEntryId);
            if (!original) return { ok: false, error: 'The original journal entry could not be found.' };
            const res = useJournalStore.getState().insertPostedEntry({
              entryDate: date,
              reference: `JV:REV:${v.number}`,
              description: `Reversal of ${v.number}: ${input.reason}`,
              currency: original.currency,
              exchangeRate: original.exchangeRate,
              transactionType: 'Journal Voucher',
              notes: `Reversal of journal ${original.entryNumber} (voucher ${v.number}). Original preserved.`,
              lines: original.lines.map((l) => ({
                accountId: l.accountId, debit: l.credit, credit: l.debit,
                description: `Reversal — ${l.description}`,
                costCenter: l.costCenter || undefined, project: l.project || undefined,
              })),
            });
            if (!res.ok || !res.id) return { ok: false, error: res.error ?? 'Reversal posting failed.' };
            reversalJournalId = res.id;
          }
          const reversalNumber = nextNumber(type?.prefix ?? 'JV', get().vouchers.map((x) => x.number));
          const entryNumber = useJournalStore.getState().entries.find((e) => e.id === reversalJournalId)?.entryNumber ?? '';
          const now = nowIso();
          const reversal: JournalVoucher = {
            ...makeBlankVoucher(type ?? get().types[0]!),
            id: generateId('jv'), number: reversalNumber, typeId: v.typeId, status: 'posted',
            transactionDate: date, postingDate: date, period: date.slice(0, 7), documentDate: date,
            currency: v.currency, exchangeRate: v.exchangeRate,
            description: `Reversal of ${v.number} — ${v.description}`,
            internalReference: v.number,
            lines: renumber(v.lines.map((l) => ({ ...l, id: generateId('jvl'), debit: l.credit, credit: l.debit }))),
            journalEntryId: reversalJournalId, journalEntryNumber: entryNumber,
            reversalOfVoucherId: v.id, reversalReason: input.reason,
            intercompanyRef: v.intercompanyRef,
            preparedBy: actor(), approvedBy: actor(), postedBy: actor(),
            createdAt: now, updatedAt: now, postedAt: now,
            history: [historyEvent('created'), historyEvent('posted', `Reversal of ${v.number}`)],
          };
          set({
            vouchers: [
              ...get().vouchers.map((x) => (x.id === v.id ? { ...x, status: 'reversed' as const, reversedByVoucherId: reversal.id, reversalReason: input.reason, history: [...x.history, historyEvent('reversed', input.reason)] } : x)),
              reversal,
            ],
            auditTrail: [...get().auditTrail, makeAudit('voucher-reversed', `${v.number} reversed by ${reversal.number}: ${input.reason}.`)],
          });
          return { ok: true, id: reversal.id, journalEntryId: reversalJournalId };
        },

        correctVoucher: (id, reason) => {
          const p = perm('journalVoucher.correct');
          if (!p.ok) return p;
          const v = get().vouchers.find((x) => x.id === id);
          if (!v) return { ok: false, error: 'Voucher not found.' };
          const rev = get().reverseVoucher(id, { reason: `Correction: ${reason}` });
          if (!rev.ok) return rev;
          // Replacement draft carrying the original content, linked both ways.
          const type = typeOf(v)!;
          const replacement: JournalVoucher = {
            ...makeBlankVoucher(type),
            number: nextNumber(type.prefix, get().vouchers.map((x) => x.number)),
            typeId: v.typeId,
            currency: v.currency, exchangeRate: v.exchangeRate,
            description: v.description, narration: v.narration,
            internalReference: v.number,
            replacementVoucherId: '', reversalOfVoucherId: '',
            lines: renumber(v.lines.map((l) => ({ ...l, id: generateId('jvl') }))),
          };
          set({
            vouchers: [...get().vouchers.map((x) => (x.id === v.id ? { ...x, replacementVoucherId: replacement.id, history: [...x.history, historyEvent('corrected', reason)] } : x)), replacement],
            auditTrail: [...get().auditTrail, makeAudit('voucher-corrected', `${v.number} corrected: reversal ${rev.id} + replacement draft ${replacement.number}.`)],
          });
          return { ok: true, id: replacement.id, journalEntryId: rev.journalEntryId };
        },

        copyVoucher: (id) => {
          const p = perm('journalVoucher.create');
          if (!p.ok) return p;
          const v = get().vouchers.find((x) => x.id === id);
          if (!v) return { ok: false, error: 'Voucher not found.' };
          const type = typeOf(v);
          if (!type) return { ok: false, error: 'The voucher type no longer exists.' };
          const copy: JournalVoucher = {
            ...makeBlankVoucher(type),
            number: nextNumber(type.prefix, get().vouchers.map((x) => x.number)),
            typeId: v.typeId, currency: v.currency, exchangeRate: v.exchangeRate,
            description: v.description, narration: v.narration,
            lines: renumber(v.lines.map((l) => ({ ...l, id: generateId('jvl') }))),
          };
          set({ vouchers: [...get().vouchers, copy], auditTrail: [...get().auditTrail, makeAudit('voucher-created', `${copy.number} copied from ${v.number}.`)] });
          return { ok: true, id: copy.id };
        },

        processAutoReversals: (throughDate) => {
          const due = get().vouchers.filter((v) => v.status === 'posted' && v.autoReverseDate && v.autoReverseDate <= throughDate);
          let reversedCount = 0;
          for (const v of due) {
            const res = get().reverseVoucher(v.id, { reason: `Automatic reversal on ${v.autoReverseDate}`, date: v.autoReverseDate });
            if (res.ok) reversedCount += 1;
            else return { ok: false, error: `${v.number}: ${res.error}`, reversedCount };
          }
          return { ok: true, reversedCount };
        },

        /* ── Recurring templates ─────────────────────────────────────────── */

        saveTemplate: (template) => {
          const p = perm('journalVoucher.manageTemplates');
          if (!p.ok) return p;
          const type = get().types.find((t) => t.id === template.typeId);
          if (!type) return { ok: false, error: 'Select a valid voucher type for the template.' };
          if (!type.allowRecurring) return { ok: false, error: `Voucher type ${type.name} does not allow recurring posting.` };
          const { templates } = get();
          const exists = templates.some((t) => t.id === template.id);
          const next: RecurringVoucherTemplate = {
            ...template,
            number: template.number || nextNumber('RVT', templates.map((t) => t.number)),
            nextPostingDate: template.nextPostingDate || template.startDate,
          };
          set({
            templates: exists ? templates.map((t) => (t.id === template.id ? next : t)) : [...templates, next],
            auditTrail: [...get().auditTrail, makeAudit('template-saved', `Template ${next.number} — ${next.name} saved.`)],
          });
          return { ok: true, id: next.id };
        },

        generateFromTemplate: (templateId) => {
          const p = perm('journalVoucher.create');
          if (!p.ok) return p;
          const t = get().templates.find((x) => x.id === templateId);
          if (!t) return { ok: false, error: 'Template not found.' };
          if (!t.active) return { ok: false, error: `Template ${t.number} is inactive.` };
          if (t.endDate && t.nextPostingDate > t.endDate) return { ok: false, error: `Template ${t.number} has passed its end date.` };
          const type = get().types.find((x) => x.id === t.typeId);
          if (!type) return { ok: false, error: 'The template voucher type no longer exists.' };

          const date = t.nextPostingDate;
          const voucher: JournalVoucher = {
            ...makeBlankVoucher(type),
            number: nextNumber(type.prefix, get().vouchers.map((v) => v.number)),
            typeId: t.typeId,
            transactionDate: date, postingDate: date, period: date.slice(0, 7), documentDate: date,
            currency: t.currency, exchangeRate: t.exchangeRate,
            description: `${t.description} (${date.slice(0, 7)})`,
            templateId: t.id,
            autoReverseDate: t.autoReverse ? nextDate(date, t.frequency) : '',
            lines: renumber(t.lines.map((l) => ({ ...l, id: generateId('jvl') }))),
          };
          set({
            vouchers: [...get().vouchers, voucher],
            templates: get().templates.map((x) => (x.id === t.id ? { ...x, nextPostingDate: nextDate(date, t.frequency), generatedVoucherIds: [...x.generatedVoucherIds, voucher.id] } : x)),
            auditTrail: [...get().auditTrail, makeAudit('template-generated', `${voucher.number} generated from template ${t.number}.`)],
          });
          return { ok: true, id: voucher.id };
        },

        /* ── Intercompany pair ───────────────────────────────────────────── */

        postIntercompanyPair: (input) => {
          const p = perm('journalVoucher.postIntercompany');
          if (!p.ok) return p;
          if (input.amount <= 0) return { ok: false, error: 'The intercompany amount must be greater than zero.' };
          if (!input.intercompanyRef.trim()) return { ok: false, error: 'A common intercompany reference is required.' };
          const { paying, receiving } = input;
          if (!paying.company.trim() || !receiving.company.trim() || paying.company === receiving.company) {
            return { ok: false, error: 'Identify two DIFFERENT legal entities for an intercompany journal.' };
          }
          if (!paying.chargeAccountId || !paying.dueToAccountId || !receiving.dueFromAccountId || !receiving.creditAccountId) {
            return { ok: false, error: 'Intercompany journals need the charge, due-to, due-from and income accounts mapped.' };
          }
          const type = get().types.find((t) => t.kind === 'intercompany' && t.isActive);
          if (!type) return { ok: false, error: 'No active Intercompany voucher type is configured.' };

          const makeLeg = (company: string, drAccount: string, crAccount: string, description: string): JournalVoucher => ({
            ...makeBlankVoucher(type),
            number: nextNumber(type.prefix, get().vouchers.map((v) => v.number)),
            companyId: company,
            transactionDate: input.date, postingDate: input.date, period: input.date.slice(0, 7), documentDate: input.date,
            currency: input.currency ?? baseCurrency(), exchangeRate: input.exchangeRate ?? 1,
            description, intercompanyRef: input.intercompanyRef,
            // Approval flows for intercompany run through the type config; the
            // pair action itself is the approved, atomic-in-sequence path.
            status: 'approved', approvedBy: actor(), approvedAt: nowIso(),
            lines: renumber([
              { ...makeBlankLine(), accountId: drAccount, debit: round2(input.amount), credit: 0, description, relatedCompany: company },
              { ...makeBlankLine(), accountId: crAccount, debit: 0, credit: round2(input.amount), description, relatedCompany: company },
            ]),
          });

          // One balanced journal PER legal entity — never one journal across two.
          const legA = makeLeg(paying.company, paying.chargeAccountId, paying.dueToAccountId, `${input.description} — ${paying.company} (intercompany ${input.intercompanyRef})`);
          set({ vouchers: [...get().vouchers, legA] });
          const resA = get().postVoucher(legA.id);
          if (!resA.ok) {
            set({ vouchers: get().vouchers.filter((v) => v.id !== legA.id) });
            return { ok: false, error: `Paying-company journal failed: ${resA.error}` };
          }
          const legB = makeLeg(receiving.company, receiving.dueFromAccountId, receiving.creditAccountId, `${input.description} — ${receiving.company} (intercompany ${input.intercompanyRef})`);
          set({ vouchers: [...get().vouchers, legB] });
          const resB = get().postVoucher(legB.id);
          if (!resB.ok) {
            // Sequential in-browser posting is not a database transaction: undo
            // the first leg with an explicit reversal so the books stay level.
            get().reverseVoucher(legA.id, { reason: `Intercompany pair ${input.intercompanyRef} failed on the receiving leg: ${resB.error}` });
            set({ vouchers: get().vouchers.filter((v) => v.id !== legB.id) });
            return { ok: false, error: `Receiving-company journal failed (paying leg reversed): ${resB.error}` };
          }
          return { ok: true, id: legA.id, pairedVoucherId: legB.id, journalEntryId: resA.journalEntryId };
        },

        resetToDefault: () => set({ ...EMPTY_STATE, settings: { ...DEFAULT_SETTINGS } }),
      };
    },
    {
      name: 'ledgora-journal-vouchers',
      storage: businessJSONStorage,
      version: 1,
      partialize: (s) => ({
        types: s.types, vouchers: s.vouchers, templates: s.templates,
        settings: s.settings, auditTrail: s.auditTrail, seeded: s.seeded,
      }),
    },
  ),
);

/** Advance a date by one recurrence step (same day-of-month where possible). */
function nextDate(iso: string, frequency: 'monthly' | 'quarterly' | 'annual'): string {
  const step = frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const total = (y * 12 + (m - 1)) + step;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}
