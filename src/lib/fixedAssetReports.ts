/**
 * Fixed Assets — report builders (pure).
 *
 * Every report derives from the asset register, its transactions/runs and the
 * posted General Journal — the same single set of records the postings wrote,
 * so the reports can never disagree with the ledger by construction. The
 * reconciliation report closes the loop: register balances vs GL balances per
 * mapped account.
 */
import type { Account } from '@/types';
import type { JournalEntry } from '@/types/journal';
import type {
  AssetCategory,
  DepreciationRun,
  FixedAsset,
  FixedAssetTransaction,
} from '@/types/fixedAssets';
import { computeDepreciation, netBookValue, remainingDepreciable, round2 } from './fixedAssetCalculations';

export interface RegisterTotals {
  count: number;
  cost: number;
  accumulatedDepreciation: number;
  impairment: number;
  netBookValue: number;
}

const EMPTY_TOTALS: RegisterTotals = { count: 0, cost: 0, accumulatedDepreciation: 0, impairment: 0, netBookValue: 0 };

function accumulate(t: RegisterTotals, a: FixedAsset): RegisterTotals {
  return {
    count: t.count + 1,
    cost: round2(t.cost + a.originalCost),
    accumulatedDepreciation: round2(t.accumulatedDepreciation + a.accumulatedDepreciation),
    impairment: round2(t.impairment + a.impairmentBalance),
    netBookValue: round2(t.netBookValue + netBookValue(a)),
  };
}

/** Assets that still carry balances on the books. */
export function onBookAssets(assets: FixedAsset[]): FixedAsset[] {
  return assets.filter((a) => a.status !== 'disposed' && a.status !== 'cancelled' && a.status !== 'draft' && a.status !== 'pending_approval');
}

export function registerTotals(assets: FixedAsset[]): RegisterTotals {
  return onBookAssets(assets).reduce(accumulate, EMPTY_TOTALS);
}

/** Group on-book assets by an arbitrary key (category, location, custodian…). */
export function groupAssetsBy(
  assets: FixedAsset[],
  keyOf: (a: FixedAsset) => string,
  labelOf: (key: string) => string = (k) => k,
): Array<{ key: string; label: string; totals: RegisterTotals }> {
  const groups = new Map<string, RegisterTotals>();
  for (const a of onBookAssets(assets)) {
    const key = keyOf(a) || '—';
    groups.set(key, accumulate(groups.get(key) ?? EMPTY_TOTALS, a));
  }
  return [...groups.entries()]
    .map(([key, totals]) => ({ key, label: labelOf(key), totals }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Transactions of the given types within [from, to]. */
export function transactionsInPeriod(
  transactions: FixedAssetTransaction[],
  types: FixedAssetTransaction['type'][],
  from: string,
  to: string,
): FixedAssetTransaction[] {
  return transactions.filter((t) => t.status === 'posted' && types.includes(t.type) && t.date >= from && t.date <= to);
}

/* ── Depreciation schedule (projection) ───────────────────────────────────── */

export interface ScheduleRow {
  period: string; // YYYY-MM
  charge: number;
  accumulatedAfter: number;
  nbvAfter: number;
}

/** Project the remaining monthly depreciation for one asset (cap 600 rows). */
export function buildDepreciationSchedule(asset: FixedAsset, fromDate: string): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let working: FixedAsset = { ...asset };
  let y = Number(fromDate.slice(0, 4));
  let m = Number(fromDate.slice(5, 7));
  for (let i = 0; i < 600; i++) {
    if (remainingDepreciable(working) <= 0) break;
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const last = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    // Units-of-production has no time-based projection.
    const charge = working.method === 'units_of_production' ? 0 : computeDepreciation({ asset: working, periodFrom: first, periodTo: last });
    if (charge <= 0) break;
    working = { ...working, accumulatedDepreciation: round2(working.accumulatedDepreciation + charge), depreciatedThrough: last };
    rows.push({ period: first.slice(0, 7), charge, accumulatedAfter: working.accumulatedDepreciation, nbvAfter: netBookValue(working) });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return rows;
}

/* ── Asset movement report (roll-forward) ─────────────────────────────────── */

export interface MovementRow {
  label: string;
  additions: number;
  capitalizations: number;
  disposalsCost: number;
  depreciationCharge: number;
  impairmentCharge: number;
  impairmentReversals: number;
  revaluationDelta: number;
}

/** Cost / charge movement per category over a period, from posted transactions. */
export function buildMovementReport(
  categories: AssetCategory[],
  assets: FixedAsset[],
  transactions: FixedAssetTransaction[],
  runs: DepreciationRun[],
  from: string,
  to: string,
): MovementRow[] {
  const catOf = (assetId: string): string => assets.find((a) => a.id === assetId)?.categoryId ?? '';
  const rows = new Map<string, MovementRow>();
  const rowFor = (categoryId: string): MovementRow => {
    const key = categoryId || '—';
    const existing = rows.get(key);
    if (existing) return existing;
    const fresh: MovementRow = {
      label: categories.find((c) => c.id === categoryId)?.name ?? 'Uncategorised',
      additions: 0, capitalizations: 0, disposalsCost: 0,
      depreciationCharge: 0, impairmentCharge: 0, impairmentReversals: 0, revaluationDelta: 0,
    };
    rows.set(key, fresh);
    return fresh;
  };

  for (const t of transactions) {
    if (t.status !== 'posted' || t.date < from || t.date > to) continue;
    const row = rowFor(catOf(t.assetId));
    switch (t.type) {
      case 'acquisition': case 'auc_acquisition':
        row.additions = round2(row.additions + Number(t.details.baseCost ?? t.amount)); break;
      case 'capitalization':
        row.capitalizations = round2(row.capitalizations + t.amount); break;
      case 'disposal': case 'partial_disposal': case 'intercompany_transfer':
        row.disposalsCost = round2(row.disposalsCost + Number(t.details.nbvDisposed ?? t.amount)); break;
      case 'depreciation':
        row.depreciationCharge = round2(row.depreciationCharge + t.amount); break;
      case 'impairment':
        row.impairmentCharge = round2(row.impairmentCharge + t.amount); break;
      case 'impairment_reversal':
        row.impairmentReversals = round2(row.impairmentReversals + t.amount); break;
      case 'revaluation':
        row.revaluationDelta = round2(row.revaluationDelta + Number(t.details.revaluationDelta ?? 0)); break;
      default: break;
    }
  }
  for (const r of runs) {
    if (r.status !== 'posted' || r.periodTo < from || r.periodTo > to) continue;
    for (const l of r.lines) {
      const row = rowFor(l.categoryId);
      row.depreciationCharge = round2(row.depreciationCharge + l.amount);
    }
  }
  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/* ── Reconciliation to the General Ledger ─────────────────────────────────── */

export interface ReconciliationRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  role: 'cost' | 'auc' | 'accumulated-depreciation' | 'accumulated-impairment';
  registerBalance: number;
  glBalance: number;
  difference: number;
}

/** Net GL balance (debits − credits) of one account across posted entries. */
export function glBalance(entries: JournalEntry[], accountId: string): number {
  let net = 0;
  for (const e of entries) {
    if (e.status !== 'posted') continue;
    for (const l of e.lines) {
      if (l.accountId === accountId) net += l.debit - l.credit;
    }
  }
  return round2(net);
}

/**
 * Compare the asset register's cost / accumulated depreciation / impairment /
 * AUC balances against the corresponding General Ledger accounts. Differences
 * flag postings made outside the module (or mappings shared with other flows).
 */
export function buildReconciliation(
  categories: AssetCategory[],
  assets: FixedAsset[],
  accounts: Account[],
  entries: JournalEntry[],
): ReconciliationRow[] {
  interface Bucket { role: ReconciliationRow['role']; register: number }
  const buckets = new Map<string, Bucket>();
  const add = (accountId: string, role: ReconciliationRow['role'], amount: number): void => {
    if (!accountId) return;
    const b = buckets.get(accountId) ?? { role, register: 0 };
    b.register = round2(b.register + amount);
    buckets.set(accountId, b);
  };

  const live = onBookAssets(assets);
  for (const c of categories) {
    const inCat = live.filter((a) => a.categoryId === c.id);
    const draftAuc = assets.filter((a) => a.categoryId === c.id && a.aucBalance > 0);
    add(c.accounts.costAccountId, 'cost', inCat.reduce((s, a) => s + a.originalCost, 0));
    add(c.accounts.aucAccountId, 'auc', draftAuc.reduce((s, a) => s + a.aucBalance, 0));
    // Contra accounts carry credit balances → negative from a debit-net view.
    add(c.accounts.accumulatedDepreciationAccountId, 'accumulated-depreciation', -inCat.reduce((s, a) => s + a.accumulatedDepreciation, 0));
    add(c.accounts.accumulatedImpairmentAccountId, 'accumulated-impairment', -inCat.reduce((s, a) => s + a.impairmentBalance, 0));
  }

  const byId = new Map(accounts.map((a) => [a.id, a]));
  return [...buckets.entries()]
    .map(([accountId, b]) => {
      const acc = byId.get(accountId);
      const gl = glBalance(entries, accountId);
      return {
        accountId,
        accountCode: acc?.code ?? '?',
        accountName: acc?.name ?? 'Unknown account',
        role: b.role,
        registerBalance: b.register,
        glBalance: gl,
        difference: round2(gl - b.register),
      };
    })
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}
