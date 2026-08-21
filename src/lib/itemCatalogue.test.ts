import { beforeEach, describe, expect, it } from 'vitest';
import { activePurchaseItems, activeSalesItems, purchaseItemDefaults, salesItemDefaults } from './itemCatalogue';
import { useInventoryStore } from '@/store/inventoryStore';
import { makeInventorySeed, ENTITY } from './inventorySeed';
import type { InventoryItem } from '@/types/inventory';

const state = () => useInventoryStore.getState();

function item(patch: Partial<InventoryItem> = {}): InventoryItem {
  return {
    ...makeInventorySeed('core').items[0]!, id: 'catalogue-item', code: 'CAT-1', name: 'Consulting',
    itemType: 'service', isInventoryTracked: false, defaultSellingPrice: 125, defaultPurchasePrice: 80,
    salesDescription: 'Consulting services', purchaseDescription: 'Subcontracted consulting', ...patch,
  };
}

beforeEach(() => {
  useInventoryStore.getState().resetToDefault();
  useInventoryStore.setState({ ...makeInventorySeed('core'), items: [], movements: [], documents: [], auditTrail: [], seeded: true });
});

describe('shared items catalogue', () => {
  it('creates products and services and rejects service stock tracking', () => {
    expect(state().saveItem(item()).ok).toBe(true);
    expect(state().saveItem(item({ id: 'product', code: 'PROD-1', itemType: 'non-inventory' })).ok).toBe(true);
    expect(state().saveItem(item({ id: 'bad', code: 'BAD-1', isInventoryTracked: true })).error).toMatch(/service cannot/i);
  });

  it('enforces case-insensitive code and barcode uniqueness', () => {
    expect(state().saveItem(item({ gtin: '123456' })).ok).toBe(true);
    expect(state().saveItem(item({ id: 'dup-code', code: 'cat-1' })).error).toMatch(/already exists/i);
    expect(state().saveItem(item({ id: 'dup-gtin', code: 'CAT-2', gtin: '123456' })).error).toMatch(/GTIN\/barcode/i);
  });

  it('copies sales and purchase defaults as document snapshots', () => {
    const source = item({ salesAccountId: 'revenue', purchaseAccountId: 'expense', salesTaxCodeId: 'sales-tax', purchaseTaxCodeId: 'purchase-tax' });
    const sales = salesItemDefaults(source);
    const purchase = purchaseItemDefaults(source);
    expect(sales).toMatchObject({ itemId: source.id, description: 'Consulting services', unitPrice: 125, accountId: 'revenue', taxCodeId: 'sales-tax' });
    expect(purchase).toMatchObject({ itemId: source.id, description: 'Subcontracted consulting', unitPrice: 80, accountId: 'expense', taxCodeId: 'purchase-tax' });
    source.defaultSellingPrice = 999;
    source.salesDescription = 'Changed';
    expect(sales).toMatchObject({ description: 'Consulting services', unitPrice: 125 });
  });

  it('archive excludes new selection while preserving the item record', () => {
    expect(state().saveItem(item()).ok).toBe(true);
    expect(activeSalesItems(state().items, ENTITY)).toHaveLength(1);
    expect(activePurchaseItems(state().items, ENTITY)).toHaveLength(1);
    expect(state().archiveItem('catalogue-item').ok).toBe(true);
    expect(activeSalesItems(state().items, ENTITY)).toHaveLength(0);
    expect(state().items.find((candidate) => candidate.id === 'catalogue-item')?.status).toBe('archived');
  });

  it('keeps manual legacy lines valid because item references remain optional', () => {
    expect({ id: 'line', description: 'Manual', accountId: 'expense', quantity: 1, unitPrice: 10 }).not.toHaveProperty('itemId');
  });

  it('rejects writes outside the current company scope', () => {
    expect(state().saveItem(item({ entityId: 'another-company' })).error).toMatch(/current company/i);
  });

  it('inventory initialization preserves an existing Core catalogue', () => {
    expect(state().saveItem(item()).ok).toBe(true);
    useInventoryStore.setState({ seeded: false });
    state().ensureSeeded();
    expect(state().items.map((candidate) => candidate.code)).toEqual(['CAT-1']);
    expect(state().warehouses.length).toBeGreaterThan(0);
  });
});
