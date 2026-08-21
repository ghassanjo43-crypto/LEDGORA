import type { BillLine } from '@/types/bill';
import type { InvoiceLine } from '@/types/invoice';
import type { InventoryItem } from '@/types/inventory';
import type { Account } from '@/types';
import { postingAccountEligibility, type AccountPurpose } from '@/lib/accountEligibility';

export function itemClassification(item: InventoryItem): 'product' | 'service' {
  return item.itemType === 'service' ? 'service' : 'product';
}

export function salesItemDefaults(item: InventoryItem): Partial<InvoiceLine> {
  return {
    itemId: item.id,
    description: item.salesDescription?.trim() || item.description?.trim() || item.name,
    unitPrice: item.defaultSellingPrice ?? 0,
    unit: item.salesUnitId ?? item.baseUnitId,
    accountId: item.salesAccountId ?? '',
    taxCodeId: item.salesTaxCodeId ?? item.defaultTaxCodeId,
  };
}

export function purchaseItemDefaults(item: InventoryItem): Partial<BillLine> {
  return {
    itemId: item.id,
    description: item.purchaseDescription?.trim() || item.description?.trim() || item.name,
    unitPrice: item.defaultPurchasePrice ?? item.standardCost ?? 0,
    unit: item.purchaseUnitId ?? item.baseUnitId,
    accountId: item.purchaseAccountId ?? '',
    taxCodeId: item.purchaseTaxCodeId ?? item.defaultTaxCodeId,
  };
}

export function activeSalesItems(items: InventoryItem[], entityId: string): InventoryItem[] {
  return items.filter((item) => item.entityId === entityId && item.status === 'active' && item.isSellable);
}

export function activePurchaseItems(items: InventoryItem[], entityId: string): InventoryItem[] {
  return items.filter((item) => item.entityId === entityId && item.status === 'active' && item.isPurchasable);
}

const ITEM_ACCOUNT_FIELDS: Array<{ field: keyof InventoryItem; label: string; purpose: AccountPurpose }> = [
  { field: 'salesAccountId', label: 'Sales/revenue account', purpose: 'revenue' },
  { field: 'purchaseAccountId', label: 'Purchase/expense account', purpose: 'purchase-expense' },
  { field: 'inventoryAccountId', label: 'Inventory asset account', purpose: 'inventory-asset' },
  { field: 'costOfGoodsSoldAccountId', label: 'COGS account', purpose: 'cogs' },
  { field: 'inventoryAdjustmentAccountId', label: 'Inventory adjustment account', purpose: 'purchase-expense' },
  { field: 'salesReturnAccountId', label: 'Sales-return account', purpose: 'revenue' },
  { field: 'purchaseReturnAccountId', label: 'Purchase-return account', purpose: 'purchase-expense' },
  { field: 'inventoryWriteOffAccountId', label: 'Inventory write-off account', purpose: 'purchase-expense' },
  { field: 'inventoryGainAccountId', label: 'Inventory gain account', purpose: 'purchase-expense' },
];

export interface ItemAccountMappingIssue { field: keyof InventoryItem; accountId: string; message: string }

/** Validates every populated mapping without mutating or substituting legacy references. */
export function validateItemAccountMappings(item: InventoryItem, accounts: readonly Account[]): ItemAccountMappingIssue[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  return ITEM_ACCOUNT_FIELDS.flatMap(({ field, label, purpose }) => {
    const accountId = item[field];
    if (typeof accountId !== 'string' || !accountId) return [];
    const result = postingAccountEligibility(byId.get(accountId), { accounts, purpose });
    if (result.eligible) return [];
    const account = byId.get(accountId);
    const identity = account ? `${account.code} — ${account.name}` : accountId;
    return [{ field, accountId, message: `${label} (${identity}): ${result.message}` }];
  });
}
