import type { BillLine } from '@/types/bill';
import type { InvoiceLine } from '@/types/invoice';
import type { InventoryItem } from '@/types/inventory';

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
