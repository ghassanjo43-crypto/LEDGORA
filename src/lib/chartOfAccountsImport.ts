/**
 * Import the browser's balance-sheet chart into the server's account table.
 *
 * ── Why an import and not a silent sync ──────────────────────────────────────
 * Ledgora keeps its books in the browser; the server holds accounts only for
 * the surfaces that are server-authoritative, which today means opening
 * balances. Two charts that drift are worse than one chart plus an explicit
 * copy, so this runs when a person asks for it and reports exactly what it did.
 *
 * ── Why only assets, liabilities and equity ──────────────────────────────────
 * The two sides use different account vocabularies: the browser splits the
 * income statement five ways (`COST_OF_SALES`, `OPERATING_EXPENSE`,
 * `OTHER_INCOME_EXPENSE`, `FINANCE`, `TAX`) where the server has `income` and
 * `expense`. Balance-sheet types map one-to-one and are the only ones opening
 * balances can use, so the import copies exactly those and invents no mapping
 * it would then have to defend.
 */
import type { Account } from '@/types';
import { accountingApi, type CreateServerAccountInput, type ServerAccountType } from '@/services/api/accountingApi';

/** Browser types that translate to the server without inventing a mapping. */
const BALANCE_SHEET: Record<string, ServerAccountType> = {
  ASSET: 'asset',
  LIABILITY: 'liability',
  EQUITY: 'equity',
};

export interface ImportOutcome {
  created: number;
  skipped: number;
  /** Accounts the server refused, with its reason — shown, never swallowed. */
  failures: Array<{ code: string; name: string; reason: string }>;
}

export function balanceSheetAccounts(accounts: Account[]): Account[] {
  return accounts.filter((account) => BALANCE_SHEET[account.type] !== undefined);
}

/**
 * Parents before children, so a child's `parentAccountId` always resolves.
 *
 * Ordering by `level` rather than by tree walk keeps this total: an account
 * whose parent sits outside the balance-sheet subtree (a malformed chart) still
 * imports, re-parented to null, instead of being silently dropped.
 */
function parentsFirst(accounts: Account[]): Account[] {
  return [...accounts].sort((a, b) => a.level - b.level || a.code.localeCompare(b.code));
}

export function toServerAccount(
  account: Account,
  parentServerId: string | null,
): CreateServerAccountInput {
  return {
    accountCode: account.code,
    accountName: account.name,
    accountType: BALANCE_SHEET[account.type]!,
    accountSubtype: account.ifrsSubcategory || null,
    normalBalance: account.normalBalance === 'CREDIT' ? 'credit' : 'debit',
    parentAccountId: parentServerId,
    isPostable: account.isPostingAccount,
    active: account.isActive,
    blocked: account.isBlocked ?? false,
    archived: account.isArchived ?? false,
  };
}

/**
 * Copy the balance-sheet chart to the server, skipping codes it already holds.
 *
 * Sequential on purpose: each child needs its parent's server id, and the
 * server assigns codes uniquely per workspace — firing these in parallel would
 * race on both.
 */
export async function importBalanceSheetChart(
  accounts: Account[],
  existingCodes: ReadonlySet<string>,
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { created: 0, skipped: 0, failures: [] };
  const serverIdByLocalId = new Map<string, string>();

  for (const account of parentsFirst(balanceSheetAccounts(accounts))) {
    if (existingCodes.has(account.code)) {
      outcome.skipped += 1;
      continue;
    }
    const parentServerId = account.parentId ? serverIdByLocalId.get(account.parentId) ?? null : null;
    try {
      const created = await accountingApi.create(toServerAccount(account, parentServerId));
      serverIdByLocalId.set(account.id, created.id);
      outcome.created += 1;
    } catch (cause) {
      outcome.failures.push({
        code: account.code,
        name: account.name,
        reason: cause instanceof Error ? cause.message : 'Unknown error',
      });
    }
  }

  return outcome;
}
