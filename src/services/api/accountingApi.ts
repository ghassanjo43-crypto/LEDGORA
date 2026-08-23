/**
 * The server-side chart of accounts.
 *
 * ── Why this client did not exist before ─────────────────────────────────────
 * Ledgora's books live in the browser (see `lib/workspaceStorage`), so every
 * accounting page reads `useStore` and nothing ever called the accounting API.
 * Opening balances are the exception: they are posted through the server's
 * authoritative journal, and `openingBalanceService.listEligibleAccounts` reads
 * the SERVER's `accounts` table.
 *
 * With no client, that table stayed empty for every subscriber — so the opening
 * balance page offered a chart of nothing, however complete the browser's own
 * chart looked. This is the missing half of that path.
 */
import { api } from './client';

export type ServerAccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type ServerNormalBalance = 'debit' | 'credit';

export interface ServerAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: ServerAccountType;
  parentAccountId: string | null;
  isPostable: boolean;
}

export interface CreateServerAccountInput {
  accountCode: string;
  accountName: string;
  accountType: ServerAccountType;
  accountSubtype?: string | null;
  normalBalance?: ServerNormalBalance;
  parentAccountId?: string | null;
  isPostable?: boolean;
  active?: boolean;
  blocked?: boolean;
  archived?: boolean;
}

export const accountingApi = {
  /** Every account the server holds for the caller's workspace, active ones only. */
  list: async (): Promise<ServerAccount[]> =>
    (await api.get<{ accounts: ServerAccount[] }>('/api/accounting/accounts')).accounts,

  create: async (input: CreateServerAccountInput): Promise<ServerAccount> =>
    (await api.post<{ account: ServerAccount }>('/api/accounting/accounts', input)).account,
};
