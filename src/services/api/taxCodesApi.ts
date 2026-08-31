/**
 * The server's tax codes, over HTTP.
 *
 * ══ Why every figure here is a STRING ════════════════════════════════════════
 *
 * A rate parsed as a JSON number is a double, and this is the one figure a tax
 * authority will hold a copy of. It stays text from this file to PostgreSQL's
 * numeric, so nothing rounds on the way.
 *
 * ══ What this does not offer ═════════════════════════════════════════════════
 *
 * No way to send a computed tax amount, and no way to send a rate onto an
 * invoice line. Those are refused by the server, and leaving them out of the
 * client type is what stops a screen being written against them by accident.
 */
import { api } from './client';

export type ServerTaxCategory = 'standard' | 'reduced' | 'zero-rated' | 'exempt' | 'out-of-scope';
export type ServerTaxMethod = 'exclusive' | 'inclusive';
export type ServerTaxStatus = 'active' | 'inactive' | 'archived';

export interface ServerTaxRateVersion {
  id: string;
  taxCodeId: string;
  /** A percentage, exact, as text. */
  rate: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  outputTaxAccountId: string | null;
  createdAt: string | null;
}

export interface ServerTaxCode {
  id: string;
  code: string;
  name: string;
  description: string;
  category: ServerTaxCategory;
  calculationMethod: ServerTaxMethod;
  status: ServerTaxStatus;
  outputTaxAccountId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  version: number;
  rateVersions: ServerTaxRateVersion[];
}

export interface ServerTaxCodeAuditEvent {
  id: string;
  at: string;
  action: string;
  detail: unknown;
  previousVersion: number | null;
  resultingVersion: number | null;
  actorName: string;
}

export interface TaxCodeCreateInput {
  code: string;
  name: string;
  description?: string;
  category: ServerTaxCategory;
  calculationMethod: ServerTaxMethod;
  rate?: string;
  outputTaxAccountId?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export interface TaxCodeUpdateInput {
  name: string;
  description?: string;
  outputTaxAccountId?: string | null;
  effectiveTo?: string | null;
}

export interface RateVersionInput {
  rate?: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  outputTaxAccountId?: string | null;
}

export const taxCodesApi = {
  list: async (options: { includeArchived?: boolean } = {}): Promise<ServerTaxCode[]> => {
    const suffix = options.includeArchived ? '?includeArchived=true' : '';
    return (await api.get<{ taxCodes: ServerTaxCode[] }>(`/api/tax-codes${suffix}`)).taxCodes;
  },

  get: async (id: string): Promise<ServerTaxCode> =>
    (await api.get<{ taxCode: ServerTaxCode }>(`/api/tax-codes/${id}`)).taxCode,

  history: async (id: string): Promise<ServerTaxCodeAuditEvent[]> =>
    (await api.get<{ events: ServerTaxCodeAuditEvent[] }>(`/api/tax-codes/${id}/history`)).events,

  create: async (input: TaxCodeCreateInput): Promise<ServerTaxCode> =>
    (await api.post<{ taxCode: ServerTaxCode }>('/api/tax-codes', input)).taxCode,

  /*
   * `expectedVersion` is required rather than defaulted. A caller that has not
   * read the code cannot be allowed to overwrite somebody else's change, so the
   * signature makes the token impossible to forget.
   */
  update: async (id: string, expectedVersion: number, input: TaxCodeUpdateInput): Promise<ServerTaxCode> =>
    (await api.patch<{ taxCode: ServerTaxCode }>(`/api/tax-codes/${id}`, { ...input, expectedVersion })).taxCode,

  /**
   * Add an effective-dated rate.
   *
   * Its own call rather than a field on `update`, because adding a rate leaves
   * every previous rate in place — and the invoices issued under them keep
   * charging what they charged.
   */
  addRate: async (id: string, expectedVersion: number, input: RateVersionInput): Promise<ServerTaxCode> =>
    (await api.post<{ taxCode: ServerTaxCode }>(`/api/tax-codes/${id}/rates`, { ...input, expectedVersion })).taxCode,

  setStatus: async (id: string, expectedVersion: number, status: ServerTaxStatus): Promise<ServerTaxCode> =>
    (await api.post<{ taxCode: ServerTaxCode }>(`/api/tax-codes/${id}/status`, { status, expectedVersion })).taxCode,
};
