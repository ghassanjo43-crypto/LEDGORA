/**
 * The server's chart of accounts and general journal.
 *
 * ── What changed ─────────────────────────────────────────────────────────────
 * This client used to offer `list` and `create` only, because Ledgora's books
 * lived in the browser and nothing but the opening-balance screen ever needed
 * the server's chart. The books are now server-authoritative, so every
 * operation the chart of accounts and the general journal perform has to exist
 * here — a mutation with no client is a mutation that quietly stays local.
 *
 * ── Money crosses as decimal strings ─────────────────────────────────────────
 * `debit` and `credit` are strings in both directions and are never parsed on
 * the way out. The server holds `numeric` and every figure that matters is
 * summed there; a client that turned `0.1` into a float on the way in would
 * hand back a different number than the one the user typed.
 */
import { api, apiRequest } from './client';

export type ServerAccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type ServerNormalBalance = 'debit' | 'credit';

/**
 * The controlled cash vocabulary, mirrored from the server.
 *
 * A copy of a server constant, kept so the form can offer the choices without a
 * round trip. It is NOT the authority: the server validates every value and
 * refuses one it does not know, so a copy that drifts produces a refusal rather
 * than a wrong classification.
 */
export const CASH_CLASSIFICATIONS = [
  'none',
  'cash_and_cash_equivalents',
  'restricted_cash',
  'bank_overdraft',
] as const;
export type CashClassification = (typeof CASH_CLASSIFICATIONS)[number];

export interface ServerAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: ServerAccountType;
  accountSubtype: string | null;
  cashClassification: CashClassification;
  normalBalance: ServerNormalBalance;
  parentAccountId: string | null;
  restrictedCurrency: string | null;
  sortOrder: number;
  presentationType: string;
  ifrsStatement: string;
  ifrsCategory: string;
  ifrsSubcategory: string;
  cashFlowCategory: string;
  profitOrLossCategory: string;
  description: string;
  industryTag: string;
  isPostable: boolean;
  active: boolean;
  blocked: boolean;
  archived: boolean;
  systemAccount: boolean;
}

export interface ServerAccountInput {
  accountCode: string;
  accountName: string;
  accountType: ServerAccountType;
  accountSubtype?: string | null;
  cashClassification?: string;
  normalBalance?: ServerNormalBalance;
  parentAccountId?: string | null;
  sortOrder?: number;
  presentationType?: string;
  ifrsStatement?: string;
  ifrsCategory?: string;
  ifrsSubcategory?: string;
  cashFlowCategory?: string;
  profitOrLossCategory?: string;
  description?: string;
  industryTag?: string;
  isPostable?: boolean;
  active?: boolean;
  blocked?: boolean;
  archived?: boolean;
}

export type ServerJournalStatus = 'draft' | 'posted' | 'reversed' | 'voided';

export interface ServerJournalLine {
  id: string;
  lineNumber: number;
  accountId: string;
  memo: string;
  entityId: string | null;
  projectId: string | null;
  costCenterId: string | null;
  debit: string;
  credit: string;
  debitFunctional: string;
  creditFunctional: string;
}

export interface ServerJournal {
  id: string;
  journalNumber: string;
  journalType: string;
  transactionDate: string;
  postingDate: string;
  status: ServerJournalStatus;
  reference: string;
  description: string;
  notes: string;
  transactionCurrency: string;
  functionalCurrency: string;
  exchangeRate: string;
  sourceType: string | null;
  sourceId: string | null;
  originalEntryId: string | null;
  reversalEntryId: string | null;
  replacementEntryId: string | null;
  version: number;
  postedAt: string | null;
  lines: ServerJournalLine[];
}

export interface ServerJournalLineInput {
  accountId: string;
  debit?: string | null;
  credit?: string | null;
  memo?: string;
  entityId?: string | null;
  projectId?: string | null;
  costCenterId?: string | null;
}

export interface ServerJournalInput {
  transactionDate: string;
  postingDate?: string;
  reference?: string;
  description?: string;
  notes?: string;
  journalType?: string;
  lines: ServerJournalLineInput[];
}

/** What `POST /journals/:id/reverse-and-replace` answers with. */
export interface ReverseAndReplaceResult {
  original: ServerJournal;
  reversal: ServerJournal;
  replacement: ServerJournal;
}

export interface ReverseResult {
  original: ServerJournal;
  reversal: ServerJournal;
}

export const accountingApi = {
  /* ── Chart of accounts ─────────────────────────────────────────────────── */

  /**
   * The ACTIVE accounts, which is what a posting path wants.
   *
   * Unchanged from the original client: the opening-balance screen and the
   * invoice posting map both ask "which accounts may I post to", and an
   * inactive account is not one of them.
   */
  list: async (): Promise<ServerAccount[]> =>
    (await api.get<{ accounts: ServerAccount[] }>('/api/accounting/accounts')).accounts,

  /**
   * The whole chart, INCLUDING inactive accounts.
   *
   * What HYDRATION wants, and deliberately a different call. A deactivated
   * account is still part of the chart — it is how a historical posting
   * resolves its name, and the screen shows it under an "inactive" filter.
   * Loading only the active ones would make deactivating look like deleting,
   * which is the distinction the server refuses to blur.
   */
  listAll: async (): Promise<ServerAccount[]> =>
    (await api.get<{ accounts: ServerAccount[] }>('/api/accounting/accounts?includeInactive=true')).accounts,

  create: async (input: ServerAccountInput): Promise<ServerAccount> =>
    (await api.post<{ account: ServerAccount }>('/api/accounting/accounts', input)).account,

  updateAccount: async (id: string, input: Partial<ServerAccountInput>): Promise<ServerAccount> =>
    (await api.patch<{ account: ServerAccount }>(`/api/accounting/accounts/${id}`, input)).account,

  deleteAccount: async (id: string): Promise<void> => {
    await api.del(`/api/accounting/accounts/${id}`);
  },

  /** One parent's children, in their intended order, in a single request. */
  reorderAccounts: async (
    parentAccountId: string | null,
    orderedIds: readonly string[],
  ): Promise<ServerAccount[]> =>
    (await api.post<{ accounts: ServerAccount[] }>('/api/accounting/accounts/reorder', {
      parentAccountId,
      orderedIds,
    })).accounts,

  /* ── General journal ───────────────────────────────────────────────────── */

  listJournals: async (limit = 500): Promise<ServerJournal[]> =>
    (await api.get<{ journals: ServerJournal[] }>(`/api/accounting/journals?limit=${limit}`)).journals,

  createJournal: async (input: ServerJournalInput): Promise<ServerJournal> =>
    (await api.post<{ journal: ServerJournal }>('/api/accounting/journals', input)).journal,

  updateJournal: async (
    id: string,
    input: ServerJournalInput,
    expectedVersion: number,
    reason?: string,
  ): Promise<ServerJournal> =>
    (await api.patch<{ journal: ServerJournal }>(`/api/accounting/journals/${id}`, {
      ...input, expectedVersion, reason,
    })).journal,

  /* `api.del` sends no body, and the concurrency token has to travel. */
  deleteJournal: async (id: string, expectedVersion: number): Promise<void> => {
    await apiRequest(`/api/accounting/journals/${id}`, {
      method: 'DELETE', body: { expectedVersion },
    });
  },

  postJournal: async (id: string, expectedVersion: number): Promise<ServerJournal> =>
    (await api.post<{ journal: ServerJournal }>(`/api/accounting/journals/${id}/post`, {
      expectedVersion,
    })).journal,

  amendJournal: async (
    id: string,
    input: ServerJournalInput,
    expectedVersion: number,
    reason: string,
  ): Promise<ServerJournal> =>
    (await api.post<{ journal: ServerJournal }>(`/api/accounting/journals/${id}/amend`, {
      ...input, expectedVersion, reason,
    })).journal,

  reverseJournal: async (
    id: string,
    expectedVersion: number,
    reason?: string,
  ): Promise<ReverseResult> =>
    api.post<ReverseResult>(`/api/accounting/journals/${id}/reverse`, { expectedVersion, reason }),

  reverseAndReplaceJournal: async (
    id: string,
    input: ServerJournalInput,
    expectedVersion: number,
    reason: string,
  ): Promise<ReverseAndReplaceResult> =>
    api.post<ReverseAndReplaceResult>(`/api/accounting/journals/${id}/reverse-and-replace`, {
      ...input, expectedVersion, reason,
    }),
};
