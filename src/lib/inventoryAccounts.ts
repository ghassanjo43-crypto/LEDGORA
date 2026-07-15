/**
 * Resolve the General Ledger accounts an inventory posting needs, in priority
 * order: explicit item mapping → item category default → inventory settings →
 * a well-known Chart-of-Accounts code. Everything posts through the existing
 * journal; the GL is never touched directly.
 */
import type { Account } from '@/types';
import type { InventoryItem, ItemCategory, InventorySettings } from '@/types/inventory';

/** Well-known seeded COA codes used as the final fallback. */
export const WELL_KNOWN_CODES = {
  inventory: '1213', // Finished goods
  inventoryRaw: '1211', // Raw materials
  inventoryWip: '1212', // Work in progress
  cogs: '5500', // Cost of goods sold
  inventoryWriteOff: '5600', // Inventory write-downs
  inventoryLoss: '5600',
  inventoryGain: '4300', // Other operating income
  revenue: '4110', // Product sales
  salesReturns: '4130', // Sales returns and allowances
  receivables: '1221', // Trade receivables
  payables: '2210', // Trade payables
  outputTax: '2270', // VAT / sales tax payable
  inputTaxRecoverable: '2270',
  openingEquity: '9400', // Opening balance equity
} as const;

export type InventoryAccountRole = keyof typeof WELL_KNOWN_CODES | 'issueExpense' | 'grni';

export interface AccountResolutionContext {
  accounts: Account[];
  item?: InventoryItem;
  category?: ItemCategory;
  settings?: InventorySettings;
}

function byCode(accounts: Account[], code: string): string | undefined {
  return accounts.find((a) => a.code === code && a.isPostingAccount)?.id;
}

/** The default inventory asset account for an item, by its type. */
function inventoryCodeForItem(item?: InventoryItem): string {
  switch (item?.itemType) {
    case 'raw-material':
    case 'component':
    case 'consumable':
    case 'packaging':
    case 'spare-part':
      return WELL_KNOWN_CODES.inventoryRaw;
    case 'subassembly':
      return WELL_KNOWN_CODES.inventoryWip;
    default:
      return WELL_KNOWN_CODES.inventory;
  }
}

/**
 * Resolve one account role to a concrete account id, or undefined if nothing
 * matches (validation surfaces the missing mapping).
 */
export function resolveAccount(role: InventoryAccountRole, ctx: AccountResolutionContext): string | undefined {
  const { accounts, item, category, settings } = ctx;

  const itemMap: Partial<Record<InventoryAccountRole, string | undefined>> = {
    inventory: item?.inventoryAccountId,
    cogs: item?.costOfGoodsSoldAccountId,
    revenue: item?.salesAccountId,
    salesReturns: item?.salesReturnAccountId,
    inventoryWriteOff: item?.inventoryWriteOffAccountId,
    inventoryLoss: item?.inventoryWriteOffAccountId,
    inventoryGain: item?.inventoryGainAccountId,
  };
  const categoryMap: Partial<Record<InventoryAccountRole, string | undefined>> = {
    inventory: category?.defaultInventoryAccountId,
    cogs: category?.defaultCogsAccountId,
    revenue: category?.defaultSalesAccountId,
  };
  const settingsMap: Partial<Record<InventoryAccountRole, string | undefined>> = {
    inventoryGain: settings?.inventoryGainAccountId,
    inventoryLoss: settings?.inventoryLossAccountId,
    inventoryWriteOff: settings?.inventoryLossAccountId,
    grni: settings?.goodsReceivedNotInvoicedAccountId,
    issueExpense: settings?.inventoryLossAccountId,
  };

  const explicit = itemMap[role] ?? categoryMap[role] ?? settingsMap[role];
  if (explicit && accounts.some((a) => a.id === explicit)) return explicit;

  // Fall back to the well-known code.
  if (role === 'inventory') return byCode(accounts, inventoryCodeForItem(item));
  if (role === 'issueExpense') return byCode(accounts, WELL_KNOWN_CODES.inventoryWriteOff);
  if (role === 'grni') return byCode(accounts, WELL_KNOWN_CODES.payables);
  return byCode(accounts, WELL_KNOWN_CODES[role]);
}

/** Convenience bundle of the accounts a full inventory posting may reference. */
export function resolveInventoryAccounts(ctx: AccountResolutionContext) {
  return {
    inventory: resolveAccount('inventory', ctx),
    cogs: resolveAccount('cogs', ctx),
    revenue: resolveAccount('revenue', ctx),
    salesReturns: resolveAccount('salesReturns', ctx),
    inventoryGain: resolveAccount('inventoryGain', ctx),
    inventoryLoss: resolveAccount('inventoryLoss', ctx),
    inventoryWriteOff: resolveAccount('inventoryWriteOff', ctx),
    receivables: resolveAccount('receivables', ctx),
    payables: resolveAccount('payables', ctx),
    outputTax: resolveAccount('outputTax', ctx),
    inputTaxRecoverable: resolveAccount('inputTaxRecoverable', ctx),
    openingEquity: resolveAccount('openingEquity', ctx),
    issueExpense: resolveAccount('issueExpense', ctx),
    grni: resolveAccount('grni', ctx),
  };
}
