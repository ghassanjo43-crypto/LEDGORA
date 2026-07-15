/**
 * Ledgora Inventory store (persist key `ledgora-inventory`).
 *
 * Owns master data (items, categories, units, warehouses), the IMMUTABLE
 * stock-movement ledger, lightweight document records, settings and an audit
 * trail. Quantity and value are always DERIVED from the movement ledger via the
 * balance/valuation libraries — never stored as authoritative fields.
 *
 * Every document posts atomically: the journal entry is inserted first (via the
 * journal store), then the linked stock movements are committed. If the journal
 * fails, no movements are written. Posted movements/documents are corrected only
 * by linked reversals.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  InventoryItem,
  InventorySettings,
  ItemCategory,
  StockMovement,
  UnitOfMeasure,
  Warehouse,
} from '@/types/inventory';
import type { InventoryAuditEntry, InventoryAuditEvent } from '@/types/inventoryDocuments';
import { useStore } from './useStore';
import { useJournalStore } from './journalStore';
import { useEntitlementStore } from './entitlementStore';
import { getCurrentUserName } from './sessionStore';
import {
  buildAdjustmentPlan,
  buildBillReceiptPlan,
  buildCustomerReturnPlan,
  buildGoodsIssuePlan,
  buildGoodsReceiptPlan,
  buildInvoiceIssuePlan,
  buildOpeningBalancePlan,
  buildStockCountPlan,
  buildSupplierReturnPlan,
  buildTransferPlan,
  planTotals,
  type MovementPlan,
  type PostingContext,
  type PostingPlan,
} from '@/lib/inventoryPosting';
import { buildReversalMovement, canReverseMovement } from '@/lib/inventoryReversal';
import { nextNumber, type InventorySeqPrefix } from '@/lib/inventoryNumbering';
import { canChangeValuationMethod, effectiveNegativePolicy, isStockTracked, validateAvailableStock } from '@/lib/inventoryValidation';
import { resolveInventoryAccounts } from '@/lib/inventoryAccounts';
import { roundCost } from '@/lib/inventoryValuation';
import type { StockMovementType, StockSourceDocumentType } from '@/types/inventory';
import { ENTITY, makeInventorySeed } from '@/lib/inventorySeed';
import { generateId, nowIso } from '@/lib/utils';

export interface InvResult {
  ok: boolean;
  error?: string;
  id?: string;
  journalEntryId?: string;
  movementIds?: string[];
}

export type InventoryDocumentKind =
  | 'opening'
  | 'receipt'
  | 'issue'
  | 'transfer'
  | 'adjustment'
  | 'count'
  | 'bill-receipt'
  | 'invoice-issue'
  | 'customer-return'
  | 'supplier-return'
  | 'mfg-issue'
  | 'mfg-return'
  | 'mfg-receipt'
  | 'mfg-scrap';

export interface InventoryDocumentRecord {
  id: string;
  entityId: string;
  kind: InventoryDocumentKind;
  number: string;
  date: string;
  reference: string;
  status: 'posted' | 'reversed';
  journalEntryId?: string;
  movementIds: string[];
  reversalOfId?: string;
  reversedById?: string;
  total: number;
  meta?: Record<string, unknown>;
  /** True when the journal is owned by a source document (bill/CN/SC), so this
   * document must NOT reverse it — the source document handles its own journal. */
  externalJournal?: boolean;
  postedAt: string;
}

interface InventoryState {
  items: InventoryItem[];
  categories: ItemCategory[];
  units: UnitOfMeasure[];
  warehouses: Warehouse[];
  movements: StockMovement[];
  documents: InventoryDocumentRecord[];
  settings: InventorySettings;
  auditTrail: InventoryAuditEntry[];
  seeded: boolean;

  ensureSeeded: () => void;

  /* Master data */
  saveItem: (item: InventoryItem) => InvResult;
  archiveItem: (id: string) => InvResult;
  saveCategory: (category: ItemCategory) => InvResult;
  saveUnit: (unit: UnitOfMeasure) => InvResult;
  saveWarehouse: (warehouse: Warehouse) => InvResult;
  deleteWarehouse: (id: string) => InvResult;
  updateSettings: (patch: Partial<InventorySettings>) => InvResult;

  /* Documents (atomic post) */
  postOpeningBalance: (input: OpeningInput) => InvResult;
  postGoodsReceipt: (input: ReceiptInput) => InvResult;
  postGoodsIssue: (input: IssueInput) => InvResult;
  postTransfer: (input: TransferInput) => InvResult;
  postAdjustment: (input: AdjustmentInput) => InvResult;
  postStockCount: (input: CountInput) => InvResult;

  /* Sales / purchase integration */
  postBillReceipt: (input: BillReceiptInput) => InvResult;
  postInvoiceIssue: (input: InvoiceIssueInput) => InvResult;
  postCustomerReturn: (input: ReturnInput) => InvResult;
  postSupplierReturn: (input: ReturnInput) => InvResult;
  /** Record stock movements linked to a journal OWNED by a source document
   * (bill / credit note / supplier credit). No journal is posted here. */
  recordLinkedMovements: (input: LinkedMovementInput) => InvResult;

  /* Correction */
  reverseDocument: (documentId: string) => InvResult;

  resetToDefault: () => void;
}

/* Input shapes (thin wrappers over the posting builders). */
type Header = { date: string; reference: string };
export type OpeningInput = Header & { lines: import('@/lib/inventoryPosting').OpeningLineInput[] };
export type ReceiptInput = Header & { warehouseId?: string; supplierId?: string; lines: import('@/lib/inventoryPosting').ReceiptLineInput[] };
export type IssueInput = Header & { reason?: string; lines: import('@/lib/inventoryPosting').IssueLineInput[] };
export type TransferInput = Header & { sourceWarehouseId: string; destinationWarehouseId: string; lines: import('@/lib/inventoryPosting').TransferLineInput[] };
export type AdjustmentInput = Header & { reason?: string; lines: import('@/lib/inventoryPosting').AdjustmentLineInput[] };
export type CountInput = Header & { warehouseId: string; lines: import('@/lib/inventoryPosting').CountLineInput[] };
export type BillReceiptInput = Header & { currency?: string; exchangeRate?: number; lines: import('@/lib/inventoryPosting').BillReceiptLineInput[] };
export type InvoiceIssueInput = Header & { lines: import('@/lib/inventoryPosting').InvoiceIssueLineInput[] };
export type ReturnInput = Header & { lines: import('@/lib/inventoryPosting').ReturnLineInput[] };

export type LinkedMovementKind =
  | 'bill-receipt'
  | 'customer-return'
  | 'supplier-return'
  | 'mfg-issue'
  | 'mfg-return'
  | 'mfg-receipt'
  | 'mfg-scrap';
export interface LinkedMovementInput {
  date: string;
  reference: string;
  journalEntryId?: string;
  kind: LinkedMovementKind;
  /** Optional explicit movement type (else derived from `kind`). */
  movementType?: StockMovementType;
  lines: Array<{ id: string; itemId: string; warehouseId: string; quantity: number; direction: 'in' | 'out'; unitCost: number; workOrderId?: string }>;
}

const LINKED_MOVEMENT_TYPE: Record<LinkedMovementKind, StockMovementType> = {
  'bill-receipt': 'purchase-receipt',
  'customer-return': 'sales-return',
  'supplier-return': 'purchase-return',
  'mfg-issue': 'manufacturing-material-issue',
  'mfg-return': 'manufacturing-material-return',
  'mfg-receipt': 'manufacturing-production-receipt',
  'mfg-scrap': 'manufacturing-scrap',
};
const LINKED_SOURCE_TYPE: Record<LinkedMovementKind, StockSourceDocumentType> = {
  'bill-receipt': 'bill',
  'customer-return': 'credit-note',
  'supplier-return': 'supplier-credit',
  'mfg-issue': 'manufacturing',
  'mfg-return': 'manufacturing',
  'mfg-receipt': 'manufacturing',
  'mfg-scrap': 'manufacturing',
};

function audit(event: InventoryAuditEvent, detail: string, extra?: { documentId?: string; movementId?: string }): InventoryAuditEntry {
  return { id: generateId('iau'), entityId: ENTITY, event, at: nowIso(), actor: getCurrentUserName(), detail, ...extra };
}

function emptySettings(): InventorySettings {
  return {
    entityId: ENTITY,
    enabled: false,
    defaultValuationMethod: 'weighted-average',
    negativeStockPolicy: 'block',
    salesRecognitionMode: 'on-invoice',
    purchaseRecognitionMode: 'on-bill',
    useGrni: false,
  };
}

function blankState(): Pick<InventoryState, 'items' | 'categories' | 'units' | 'warehouses' | 'movements' | 'documents' | 'settings' | 'auditTrail' | 'seeded'> {
  return { items: [], categories: [], units: [], warehouses: [], movements: [], documents: [], settings: emptySettings(), auditTrail: [], seeded: false };
}

export const useInventoryStore = create<InventoryState>()(
  persist(
    (set, get) => {
      /** Build the posting context from the current stores. */
      function context(header: { date: string; currency?: string; exchangeRate?: number }): PostingContext {
        const s = get();
        return {
          entityId: ENTITY,
          accounts: useStore.getState().accounts,
          items: s.items,
          categories: s.categories,
          warehouses: s.warehouses,
          units: s.units,
          settings: s.settings,
          priorMovements: s.movements,
          today: header.date,
          currency: header.currency ?? useStore.getState().settings.baseCurrency ?? 'USD',
          exchangeRate: header.exchangeRate ?? 1,
        };
      }

      /** Turn movement plans into stored movements, numbered and linked. */
      function materializeMovements(plans: MovementPlan[], docId: string, journalEntryId: string | undefined, journalLineIds: string[] | undefined): StockMovement[] {
        const existingNumbers = get().movements.map((m) => m.movementNumber);
        const now = nowIso();
        return plans.map((p, idx) => {
          const number = nextNumber('MOV', [...existingNumbers, ...Array.from({ length: idx }, (_, i) => `MOV-placeholder-${i}`)]);
          existingNumbers.push(number);
          return {
            id: generateId('mov'),
            entityId: ENTITY,
            movementNumber: number,
            movementType: p.movementType,
            movementDate: now.slice(0, 10), // overridden with the document date in commit()
            postingDate: now.slice(0, 10),
            itemId: p.itemId,
            warehouseId: p.warehouseId,
            direction: p.direction,
            quantity: p.quantity,
            baseUnitId: p.baseUnitId,
            unitCostBase: p.unitCostBase,
            totalCostBase: p.totalCostBase,
            documentCurrency: p.documentCurrency,
            documentUnitCost: p.documentUnitCost,
            exchangeRate: p.exchangeRate,
            projectId: p.projectId,
            costCenterId: p.costCenterId,
            sourceDocumentType: p.sourceDocumentType,
            sourceDocumentId: docId,
            sourceLineId: p.sourceLineId,
            journalEntryId,
            journalLineIds,
            itemSnapshot: p.itemSnapshot,
            warehouseSnapshot: p.warehouseSnapshot,
            accountSnapshot: p.accountSnapshot,
            status: 'posted' as const,
            reversalOfMovementId: p.reversalOfMovementId,
            createdAt: now,
            createdBy: getCurrentUserName(),
          } satisfies StockMovement;
        });
      }

      /**
       * Commit a posting plan: insert the journal (if any), then the movements,
       * then the document record. Journal failure aborts before any movement.
       */
      function commit(
        plan: PostingPlan,
        opts: { kind: InventoryDocumentKind; prefix: InventorySeqPrefix; date: string; reference: string; meta?: Record<string, unknown>; auditEvent: InventoryAuditEvent; postingDate?: string },
      ): InvResult {
        if (!plan.ok) return { ok: false, error: plan.error };
        if (plan.movements.length === 0) return { ok: false, error: 'Nothing to post.' };

        let journalEntryId: string | undefined;
        let journalLineIds: string[] | undefined;
        if (plan.journal) {
          const res = useJournalStore.getState().insertPostedEntry({
            entryDate: plan.journal.date,
            reference: plan.journal.reference,
            description: plan.journal.description,
            currency: plan.journal.currency,
            exchangeRate: plan.journal.exchangeRate,
            transactionType: plan.journal.transactionType,
            lines: plan.journal.lines.map((l) => ({
              accountId: l.accountId,
              debit: l.debit,
              credit: l.credit,
              description: l.description,
              project: l.projectId,
              costCenter: l.costCenterId,
              taxCode: l.taxCode,
            })),
          });
          if (!res.ok) return { ok: false, error: res.error }; // no movements written
          journalEntryId = res.id;
          journalLineIds = res.lineIds;
        }

        const docId = generateId('idoc');
        const movements = materializeMovements(plan.movements, docId, journalEntryId, journalLineIds).map((m) => ({
          ...m,
          postingDate: opts.postingDate ?? opts.date,
          movementDate: opts.date,
        }));
        const number = nextNumber(opts.prefix, get().documents.filter((d) => d.kind === opts.kind).map((d) => d.number), opts.date);
        const total = planTotals(plan.journal).debit || movements.reduce((s, m) => s + m.totalCostBase, 0);
        const doc: InventoryDocumentRecord = {
          id: docId,
          entityId: ENTITY,
          kind: opts.kind,
          number,
          date: opts.date,
          reference: opts.reference,
          status: 'posted',
          journalEntryId,
          movementIds: movements.map((m) => m.id),
          total,
          meta: opts.meta,
          postedAt: nowIso(),
        };
        set((s) => ({
          movements: [...s.movements, ...movements],
          documents: [...s.documents, doc],
          auditTrail: [...s.auditTrail, audit(opts.auditEvent, `${opts.kind} ${number} posted (${movements.length} movement(s)).`, { documentId: docId })],
        }));
        return { ok: true, id: docId, journalEntryId, movementIds: doc.movementIds };
      }

      return {
        ...blankState(),

        ensureSeeded: () => {
          if (get().seeded) return;
          const edition = useEntitlementStore.getState().subscription.edition;
          const seed = makeInventorySeed(edition);
          set({ ...seed, movements: [], documents: [], auditTrail: [], seeded: true });
        },

        /* ── Master data ──────────────────────────────────────────────────── */
        saveItem: (item) => {
          const existing = get().items.find((i) => i.id === item.id);
          if (existing && existing.valuationMethod !== item.valuationMethod && !canChangeValuationMethod(item.id, get().movements)) {
            set((s) => ({ auditTrail: [...s.auditTrail, audit('valuation-method-change-blocked', `Blocked valuation-method change on "${item.code}" — movements exist.`)] }));
            return { ok: false, error: 'Cannot change valuation method after stock movements exist for this item.' };
          }
          if (get().items.some((i) => i.id !== item.id && i.code.trim().toLowerCase() === item.code.trim().toLowerCase())) {
            return { ok: false, error: `Item code "${item.code}" already exists.` };
          }
          const record: InventoryItem = { ...item, entityId: ENTITY, updatedAt: nowIso(), createdAt: existing?.createdAt ?? nowIso() };
          set((s) => ({
            items: existing ? s.items.map((i) => (i.id === item.id ? record : i)) : [...s.items, record],
            auditTrail: [...s.auditTrail, audit(existing ? 'item-updated' : 'item-created', `Item "${record.code}" saved.`)],
          }));
          return { ok: true, id: record.id };
        },

        archiveItem: (id) => {
          const item = get().items.find((i) => i.id === id);
          if (!item) return { ok: false, error: 'Item not found.' };
          set((s) => ({
            items: s.items.map((i) => (i.id === id ? { ...i, status: 'archived', updatedAt: nowIso() } : i)),
            auditTrail: [...s.auditTrail, audit('item-archived', `Item "${item.code}" archived.`)],
          }));
          return { ok: true };
        },

        saveCategory: (category) => {
          const existing = get().categories.find((c) => c.id === category.id);
          if (get().categories.some((c) => c.id !== category.id && c.code.trim().toLowerCase() === category.code.trim().toLowerCase())) {
            return { ok: false, error: `Category code "${category.code}" already exists.` };
          }
          const record = { ...category, entityId: ENTITY };
          set((s) => ({
            categories: existing ? s.categories.map((c) => (c.id === category.id ? record : c)) : [...s.categories, record],
            auditTrail: [...s.auditTrail, audit('category-saved', `Category "${record.code}" saved.`)],
          }));
          return { ok: true, id: record.id };
        },

        saveUnit: (unit) => {
          const existing = get().units.find((u) => u.id === unit.id);
          if (get().units.some((u) => u.id !== unit.id && u.code.trim().toLowerCase() === unit.code.trim().toLowerCase())) {
            return { ok: false, error: `Unit code "${unit.code}" already exists.` };
          }
          const record = { ...unit, entityId: ENTITY };
          set((s) => ({
            units: existing ? s.units.map((u) => (u.id === unit.id ? record : u)) : [...s.units, record],
            auditTrail: [...s.auditTrail, audit('unit-saved', `Unit "${record.code}" saved.`)],
          }));
          return { ok: true, id: record.id };
        },

        saveWarehouse: (warehouse) => {
          const existing = get().warehouses.find((w) => w.id === warehouse.id);
          if (get().warehouses.some((w) => w.id !== warehouse.id && w.code.trim().toLowerCase() === warehouse.code.trim().toLowerCase())) {
            return { ok: false, error: `Warehouse code "${warehouse.code}" already exists.` };
          }
          const record: Warehouse = { ...warehouse, entityId: ENTITY, updatedAt: nowIso(), createdAt: existing?.createdAt ?? nowIso() };
          set((s) => ({
            warehouses: existing ? s.warehouses.map((w) => (w.id === warehouse.id ? record : w)) : [...s.warehouses, record],
            auditTrail: [...s.auditTrail, audit(existing ? 'warehouse-updated' : 'warehouse-created', `Warehouse "${record.code}" saved.`)],
          }));
          return { ok: true, id: record.id };
        },

        deleteWarehouse: (id) => {
          const wh = get().warehouses.find((w) => w.id === id);
          if (!wh) return { ok: false, error: 'Warehouse not found.' };
          const hasStock = get().movements.some((m) => m.warehouseId === id && m.status !== 'reversed');
          if (hasStock) return { ok: false, error: 'A warehouse with stock movements cannot be deleted. Archive it instead.' };
          set((s) => ({ warehouses: s.warehouses.filter((w) => w.id !== id) }));
          return { ok: true };
        },

        updateSettings: (patch) => {
          set((s) => ({ settings: { ...s.settings, ...patch, entityId: ENTITY }, auditTrail: [...s.auditTrail, audit('settings-updated', 'Inventory settings updated.')] }));
          return { ok: true };
        },

        /* ── Standalone documents ─────────────────────────────────────────── */
        postOpeningBalance: (input) =>
          commit(buildOpeningBalancePlan(context(input), input), { kind: 'opening', prefix: 'OPN', date: input.date, reference: input.reference, auditEvent: 'opening-balance-posted' }),

        postGoodsReceipt: (input) =>
          commit(buildGoodsReceiptPlan(context(input), input), { kind: 'receipt', prefix: 'GRN', date: input.date, reference: input.reference, meta: { supplierId: input.supplierId }, auditEvent: 'receipt-posted' }),

        postGoodsIssue: (input) =>
          commit(buildGoodsIssuePlan(context(input), input), { kind: 'issue', prefix: 'GIN', date: input.date, reference: input.reference, meta: { reason: input.reason }, auditEvent: 'issue-posted' }),

        postTransfer: (input) =>
          commit(buildTransferPlan(context(input), input), { kind: 'transfer', prefix: 'TRF', date: input.date, reference: input.reference, meta: { source: input.sourceWarehouseId, destination: input.destinationWarehouseId }, auditEvent: 'transfer-posted' }),

        postAdjustment: (input) =>
          commit(buildAdjustmentPlan(context(input), input), { kind: 'adjustment', prefix: 'ADJ', date: input.date, reference: input.reference, meta: { reason: input.reason }, auditEvent: 'adjustment-posted' }),

        postStockCount: (input) =>
          commit(buildStockCountPlan(context(input), input), { kind: 'count', prefix: 'CNT', date: input.date, reference: input.reference, meta: { warehouseId: input.warehouseId }, auditEvent: 'count-posted' }),

        /* ── Sales / purchase integration ─────────────────────────────────── */
        postBillReceipt: (input) =>
          commit(buildBillReceiptPlan(context(input), input), { kind: 'bill-receipt', prefix: 'GRN', date: input.date, reference: input.reference, auditEvent: 'bill-receipt-posted' }),

        postInvoiceIssue: (input) => {
          const plan = buildInvoiceIssuePlan(context(input), input);
          if (plan.ok && plan.movements.length === 0) return { ok: true, movementIds: [] }; // all service lines — nothing to post
          return commit(plan, { kind: 'invoice-issue', prefix: 'GIN', date: input.date, reference: input.reference, auditEvent: 'invoice-issue-posted' });
        },

        postCustomerReturn: (input) => {
          const plan = buildCustomerReturnPlan(context(input), input);
          if (plan.ok && plan.movements.length === 0) return { ok: true, movementIds: [] };
          return commit(plan, { kind: 'customer-return', prefix: 'GRN', date: input.date, reference: input.reference, auditEvent: 'customer-return-posted' });
        },

        postSupplierReturn: (input) => {
          const plan = buildSupplierReturnPlan(context(input), input);
          if (plan.ok && plan.movements.length === 0) return { ok: true, movementIds: [] };
          return commit(plan, { kind: 'supplier-return', prefix: 'GIN', date: input.date, reference: input.reference, auditEvent: 'supplier-return-posted' });
        },

        recordLinkedMovements: (input) => {
          const s = get();
          const accounts = useStore.getState().accounts;
          const plans: MovementPlan[] = [];
          const woByPlan: (string | undefined)[] = [];
          for (const line of input.lines) {
            const item = s.items.find((i) => i.id === line.itemId);
            const wh = s.warehouses.find((w) => w.id === line.warehouseId);
            if (!item || !wh || !isStockTracked(item) || line.quantity <= 0) continue;
            if (line.direction === 'out') {
              const policy = effectiveNegativePolicy(s.settings, wh, item);
              const avail = validateAvailableStock({ movements: s.movements, entityId: ENTITY, itemId: item.id, warehouseId: wh.id, quantity: line.quantity, policy });
              if (!avail.ok) return { ok: false, error: avail.error };
            }
            const category = s.categories.find((c) => c.id === item.categoryId);
            const acc = resolveInventoryAccounts({ accounts, item, category, settings: s.settings });
            woByPlan.push(line.workOrderId);
            plans.push({
              movementType: input.movementType ?? LINKED_MOVEMENT_TYPE[input.kind],
              direction: line.direction,
              itemId: item.id,
              warehouseId: wh.id,
              quantity: line.quantity,
              baseUnitId: item.baseUnitId,
              unitCostBase: roundCost(line.unitCost, 6),
              totalCostBase: roundCost(line.quantity * line.unitCost, 2),
              sourceDocumentType: LINKED_SOURCE_TYPE[input.kind],
              sourceLineId: line.id,
              itemSnapshot: { code: item.code, name: item.name, itemType: item.itemType, baseUnitCode: s.units.find((u) => u.id === item.baseUnitId)?.code ?? '' },
              warehouseSnapshot: { code: wh.code, name: wh.name },
              accountSnapshot: { inventoryAccountId: acc.inventory, cogsAccountId: acc.cogs, adjustmentAccountId: acc.inventoryLoss },
            });
          }
          if (plans.length === 0) return { ok: true, movementIds: [] };

          const docId = generateId('idoc');
          const movements = materializeMovements(plans, docId, input.journalEntryId, undefined).map((m, idx) => ({ ...m, postingDate: input.date, movementDate: input.date, manufacturingWorkOrderId: woByPlan[idx] }));
          const number = nextNumber(prefixFor(input.kind), get().documents.filter((d) => d.kind === input.kind).map((d) => d.number), input.date);
          const doc: InventoryDocumentRecord = {
            id: docId, entityId: ENTITY, kind: input.kind, number, date: input.date, reference: input.reference,
            status: 'posted', journalEntryId: input.journalEntryId, externalJournal: true,
            movementIds: movements.map((m) => m.id), total: plans.reduce((sum, p) => sum + p.totalCostBase, 0), postedAt: nowIso(),
          };
          set((st) => ({
            movements: [...st.movements, ...movements],
            documents: [...st.documents, doc],
            auditTrail: [...st.auditTrail, audit(input.kind === 'bill-receipt' ? 'bill-receipt-posted' : input.kind === 'customer-return' ? 'customer-return-posted' : input.kind === 'supplier-return' ? 'supplier-return-posted' : 'issue-posted', `${input.kind} ${number} recorded (${movements.length} movement(s), external journal).`, { documentId: docId })],
          }));
          return { ok: true, id: docId, journalEntryId: input.journalEntryId, movementIds: doc.movementIds };
        },

        /* ── Reversal ─────────────────────────────────────────────────────── */
        reverseDocument: (documentId) => {
          const doc = get().documents.find((d) => d.id === documentId);
          if (!doc) return { ok: false, error: 'Document not found.' };
          if (doc.status === 'reversed') return { ok: false, error: 'Document is already reversed.' };
          const originals = get().movements.filter((m) => doc.movementIds.includes(m.id));

          // Guard: every original inbound must still be reversible (not consumed).
          for (const m of originals) {
            const wh = get().warehouses.find((w) => w.id === m.warehouseId);
            const allowNeg = get().settings.negativeStockPolicy === 'allow' || !!wh?.allowNegativeStock;
            const check = canReverseMovement(m, get().movements, allowNeg);
            if (!check.ok) return { ok: false, error: check.error };
          }

          // Reverse the journal (swap dr/cr) and post it — but NOT when the
          // journal is owned by a source document (bill/CN/SC): that document
          // reverses its own journal when it is voided.
          let reversalJournalId: string | undefined;
          if (doc.journalEntryId && !doc.externalJournal) {
            const rev = useJournalStore.getState().reverseEntry(doc.journalEntryId);
            if (!rev.ok || !rev.id) return { ok: false, error: rev.error ?? 'Journal reversal failed.' };
            const posted = useJournalStore.getState().postEntry(rev.id);
            if (!posted.ok) return { ok: false, error: posted.error };
            reversalJournalId = rev.id;
          }

          const now = nowIso();
          const existingNumbers = get().movements.map((m) => m.movementNumber);
          const reversalMovements: StockMovement[] = originals.map((m, idx) => {
            const number = nextNumber('MOV', [...existingNumbers, ...Array.from({ length: idx }, (_, i) => `MOV-tmp-${i}`)]);
            existingNumbers.push(number);
            const id = generateId('mov');
            // The counter-movement is an audit/GL-link record; the reversed pair
            // is excluded from the live balance so stock is exactly restored.
            return { ...buildReversalMovement(m), id, movementNumber: number, createdAt: now, sourceDocumentId: documentId, journalEntryId: reversalJournalId, status: 'reversed' as const };
          });
          const reversalDocId = generateId('idoc');
          const reversalDoc: InventoryDocumentRecord = {
            id: reversalDocId,
            entityId: ENTITY,
            kind: doc.kind,
            number: nextNumber(prefixFor(doc.kind), get().documents.filter((d) => d.kind === doc.kind).map((d) => d.number), doc.date),
            date: now.slice(0, 10),
            reference: `REV-${doc.number}`,
            status: 'posted',
            journalEntryId: reversalJournalId,
            movementIds: reversalMovements.map((m) => m.id),
            reversalOfId: doc.id,
            total: doc.total,
            postedAt: now,
          };
          set((s) => ({
            movements: [
              ...s.movements.map((m) => (doc.movementIds.includes(m.id) ? { ...m, status: 'reversed' as const, reversedByMovementId: reversalMovements.find((r) => r.reversalOfMovementId === m.id)?.id } : m)),
              ...reversalMovements,
            ],
            documents: [...s.documents.map((d) => (d.id === doc.id ? { ...d, status: 'reversed' as const, reversedById: reversalDocId } : d)), reversalDoc],
            auditTrail: [...s.auditTrail, audit(reversalEventFor(doc.kind), `${doc.kind} ${doc.number} reversed.`, { documentId: doc.id })],
          }));
          return { ok: true, id: reversalDocId, journalEntryId: reversalJournalId };
        },

        resetToDefault: () => set({ ...blankState() }),
      };
    },
    {
      name: 'ledgora-inventory',
      version: 1,
      partialize: (s) => ({
        items: s.items,
        categories: s.categories,
        units: s.units,
        warehouses: s.warehouses,
        movements: s.movements,
        documents: s.documents,
        settings: s.settings,
        auditTrail: s.auditTrail,
        seeded: s.seeded,
      }),
    },
  ),
);

function prefixFor(kind: InventoryDocumentKind): InventorySeqPrefix {
  switch (kind) {
    case 'opening': return 'OPN';
    case 'receipt': case 'bill-receipt': case 'customer-return': case 'mfg-return': case 'mfg-receipt': return 'GRN';
    case 'issue': case 'invoice-issue': case 'supplier-return': case 'mfg-issue': case 'mfg-scrap': return 'GIN';
    case 'transfer': return 'TRF';
    case 'adjustment': return 'ADJ';
    case 'count': return 'CNT';
  }
}

function reversalEventFor(kind: InventoryDocumentKind): InventoryAuditEvent {
  switch (kind) {
    case 'receipt': case 'bill-receipt': return 'receipt-reversed';
    case 'issue': case 'invoice-issue': return 'issue-reversed';
    case 'transfer': return 'transfer-reversed';
    case 'adjustment': return 'adjustment-reversed';
    case 'count': return 'count-reversed';
    default: return 'adjustment-reversed';
  }
}

/** Whether the active organization is entitled to inventory (gates document hooks). */
export function inventoryEnabled(): boolean {
  return useEntitlementStore.getState().effectiveModuleIds.includes('inventory_basic');
}

/** Selector-safe helpers (call from useMemo / imperatively). */
export function isInventoryTrackedItem(item: InventoryItem): boolean {
  return isStockTracked(item);
}
export function warehouseHasStock(movements: StockMovement[], warehouseId: string): boolean {
  return movements.some((m) => m.warehouseId === warehouseId && m.status !== 'reversed');
}
