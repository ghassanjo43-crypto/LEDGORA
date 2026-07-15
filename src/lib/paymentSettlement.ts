import type { Account, BusinessEntity } from '@/types';
import type { Bill } from '@/types/bill';
import type { Payment, PaymentPostingConfig } from '@/types/payment';
import { resolveAccountsPayableAccount, isOpenBill, supplierPayableBalance } from '@/lib/billSettlement';
import { roundMoney } from '@/lib/journalValidation';

export { isOpenBill, supplierPayableBalance };

function byCode(accounts: Account[], code: string): Account | undefined {
  return accounts.find((a) => a.code === code);
}

/** Cash & cash-equivalent posting accounts, split into bank vs cash-on-hand. */
export function splitCashAccounts(accounts: Account[]): { bank: Account[]; cash: Account[] } {
  const all = accounts.filter((a) => a.type === 'ASSET' && a.isPostingAccount && /cash and cash equivalents/i.test(a.ifrsSubcategory));
  const cash = all.filter((a) => /cash on hand/i.test(a.name));
  const bank = all.filter((a) => !/cash on hand/i.test(a.name));
  return { bank, cash };
}

/**
 * Chart-of-accounts routing for a payment posting. Centralises the credit cash
 * accounts and the type-specific debit / fee / withholding / discount / FX
 * accounts so posting stays consistent. Mirrors the bill posting config on the
 * payables side.
 */
export function buildPaymentPostingConfig(accounts: Account[], supplier?: BusinessEntity): PaymentPostingConfig {
  const { bank, cash } = splitCashAccounts(accounts);
  return {
    accountsPayableAccountId: resolveAccountsPayableAccount(supplier, accounts),
    supplierAdvancesAccountId: byCode(accounts, '1240')?.id, // Prepayments / supplier advances
    withholdingTaxPayableAccountId: byCode(accounts, '2260')?.id, // Current tax payable
    purchaseDiscountAccountId: byCode(accounts, '4300')?.id, // Other operating income (discount received)
    bankFeeAccountId: byCode(accounts, '6900')?.id, // General administrative expenses
    realizedFxAccountId: byCode(accounts, '7300')?.id, // FX gains and losses
    tradeReceivablesAccountId: byCode(accounts, '1221')?.id, // Trade receivables control
    bankAccountIds: bank.map((a) => a.id),
    cashAccountIds: cash.map((a) => a.id),
    defaultBankAccountId: byCode(accounts, '1252')?.id ?? bank[0]?.id,
    defaultCashAccountId: byCode(accounts, '1251')?.id ?? cash[0]?.id,
  };
}

/** Total payable owed to a supplier LESS any unapplied advances already paid. */
export function supplierNetPayable(bills: Bill[], payments: Payment[], supplierId: string, entityId: string): number {
  const gross = supplierPayableBalance(bills, supplierId, entityId);
  const advances = payments
    .filter((p) => p.supplierId === supplierId && p.entityId === entityId)
    .filter((p) => p.status !== 'draft' && p.status !== 'submitted' && p.status !== 'reversed' && p.status !== 'void')
    .reduce((s, p) => s + (Number(p.unappliedAmount) || 0), 0);
  return roundMoney(gross - advances);
}
