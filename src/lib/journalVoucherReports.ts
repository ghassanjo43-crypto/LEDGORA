/**
 * Universal Journal Voucher — report builders (pure).
 *
 * All reports derive from the voucher register and the posted General Journal;
 * the reconciliation report proves every posted voucher maps to exactly one
 * journal entry with matching totals (and finds orphans in either direction).
 */
import type { JournalEntry } from '@/types/journal';
import type { JournalVoucher, VoucherTypeConfig } from '@/types/journalVoucher';
import { computeVoucherTotals, round2 } from './journalVoucherValidation';

export interface VoucherGroupRow {
  key: string;
  label: string;
  count: number;
  totalDebit: number;
  totalBaseDebit: number;
}

/** Group posted/reversed vouchers by an arbitrary key. */
export function groupVouchersBy(
  vouchers: JournalVoucher[],
  keyOf: (v: JournalVoucher) => string,
  labelOf: (key: string) => string = (k) => k || '—',
): VoucherGroupRow[] {
  const rows = new Map<string, VoucherGroupRow>();
  for (const v of vouchers) {
    if (v.status !== 'posted' && v.status !== 'partially_reversed' && v.status !== 'reversed') continue;
    const key = keyOf(v) || '—';
    const totals = computeVoucherTotals(v.lines, v.exchangeRate);
    const row = rows.get(key) ?? { key, label: labelOf(key), count: 0, totalDebit: 0, totalBaseDebit: 0 };
    row.count += 1;
    row.totalDebit = round2(row.totalDebit + totals.debit);
    row.totalBaseDebit = round2(row.totalBaseDebit + totals.baseDebit);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Vouchers grouped by every account they touch. */
export function vouchersByAccount(vouchers: JournalVoucher[]): VoucherGroupRow[] {
  const rows = new Map<string, VoucherGroupRow>();
  for (const v of vouchers) {
    if (v.status !== 'posted' && v.status !== 'partially_reversed' && v.status !== 'reversed') continue;
    for (const l of v.lines) {
      if (!l.accountId || (l.debit === 0 && l.credit === 0)) continue;
      const label = `${l.accountCode} — ${l.accountName}`.trim();
      const row = rows.get(l.accountId) ?? { key: l.accountId, label: label || l.accountId, count: 0, totalDebit: 0, totalBaseDebit: 0 };
      row.count += 1;
      row.totalDebit = round2(row.totalDebit + l.debit + l.credit);
      row.totalBaseDebit = round2(row.totalBaseDebit + round2((l.debit + l.credit) * v.exchangeRate));
      rows.set(l.accountId, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/* ── Voucher ↔ General Ledger reconciliation ──────────────────────────────── */

export interface JvReconciliationRow {
  voucherNumber: string;
  journalEntryNumber: string;
  status: 'matched' | 'totals-differ' | 'journal-missing';
  voucherDebit: number;
  journalDebit: number;
  difference: number;
}

export interface JvReconciliation {
  rows: JvReconciliationRow[];
  /** Journal entries that claim a JV reference no voucher owns. */
  orphanJournalNumbers: string[];
  matched: number;
  exceptions: number;
}

export function reconcileVouchersToJournal(
  vouchers: JournalVoucher[],
  entries: JournalEntry[],
): JvReconciliation {
  const rows: JvReconciliationRow[] = [];
  const claimedEntryIds = new Set<string>();
  for (const v of vouchers) {
    if (v.status !== 'posted' && v.status !== 'partially_reversed' && v.status !== 'reversed') continue;
    const totals = computeVoucherTotals(v.lines, 1);
    const entry = entries.find((e) => e.id === v.journalEntryId);
    if (!entry) {
      rows.push({ voucherNumber: v.number, journalEntryNumber: v.journalEntryNumber, status: 'journal-missing', voucherDebit: totals.debit, journalDebit: 0, difference: totals.debit });
      continue;
    }
    claimedEntryIds.add(entry.id);
    const diff = round2(totals.debit - entry.totalDebit);
    rows.push({
      voucherNumber: v.number,
      journalEntryNumber: entry.entryNumber,
      status: Math.abs(diff) < 0.005 ? 'matched' : 'totals-differ',
      voucherDebit: totals.debit,
      journalDebit: entry.totalDebit,
      difference: diff,
    });
  }
  const orphanJournalNumbers = entries
    .filter((e) => e.transactionType === 'Journal Voucher' && !claimedEntryIds.has(e.id))
    .map((e) => e.entryNumber);
  const exceptions = rows.filter((r) => r.status !== 'matched').length + orphanJournalNumbers.length;
  return { rows, orphanJournalNumbers, matched: rows.length - rows.filter((r) => r.status !== 'matched').length, exceptions };
}

/* ── Filtered lists for the specialised reports ───────────────────────────── */

export function reversedVouchers(vouchers: JournalVoucher[]): JournalVoucher[] {
  return vouchers.filter((v) => v.status === 'reversed' || v.reversalOfVoucherId);
}

export function openingBalanceVouchers(vouchers: JournalVoucher[], types: VoucherTypeConfig[]): JournalVoucher[] {
  const obTypes = new Set(types.filter((t) => t.kind === 'opening_balance').map((t) => t.id));
  return vouchers.filter((v) => obTypes.has(v.typeId));
}

export function intercompanyVouchers(vouchers: JournalVoucher[]): JournalVoucher[] {
  return vouchers.filter((v) => v.intercompanyRef);
}

export function recurringVouchers(vouchers: JournalVoucher[]): JournalVoucher[] {
  return vouchers.filter((v) => v.templateId);
}

export function unapprovedVouchers(vouchers: JournalVoucher[]): JournalVoucher[] {
  return vouchers.filter((v) => v.status === 'draft' || v.status === 'pending_approval' || v.status === 'rejected');
}

export function manualTaxAdjustments(vouchers: JournalVoucher[], types: VoucherTypeConfig[]): JournalVoucher[] {
  const taxTypes = new Set(types.filter((t) => t.kind === 'tax_adjustment').map((t) => t.id));
  return vouchers.filter((v) => taxTypes.has(v.typeId) || v.lines.some((l) => l.taxCode || l.taxAmount));
}
