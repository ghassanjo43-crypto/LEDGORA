/**
 * Inventory posting orchestration.
 *
 * Each builder produces an atomic PLAN: the stock movements to create AND the
 * journal lines to post. The store commits both together (or neither). Quantity
 * comes from movements, value from the valuation engine, and every accounting
 * value posts through the existing General Journal — the GL is never written
 * directly.
 *
 * Weighted-average rules: outbound movements are costed at the average at the
 * time they post; a running Coster advances line-by-line so multi-line documents
 * are internally consistent. Returns and reversals use the ORIGINAL cost.
 */
import type { Account } from '@/types';
import type {
  InventoryItem,
  InventorySettings,
  ItemCategory,
  StockMovement,
  StockMovementType,
  StockSourceDocumentType,
  UnitOfMeasure,
  Warehouse,
} from '@/types/inventory';
import { resolveInventoryAccounts } from './inventoryAccounts';
import { applyInbound, applyOutbound, replayMovements, roundCost, type ValuationState, EMPTY_STATE } from './inventoryValuation';
import { effectiveNegativePolicy, isStockTracked, validateAvailableStock } from './inventoryValidation';

export interface JournalLinePlan {
  accountId: string;
  debit: number;
  credit: number;
  description?: string;
  projectId?: string;
  costCenterId?: string;
  taxCode?: string;
}

export interface JournalPlan {
  date: string;
  reference: string;
  description: string;
  currency: string;
  exchangeRate: number;
  transactionType: string;
  lines: JournalLinePlan[];
}

export interface MovementPlan {
  movementType: StockMovementType;
  direction: 'in' | 'out';
  itemId: string;
  warehouseId: string;
  quantity: number;
  baseUnitId: string;
  unitCostBase: number;
  totalCostBase: number;
  sourceDocumentType: StockSourceDocumentType;
  sourceLineId?: string;
  projectId?: string;
  costCenterId?: string;
  documentCurrency?: string;
  documentUnitCost?: number;
  exchangeRate?: number;
  reversalOfMovementId?: string;
  itemSnapshot: StockMovement['itemSnapshot'];
  warehouseSnapshot: StockMovement['warehouseSnapshot'];
  accountSnapshot: StockMovement['accountSnapshot'];
}

export interface PostingPlan {
  ok: boolean;
  error?: string;
  /** Undefined when a document needs no accounting (e.g. same-account transfer). */
  journal?: JournalPlan;
  movements: MovementPlan[];
}

export interface PostingContext {
  entityId: string;
  accounts: Account[];
  items: InventoryItem[];
  categories: ItemCategory[];
  warehouses: Warehouse[];
  units: UnitOfMeasure[];
  settings: InventorySettings;
  /** Posted movements prior to this document (for costing + negative checks). */
  priorMovements: StockMovement[];
  today: string;
  currency: string;
  exchangeRate: number;
}

function fail(error: string): PostingPlan {
  return { ok: false, error, movements: [] };
}

/* ── Lookups ──────────────────────────────────────────────────────────────── */

function itemOf(ctx: PostingContext, id: string): InventoryItem | undefined {
  return ctx.items.find((i) => i.id === id);
}
function warehouseOf(ctx: PostingContext, id: string): Warehouse | undefined {
  return ctx.warehouses.find((w) => w.id === id);
}
function unitCode(ctx: PostingContext, id: string): string {
  return ctx.units.find((u) => u.id === id)?.code ?? '';
}
function accountsFor(ctx: PostingContext, item: InventoryItem) {
  const category = ctx.categories.find((c) => c.id === item.categoryId);
  return resolveInventoryAccounts({ accounts: ctx.accounts, item, category, settings: ctx.settings });
}
function itemSnapshot(ctx: PostingContext, item: InventoryItem): StockMovement['itemSnapshot'] {
  return { code: item.code, name: item.name, itemType: item.itemType, baseUnitCode: unitCode(ctx, item.baseUnitId) };
}
function warehouseSnapshot(w: Warehouse): StockMovement['warehouseSnapshot'] {
  return { code: w.code, name: w.name };
}

/* ── Running weighted-average coster (per item, company-wide) ─────────────── */

class Coster {
  private states = new Map<string, ValuationState>();
  constructor(private ctx: PostingContext) {}

  private state(itemId: string): ValuationState {
    let s = this.states.get(itemId);
    if (!s) {
      s = replayMovements(this.ctx.priorMovements.filter((m) => m.itemId === itemId));
      this.states.set(itemId, s);
    }
    return s;
  }
  avg(itemId: string): number {
    return this.state(itemId).averageCost;
  }
  receive(itemId: string, qty: number, unitCost: number): void {
    this.states.set(itemId, applyInbound(this.state(itemId), qty, unitCost));
  }
  consume(itemId: string, qty: number, explicitCost?: number): number {
    const res = applyOutbound(this.state(itemId), qty, explicitCost);
    this.states.set(itemId, res.state);
    return res.unitCost;
  }
}

/** Merge journal lines that share account + dimensions; drop zero lines. */
function aggregate(lines: JournalLinePlan[]): JournalLinePlan[] {
  const map = new Map<string, JournalLinePlan>();
  for (const l of lines) {
    const key = `${l.accountId}|${l.projectId ?? ''}|${l.costCenterId ?? ''}`;
    const cur = map.get(key);
    if (cur) {
      cur.debit = roundCost(cur.debit + l.debit, 2);
      cur.credit = roundCost(cur.credit + l.credit, 2);
    } else {
      map.set(key, { ...l, debit: roundCost(l.debit, 2), credit: roundCost(l.credit, 2) });
    }
  }
  return [...map.values()].filter((l) => l.debit !== 0 || l.credit !== 0);
}

/* ── Opening balance ──────────────────────────────────────────────────────── */

export interface OpeningLineInput {
  id: string;
  itemId: string;
  warehouseId: string;
  quantity: number;
  unitId: string;
  unitCost: number;
}

export function buildOpeningBalancePlan(
  ctx: PostingContext,
  input: { date: string; reference: string; lines: OpeningLineInput[] },
): PostingPlan {
  if (input.lines.length === 0) return fail('Add at least one opening line.');
  const movements: MovementPlan[] = [];
  const jlines: JournalLinePlan[] = [];
  for (const line of input.lines) {
    const item = itemOf(ctx, line.itemId);
    const wh = warehouseOf(ctx, line.warehouseId);
    if (!item || !wh) return fail('Opening line references a missing item or warehouse.');
    if (!isStockTracked(item)) return fail(`"${item.code}" is not a stock-tracked item.`);
    if (line.quantity <= 0 || line.unitCost < 0) return fail('Opening quantity and cost must be valid.');
    const acc = accountsFor(ctx, item);
    if (!acc.inventory) return fail(`No inventory account for "${item.code}".`);
    if (!acc.openingEquity) return fail('No opening-balance equity account found.');
    const total = roundCost(line.quantity * line.unitCost, 2);
    movements.push(mv(ctx, {
      movementType: 'opening-balance', direction: 'in', item, warehouse: wh, quantity: line.quantity,
      unitCostBase: line.unitCost, totalCostBase: total, sourceDocumentType: 'opening-balance', sourceLineId: line.id, acc,
    }));
    jlines.push({ accountId: acc.inventory, debit: total, credit: 0, description: `Opening — ${item.code}` });
    jlines.push({ accountId: acc.openingEquity, debit: 0, credit: total, description: `Opening — ${item.code}` });
  }
  return { ok: true, movements, journal: journal(ctx, input.date, input.reference, 'Opening inventory balance', jlines) };
}

/* ── Goods receipt (standalone) ───────────────────────────────────────────── */

export interface ReceiptLineInput {
  id: string;
  itemId: string;
  warehouseId: string;
  quantity: number;
  unitId: string;
  unitCost: number;
  projectId?: string;
  costCenterId?: string;
}

export function buildGoodsReceiptPlan(
  ctx: PostingContext,
  input: { date: string; reference: string; lines: ReceiptLineInput[] },
): PostingPlan {
  if (input.lines.length === 0) return fail('Add at least one receipt line.');
  const movements: MovementPlan[] = [];
  const jlines: JournalLinePlan[] = [];
  for (const line of input.lines) {
    const item = itemOf(ctx, line.itemId);
    const wh = warehouseOf(ctx, line.warehouseId);
    if (!item || !wh) return fail('Receipt line references a missing item or warehouse.');
    if (!isStockTracked(item)) return fail(`"${item.code}" is not stock-tracked and cannot be received.`);
    if (line.quantity <= 0) return fail('Receipt quantity must be greater than zero.');
    const acc = accountsFor(ctx, item);
    if (!acc.inventory) return fail(`No inventory account for "${item.code}".`);
    if (!acc.grni) return fail('No GRNI / clearing account found.');
    const total = roundCost(line.quantity * line.unitCost, 2);
    movements.push(mv(ctx, {
      movementType: 'purchase-receipt', direction: 'in', item, warehouse: wh, quantity: line.quantity,
      unitCostBase: line.unitCost, totalCostBase: total, sourceDocumentType: 'goods-receipt', sourceLineId: line.id, acc,
      projectId: line.projectId, costCenterId: line.costCenterId,
    }));
    jlines.push({ accountId: acc.inventory, debit: total, credit: 0, description: `Receipt — ${item.code}`, projectId: line.projectId });
    jlines.push({ accountId: acc.grni, debit: 0, credit: total, description: `Receipt — ${item.code}` });
  }
  return { ok: true, movements, journal: journal(ctx, input.date, input.reference, 'Goods receipt', jlines) };
}

/* ── Goods issue ──────────────────────────────────────────────────────────── */

export interface IssueLineInput {
  id: string;
  itemId: string;
  warehouseId: string;
  quantity: number;
  unitId: string;
  expenseAccountId?: string;
  projectId?: string;
  costCenterId?: string;
}

export function buildGoodsIssuePlan(
  ctx: PostingContext,
  input: { date: string; reference: string; lines: IssueLineInput[] },
): PostingPlan {
  if (input.lines.length === 0) return fail('Add at least one issue line.');
  const coster = new Coster(ctx);
  const movements: MovementPlan[] = [];
  const jlines: JournalLinePlan[] = [];
  for (const line of input.lines) {
    const item = itemOf(ctx, line.itemId);
    const wh = warehouseOf(ctx, line.warehouseId);
    if (!item || !wh) return fail('Issue line references a missing item or warehouse.');
    if (!isStockTracked(item)) return fail(`"${item.code}" is not stock-tracked and cannot be issued.`);
    const policy = effectiveNegativePolicy(ctx.settings, wh, item);
    const avail = validateAvailableStock({
      movements: ctx.priorMovements, entityId: ctx.entityId, itemId: item.id, warehouseId: wh.id, quantity: line.quantity, policy,
    });
    if (!avail.ok) return fail(avail.error!);
    const acc = accountsFor(ctx, item);
    const expenseAccountId = line.expenseAccountId ?? acc.issueExpense;
    if (!acc.inventory || !expenseAccountId) return fail(`Missing inventory/expense account for "${item.code}".`);
    const unitCost = coster.consume(item.id, line.quantity);
    const total = roundCost(line.quantity * unitCost, 2);
    movements.push(mv(ctx, {
      movementType: 'project-material-issue', direction: 'out', item, warehouse: wh, quantity: line.quantity,
      unitCostBase: unitCost, totalCostBase: total, sourceDocumentType: 'goods-issue', sourceLineId: line.id, acc,
      projectId: line.projectId, costCenterId: line.costCenterId,
    }));
    jlines.push({ accountId: expenseAccountId, debit: total, credit: 0, description: `Issue — ${item.code}`, projectId: line.projectId, costCenterId: line.costCenterId });
    jlines.push({ accountId: acc.inventory, debit: 0, credit: total, description: `Issue — ${item.code}` });
  }
  return { ok: true, movements, journal: journal(ctx, input.date, input.reference, 'Goods issue', jlines) };
}

/* ── Warehouse transfer ───────────────────────────────────────────────────── */

export interface TransferLineInput {
  id: string;
  itemId: string;
  quantity: number;
  unitId: string;
}

export function buildTransferPlan(
  ctx: PostingContext,
  input: { date: string; reference: string; sourceWarehouseId: string; destinationWarehouseId: string; lines: TransferLineInput[] },
): PostingPlan {
  if (input.sourceWarehouseId === input.destinationWarehouseId) return fail('Source and destination must differ.');
  const src = warehouseOf(ctx, input.sourceWarehouseId);
  const dst = warehouseOf(ctx, input.destinationWarehouseId);
  if (!src || !dst) return fail('Transfer references a missing warehouse.');
  if (input.lines.length === 0) return fail('Add at least one transfer line.');
  const coster = new Coster(ctx);
  const movements: MovementPlan[] = [];
  const jlines: JournalLinePlan[] = [];
  for (const line of input.lines) {
    const item = itemOf(ctx, line.itemId);
    if (!item) return fail('Transfer line references a missing item.');
    if (!isStockTracked(item)) return fail(`"${item.code}" is not stock-tracked.`);
    const policy = effectiveNegativePolicy(ctx.settings, src, item);
    const avail = validateAvailableStock({
      movements: ctx.priorMovements, entityId: ctx.entityId, itemId: item.id, warehouseId: src.id, quantity: line.quantity, policy,
    });
    if (!avail.ok) return fail(avail.error!);
    const acc = accountsFor(ctx, item);
    // Same cost on both sides → cost-neutral. Consume advances the running state
    // but the identical inbound restores it, so the average never moves.
    const unitCost = coster.consume(item.id, line.quantity);
    const total = roundCost(line.quantity * unitCost, 2);
    coster.receive(item.id, line.quantity, unitCost);
    movements.push(mv(ctx, {
      movementType: 'warehouse-transfer-out', direction: 'out', item, warehouse: src, quantity: line.quantity,
      unitCostBase: unitCost, totalCostBase: total, sourceDocumentType: 'transfer', sourceLineId: line.id, acc,
    }));
    movements.push(mv(ctx, {
      movementType: 'warehouse-transfer-in', direction: 'in', item, warehouse: dst, quantity: line.quantity,
      unitCostBase: unitCost, totalCostBase: total, sourceDocumentType: 'transfer', sourceLineId: line.id, acc,
    }));
    // No journal when both warehouses share the same inventory account (Phase 1).
    void jlines;
  }
  // Phase 1: single inventory account per item → no P&L, no GL entry.
  return { ok: true, movements };
}

/* ── Stock adjustment ─────────────────────────────────────────────────────── */

export interface AdjustmentLineInput {
  id: string;
  itemId: string;
  warehouseId: string;
  quantity: number; // signed
  unitId: string;
  unitCost?: number;
  costCenterId?: string;
}

export function buildAdjustmentPlan(
  ctx: PostingContext,
  input: { date: string; reference: string; lines: AdjustmentLineInput[] },
): PostingPlan {
  if (input.lines.length === 0) return fail('Add at least one adjustment line.');
  const coster = new Coster(ctx);
  const movements: MovementPlan[] = [];
  const jlines: JournalLinePlan[] = [];
  for (const line of input.lines) {
    const item = itemOf(ctx, line.itemId);
    const wh = warehouseOf(ctx, line.warehouseId);
    if (!item || !wh) return fail('Adjustment line references a missing item or warehouse.');
    if (!isStockTracked(item)) return fail(`"${item.code}" is not stock-tracked.`);
    if (line.quantity === 0) return fail('Adjustment quantity cannot be zero.');
    const acc = accountsFor(ctx, item);
    if (!acc.inventory) return fail(`No inventory account for "${item.code}".`);
    if (line.quantity > 0) {
      const unitCost = line.unitCost ?? coster.avg(item.id) ?? 0;
      const total = roundCost(line.quantity * unitCost, 2);
      coster.receive(item.id, line.quantity, unitCost);
      if (!acc.inventoryGain) return fail('No inventory-gain account found.');
      movements.push(mv(ctx, {
        movementType: 'stock-adjustment-in', direction: 'in', item, warehouse: wh, quantity: line.quantity,
        unitCostBase: unitCost, totalCostBase: total, sourceDocumentType: 'adjustment', sourceLineId: line.id, acc,
        costCenterId: line.costCenterId,
      }));
      jlines.push({ accountId: acc.inventory, debit: total, credit: 0, description: `Adjustment + ${item.code}` });
      jlines.push({ accountId: acc.inventoryGain, debit: 0, credit: total, description: `Adjustment + ${item.code}`, costCenterId: line.costCenterId });
    } else {
      const qty = -line.quantity;
      const policy = effectiveNegativePolicy(ctx.settings, wh, item);
      const avail = validateAvailableStock({ movements: ctx.priorMovements, entityId: ctx.entityId, itemId: item.id, warehouseId: wh.id, quantity: qty, policy });
      if (!avail.ok) return fail(avail.error!);
      const unitCost = coster.consume(item.id, qty);
      const total = roundCost(qty * unitCost, 2);
      if (!acc.inventoryLoss) return fail('No inventory-loss account found.');
      movements.push(mv(ctx, {
        movementType: 'stock-adjustment-out', direction: 'out', item, warehouse: wh, quantity: qty,
        unitCostBase: unitCost, totalCostBase: total, sourceDocumentType: 'adjustment', sourceLineId: line.id, acc,
        costCenterId: line.costCenterId,
      }));
      jlines.push({ accountId: acc.inventoryLoss, debit: total, credit: 0, description: `Adjustment − ${item.code}`, costCenterId: line.costCenterId });
      jlines.push({ accountId: acc.inventory, debit: 0, credit: total, description: `Adjustment − ${item.code}` });
    }
  }
  return { ok: true, movements, journal: journal(ctx, input.date, input.reference, 'Stock adjustment', jlines) };
}

/* ── Stock count (variance posting) ───────────────────────────────────────── */

export interface CountLineInput {
  id: string;
  itemId: string;
  warehouseId: string;
  systemQuantity: number;
  countedQuantity: number;
  frozenUnitCost: number;
}

export function buildStockCountPlan(
  ctx: PostingContext,
  input: { date: string; reference: string; lines: CountLineInput[] },
): PostingPlan {
  const movements: MovementPlan[] = [];
  const jlines: JournalLinePlan[] = [];
  for (const line of input.lines) {
    const variance = roundCost(line.countedQuantity - line.systemQuantity, 6);
    if (variance === 0) continue;
    const item = itemOf(ctx, line.itemId);
    const wh = warehouseOf(ctx, line.warehouseId);
    if (!item || !wh) return fail('Count line references a missing item or warehouse.');
    const acc = accountsFor(ctx, item);
    if (!acc.inventory) return fail(`No inventory account for "${item.code}".`);
    const qty = Math.abs(variance);
    const total = roundCost(qty * line.frozenUnitCost, 2);
    if (variance > 0) {
      if (!acc.inventoryGain) return fail('No inventory-gain account found.');
      movements.push(mv(ctx, {
        movementType: 'stock-count-in', direction: 'in', item, warehouse: wh, quantity: qty,
        unitCostBase: line.frozenUnitCost, totalCostBase: total, sourceDocumentType: 'stock-count', sourceLineId: line.id, acc,
      }));
      jlines.push({ accountId: acc.inventory, debit: total, credit: 0, description: `Count + ${item.code}` });
      jlines.push({ accountId: acc.inventoryGain, debit: 0, credit: total, description: `Count + ${item.code}` });
    } else {
      if (!acc.inventoryLoss) return fail('No inventory-loss account found.');
      movements.push(mv(ctx, {
        movementType: 'stock-count-out', direction: 'out', item, warehouse: wh, quantity: qty,
        unitCostBase: line.frozenUnitCost, totalCostBase: total, sourceDocumentType: 'stock-count', sourceLineId: line.id, acc,
      }));
      jlines.push({ accountId: acc.inventoryLoss, debit: total, credit: 0, description: `Count − ${item.code}` });
      jlines.push({ accountId: acc.inventory, debit: 0, credit: total, description: `Count − ${item.code}` });
    }
  }
  if (movements.length === 0) return fail('No variance to post — counted quantities match the system.');
  return { ok: true, movements, journal: journal(ctx, input.date, input.reference, 'Stock count variance', jlines) };
}

/* ── Bill direct inventory receipt ────────────────────────────────────────── */

export interface BillReceiptLineInput {
  id: string;
  itemId: string;
  warehouseId: string;
  quantity: number;
  unitId: string;
  unitCost: number;
  /** Recoverable input tax for this line (excluded from inventory value). */
  taxAmount?: number;
  taxCode?: string;
}

export function buildBillReceiptPlan(
  ctx: PostingContext,
  input: { date: string; reference: string; lines: BillReceiptLineInput[] },
): PostingPlan {
  if (input.lines.length === 0) return fail('Add at least one bill inventory line.');
  const movements: MovementPlan[] = [];
  const jlines: JournalLinePlan[] = [];
  let payables: string | undefined;
  let recoverableTax = 0;
  let taxAccount: string | undefined;
  for (const line of input.lines) {
    const item = itemOf(ctx, line.itemId);
    const wh = warehouseOf(ctx, line.warehouseId);
    if (!item || !wh) return fail('Bill line references a missing item or warehouse.');
    if (!isStockTracked(item)) return fail(`"${item.code}" is not stock-tracked.`);
    if (line.quantity <= 0) return fail('Bill quantity must be greater than zero.');
    const acc = accountsFor(ctx, item);
    if (!acc.inventory || !acc.payables) return fail(`Missing inventory/payables account for "${item.code}".`);
    payables = acc.payables;
    taxAccount = acc.inputTaxRecoverable;
    const net = roundCost(line.quantity * line.unitCost, 2); // recoverable tax excluded from value
    recoverableTax = roundCost(recoverableTax + (line.taxAmount ?? 0), 2);
    movements.push(mv(ctx, {
      movementType: 'purchase-receipt', direction: 'in', item, warehouse: wh, quantity: line.quantity,
      unitCostBase: line.unitCost, totalCostBase: net, sourceDocumentType: 'bill', sourceLineId: line.id, acc,
      documentCurrency: ctx.currency, documentUnitCost: line.unitCost, exchangeRate: ctx.exchangeRate,
    }));
    jlines.push({ accountId: acc.inventory, debit: net, credit: 0, description: `Bill receipt — ${item.code}` });
  }
  const netTotal = jlines.reduce((s, l) => s + l.debit, 0);
  if (recoverableTax > 0 && taxAccount) {
    jlines.push({ accountId: taxAccount, debit: recoverableTax, credit: 0, description: 'Recoverable input tax' });
  }
  jlines.push({ accountId: payables!, debit: 0, credit: roundCost(netTotal + recoverableTax, 2), description: 'Trade payables' });
  return { ok: true, movements, journal: journal(ctx, input.date, input.reference, 'Bill inventory receipt', jlines) };
}

/* ── Invoice direct inventory issue (COGS side only) ──────────────────────── */

export interface InvoiceIssueLineInput {
  id: string;
  itemId: string;
  warehouseId: string;
  quantity: number;
  unitId: string;
  projectId?: string;
  costCenterId?: string;
}

/**
 * The COGS half of an inventory invoice: Dr COGS / Cr Inventory at average cost,
 * plus the outbound movements. The revenue/tax/receivable half is posted by the
 * invoice itself, so COGS posts exactly once.
 */
export function buildInvoiceIssuePlan(
  ctx: PostingContext,
  input: { date: string; reference: string; lines: InvoiceIssueLineInput[] },
): PostingPlan {
  const coster = new Coster(ctx);
  const movements: MovementPlan[] = [];
  const jlines: JournalLinePlan[] = [];
  for (const line of input.lines) {
    const item = itemOf(ctx, line.itemId);
    const wh = warehouseOf(ctx, line.warehouseId);
    if (!item || !wh) return fail('Invoice line references a missing item or warehouse.');
    if (!isStockTracked(item)) continue; // service/non-inventory → no movement, no COGS
    if (line.quantity <= 0) return fail('Invoice quantity must be greater than zero.');
    const policy = effectiveNegativePolicy(ctx.settings, wh, item);
    const avail = validateAvailableStock({ movements: ctx.priorMovements, entityId: ctx.entityId, itemId: item.id, warehouseId: wh.id, quantity: line.quantity, policy });
    if (!avail.ok) return fail(avail.error!);
    const acc = accountsFor(ctx, item);
    if (!acc.inventory || !acc.cogs) return fail(`Missing inventory/COGS account for "${item.code}".`);
    const unitCost = coster.consume(item.id, line.quantity);
    const total = roundCost(line.quantity * unitCost, 2);
    movements.push(mv(ctx, {
      movementType: 'sales-delivery', direction: 'out', item, warehouse: wh, quantity: line.quantity,
      unitCostBase: unitCost, totalCostBase: total, sourceDocumentType: 'invoice', sourceLineId: line.id, acc,
      projectId: line.projectId, costCenterId: line.costCenterId,
    }));
    jlines.push({ accountId: acc.cogs, debit: total, credit: 0, description: `COGS — ${item.code}`, projectId: line.projectId, costCenterId: line.costCenterId });
    jlines.push({ accountId: acc.inventory, debit: 0, credit: total, description: `COGS — ${item.code}` });
  }
  if (movements.length === 0) return { ok: true, movements: [] }; // all service lines
  return { ok: true, movements, journal: journal(ctx, input.date, input.reference, 'Inventory issue (COGS)', jlines) };
}

/* ── Customer physical return ─────────────────────────────────────────────── */

export interface ReturnLineInput {
  id: string;
  itemId: string;
  warehouseId: string;
  quantity: number;
  unitId: string;
  /** Original issue/receipt cost to reverse at (per unit). */
  originalUnitCost: number;
  /** Original delivered/received quantity and prior returns (over-return guard). */
  originalQuantity: number;
  priorReturnedQuantity?: number;
}

export function buildCustomerReturnPlan(
  ctx: PostingContext,
  input: { date: string; reference: string; lines: ReturnLineInput[] },
): PostingPlan {
  const movements: MovementPlan[] = [];
  const jlines: JournalLinePlan[] = [];
  for (const line of input.lines) {
    const item = itemOf(ctx, line.itemId);
    const wh = warehouseOf(ctx, line.warehouseId);
    if (!item || !wh) return fail('Return line references a missing item or warehouse.');
    if (!isStockTracked(item)) continue;
    const remaining = line.originalQuantity - (line.priorReturnedQuantity ?? 0);
    if (line.quantity > remaining + 1e-9) return fail(`Cannot return ${line.quantity}; only ${remaining} of "${item.code}" remain returnable.`);
    const acc = accountsFor(ctx, item);
    if (!acc.inventory || !acc.cogs) return fail(`Missing inventory/COGS account for "${item.code}".`);
    const total = roundCost(line.quantity * line.originalUnitCost, 2);
    movements.push(mv(ctx, {
      movementType: 'sales-return', direction: 'in', item, warehouse: wh, quantity: line.quantity,
      unitCostBase: line.originalUnitCost, totalCostBase: total, sourceDocumentType: 'credit-note', sourceLineId: line.id, acc,
    }));
    jlines.push({ accountId: acc.inventory, debit: total, credit: 0, description: `Return in — ${item.code}` });
    jlines.push({ accountId: acc.cogs, debit: 0, credit: total, description: `Reverse COGS — ${item.code}` });
  }
  if (movements.length === 0) return { ok: true, movements: [] };
  return { ok: true, movements, journal: journal(ctx, input.date, input.reference, 'Customer return to inventory', jlines) };
}

/* ── Supplier physical return ─────────────────────────────────────────────── */

export function buildSupplierReturnPlan(
  ctx: PostingContext,
  input: { date: string; reference: string; lines: ReturnLineInput[] },
): PostingPlan {
  const movements: MovementPlan[] = [];
  const jlines: JournalLinePlan[] = [];
  for (const line of input.lines) {
    const item = itemOf(ctx, line.itemId);
    const wh = warehouseOf(ctx, line.warehouseId);
    if (!item || !wh) return fail('Return line references a missing item or warehouse.');
    if (!isStockTracked(item)) continue;
    const remaining = line.originalQuantity - (line.priorReturnedQuantity ?? 0);
    if (line.quantity > remaining + 1e-9) return fail(`Cannot return ${line.quantity}; only ${remaining} of "${item.code}" received remain returnable.`);
    const policy = effectiveNegativePolicy(ctx.settings, wh, item);
    const avail = validateAvailableStock({ movements: ctx.priorMovements, entityId: ctx.entityId, itemId: item.id, warehouseId: wh.id, quantity: line.quantity, policy });
    if (!avail.ok) return fail(avail.error!);
    const acc = accountsFor(ctx, item);
    if (!acc.inventory || !acc.payables) return fail(`Missing inventory/payables account for "${item.code}".`);
    const total = roundCost(line.quantity * line.originalUnitCost, 2);
    movements.push(mv(ctx, {
      movementType: 'purchase-return', direction: 'out', item, warehouse: wh, quantity: line.quantity,
      unitCostBase: line.originalUnitCost, totalCostBase: total, sourceDocumentType: 'supplier-credit', sourceLineId: line.id, acc,
    }));
    jlines.push({ accountId: acc.payables, debit: total, credit: 0, description: `Supplier return — ${item.code}` });
    jlines.push({ accountId: acc.inventory, debit: 0, credit: total, description: `Supplier return — ${item.code}` });
  }
  if (movements.length === 0) return { ok: true, movements: [] };
  return { ok: true, movements, journal: journal(ctx, input.date, input.reference, 'Supplier return from inventory', jlines) };
}

/* ── Builders (movement + journal) ────────────────────────────────────────── */

function mv(
  ctx: PostingContext,
  p: {
    movementType: StockMovementType;
    movementTypeOverride?: StockMovementType;
    direction: 'in' | 'out';
    item: InventoryItem;
    warehouse: Warehouse;
    quantity: number;
    unitCostBase: number;
    totalCostBase: number;
    sourceDocumentType: StockSourceDocumentType;
    sourceLineId?: string;
    projectId?: string;
    costCenterId?: string;
    documentCurrency?: string;
    documentUnitCost?: number;
    exchangeRate?: number;
    acc: ReturnType<typeof resolveInventoryAccounts>;
  },
): MovementPlan {
  return {
    movementType: p.movementTypeOverride ?? p.movementType,
    direction: p.direction,
    itemId: p.item.id,
    warehouseId: p.warehouse.id,
    quantity: p.quantity,
    baseUnitId: p.item.baseUnitId,
    unitCostBase: roundCost(p.unitCostBase, 6),
    totalCostBase: roundCost(p.totalCostBase, 2),
    sourceDocumentType: p.sourceDocumentType,
    sourceLineId: p.sourceLineId,
    projectId: p.projectId,
    costCenterId: p.costCenterId,
    documentCurrency: p.documentCurrency,
    documentUnitCost: p.documentUnitCost,
    exchangeRate: p.exchangeRate,
    itemSnapshot: itemSnapshot(ctx, p.item),
    warehouseSnapshot: warehouseSnapshot(p.warehouse),
    accountSnapshot: { inventoryAccountId: p.acc.inventory, cogsAccountId: p.acc.cogs, adjustmentAccountId: p.acc.inventoryLoss },
  };
}

function journal(ctx: PostingContext, date: string, reference: string, description: string, rawLines: JournalLinePlan[]): JournalPlan {
  return {
    date,
    reference,
    description,
    currency: ctx.currency,
    exchangeRate: ctx.exchangeRate,
    transactionType: 'Inventory',
    lines: aggregate(rawLines),
  };
}

/** Total debits/credits of a plan (used by the store to assert balance). */
export function planTotals(journal: JournalPlan | undefined): { debit: number; credit: number } {
  if (!journal) return { debit: 0, credit: 0 };
  return journal.lines.reduce(
    (t, l) => ({ debit: roundCost(t.debit + l.debit, 2), credit: roundCost(t.credit + l.credit, 2) }),
    { debit: 0, credit: 0 },
  );
}

export { EMPTY_STATE };
