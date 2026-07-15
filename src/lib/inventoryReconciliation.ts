/**
 * Inventory-to-General-Ledger reconciliation (mandatory report).
 *
 * Compares the inventory SUBLEDGER value (derived from posted stock movements
 * via the valuation engine) against the GL BALANCE of the inventory control
 * account(s) (derived from posted journal entries). Any difference is surfaced,
 * never hidden, and is drillable by account.
 */
import type { StockMovement } from '@/types/inventory';
import type { JournalEntry } from '@/types/journal';
import { getInventoryValue } from './inventoryBalance';

export interface ReconciliationAccountRow {
  accountId: string;
  subledgerValue: number;
  glBalance: number;
  difference: number;
}

export interface InventoryReconciliation {
  entityId: string;
  asOfDate?: string;
  subledgerValue: number;
  glBalance: number;
  difference: number;
  balanced: boolean;
  byAccount: ReconciliationAccountRow[];
}

export interface ReconciliationInput {
  entityId: string;
  movements: StockMovement[];
  journalEntries: JournalEntry[];
  /** Restrict to these inventory accounts; defaults to those seen on movements. */
  inventoryAccountIds?: string[];
  warehouseId?: string;
  itemId?: string;
  asOfDate?: string;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** The inventory account an item posts to (from its movement snapshots). */
function itemInventoryAccount(movements: StockMovement[], itemId: string): string | undefined {
  for (const m of movements) {
    if (m.itemId === itemId && m.accountSnapshot.inventoryAccountId) return m.accountSnapshot.inventoryAccountId;
  }
  return undefined;
}

/** Posted GL balance (debit − credit) of an account up to an as-of date. */
function glBalanceOf(entries: JournalEntry[], accountId: string, asOfDate?: string): number {
  let bal = 0;
  for (const e of entries) {
    if (e.status !== 'posted') continue;
    if (asOfDate && e.entryDate > asOfDate) continue;
    for (const l of e.lines) {
      if (l.accountId === accountId) bal += (l.debit || 0) - (l.credit || 0);
    }
  }
  return round2(bal);
}

export function buildInventoryReconciliation(input: ReconciliationInput): InventoryReconciliation {
  const scoped = input.movements.filter(
    (m) =>
      m.entityId === input.entityId &&
      (!input.warehouseId || m.warehouseId === input.warehouseId) &&
      (!input.itemId || m.itemId === input.itemId),
  );

  const accountIds = new Set<string>(input.inventoryAccountIds ?? []);
  for (const m of scoped) if (m.accountSnapshot.inventoryAccountId) accountIds.add(m.accountSnapshot.inventoryAccountId);

  const items = new Set(scoped.map((m) => m.itemId));

  const subledgerByAccount = new Map<string, number>();
  for (const itemId of items) {
    const account = itemInventoryAccount(scoped, itemId);
    if (!account) continue;
    const value = getInventoryValue(scoped, {
      entityId: input.entityId,
      itemId,
      warehouseId: input.warehouseId,
      asOfDate: input.asOfDate,
    });
    subledgerByAccount.set(account, round2((subledgerByAccount.get(account) ?? 0) + value));
  }

  const byAccount: ReconciliationAccountRow[] = [...accountIds].map((accountId) => {
    const subledgerValue = round2(subledgerByAccount.get(accountId) ?? 0);
    // The journal has no warehouse/item scope, so a per-warehouse/item filter
    // compares the subledger slice against the full GL account balance — any
    // difference is surfaced rather than hidden.
    const glBalance = glBalanceOf(input.journalEntries, accountId, input.asOfDate);
    return { accountId, subledgerValue, glBalance, difference: round2(subledgerValue - glBalance) };
  });

  const subledgerValue = round2(byAccount.reduce((s, r) => s + r.subledgerValue, 0));
  const glBalance = round2(byAccount.reduce((s, r) => s + r.glBalance, 0));
  const difference = round2(subledgerValue - glBalance);
  return {
    entityId: input.entityId,
    asOfDate: input.asOfDate,
    subledgerValue,
    glBalance,
    difference,
    balanced: Math.abs(difference) < 0.005,
    byAccount: byAccount.sort((a, b) => a.accountId.localeCompare(b.accountId)),
  };
}
