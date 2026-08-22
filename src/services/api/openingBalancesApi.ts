import { api } from './client';

export type OpeningBalanceStatus = 'draft' | 'submitted' | 'approved' | 'posted' | 'reversed';
export interface OpeningBalanceAccount { id: string; code: string; name: string; type: 'asset' | 'liability' | 'equity'; subtype: string | null; normalBalance: string; currency: string | null }
export interface OpeningBalanceLine { accountId: string; debit: string; credit: string; memo?: string }
export interface OpeningBalanceRecord {
  id: string; status: OpeningBalanceStatus; version: number; bookkeepingStartDate: string; openingBalanceDate: string;
  reference: string; description: string; preparedBy: string | null; submittedBy: string | null; approvedBy: string | null;
  postedBy: string | null; reversedBy: string | null; submittedAt: string | null; approvedAt: string | null; postedAt: string | null;
  journal: { id: string; journalNumber: string; version: number; functionalCurrency: string; lines: Array<{ accountId: string; debit: string; credit: string; memo: string }> };
}
export interface OpeningBalancePayload { bookkeepingStartDate: string; openingBalanceDate: string; reference: string; description: string; lines: OpeningBalanceLine[]; expectedVersion?: number }

const root = '/api/accounting/opening-balances';
export const openingBalancesApi = {
  current: async () => (await api.get<{ openingBalance: OpeningBalanceRecord | null }>(`${root}/current`)).openingBalance,
  accounts: () => api.get<{ accounts: OpeningBalanceAccount[]; restrictions: string[] }>(`${root}/accounts`),
  create: async (body: OpeningBalancePayload) => (await api.post<{ openingBalance: OpeningBalanceRecord }>(root, body)).openingBalance,
  update: async (id: string, body: OpeningBalancePayload) => (await api.patch<{ openingBalance: OpeningBalanceRecord }>(`${root}/${id}`, body)).openingBalance,
  submit: async (id: string, expectedVersion: number) => (await api.post<{ openingBalance: OpeningBalanceRecord }>(`${root}/${id}/submit`, { expectedVersion })).openingBalance,
  approve: async (id: string, expectedVersion: number) => (await api.post<{ openingBalance: OpeningBalanceRecord }>(`${root}/${id}/approve`, { expectedVersion })).openingBalance,
  post: async (id: string, expectedVersion: number) => (await api.post<{ openingBalance: OpeningBalanceRecord }>(`${root}/${id}/post`, { expectedVersion })).openingBalance,
  reverse: async (id: string, expectedVersion: number, reason: string) => (await api.post<{ openingBalance: OpeningBalanceRecord }>(`${root}/${id}/reverse`, { expectedVersion, reason })).openingBalance,
  replacement: async (id: string, body: OpeningBalancePayload) => (await api.post<{ openingBalance: OpeningBalanceRecord }>(`${root}/${id}/replacement`, body)).openingBalance,
};
