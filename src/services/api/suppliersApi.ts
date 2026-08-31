/**
 * The server's supplier directory, over HTTP.
 *
 * ══ Why the path says `vendors` and the type says supplier ═══════════════════
 *
 * Both words are already in this product and name the same entity: the
 * permission subject is `vendors`, every screen and type says supplier. The
 * server route follows the permission, this file follows the screens, and
 * neither is renamed — renaming either would break a granted permission or a
 * page somebody already uses.
 */
import { api } from './client';
import type { ServerBusinessParty, ServerPartyAddress } from './customersApi';

export type { ServerPartyAddress };

/**
 * The supplier-role fields.
 *
 * `withholdingTaxApplicable` and `preferredPaymentMethod` are master data. No
 * bill, payment or withholding workflow exists on the server, so these are
 * recorded rather than acted on — kept because dropping what the user typed on
 * the way to the server would lose data, not because the workflows are here.
 */
export interface ServerSupplierProfile {
  supplierCategory: string;
  defaultPayableAccountId: string | null;
  defaultExpenseAccountId: string | null;
  supplierPaymentTerms: string;
  withholdingTaxApplicable: boolean;
  preferredPaymentMethod: string;
}

/** The same party shape the customer route returns, read for the supplier role. */
export type ServerSupplierParty = ServerBusinessParty & {
  supplier: ServerSupplierProfile | null;
};

export interface SupplierWriteInput {
  partyCode?: string;
  legalName?: string;
  tradingName?: string;
  contactPerson?: string;
  jobTitle?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  website?: string;
  taxRegistrationNumber?: string;
  commercialRegistrationNumber?: string;
  paymentTerms?: string;
  defaultCurrency?: string;
  bankName?: string;
  bankAccountName?: string;
  iban?: string;
  swiftCode?: string;
  notes?: string;
  addresses?: Array<{
    purpose?: 'billing' | 'shipping' | 'registered';
    isPrimary?: boolean;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    postalCode?: string;
    country?: string;
  }>;
  supplier?: Partial<ServerSupplierProfile>;
}

export interface SupplierPage {
  parties: ServerSupplierParty[];
  nextCursor: string | null;
}

export interface SupplierAuditEvent {
  action: string;
  actorName: string;
  at: string;
  previousVersion: number | null;
  resultingVersion: number | null;
  detail: Record<string, unknown>;
}

export const suppliersApi = {
  /**
   * One page of the directory.
   *
   * Bounded and cursor-paged: a picker asks for a page and a search term, and
   * an unbounded list is one a large tenant can make expensive from a keystroke.
   */
  list: async (query: {
    search?: string;
    includeArchived?: boolean;
    limit?: number;
    after?: string | null;
  } = {}): Promise<SupplierPage> => {
    const parts: string[] = [];
    if (query.search) parts.push(`search=${encodeURIComponent(query.search)}`);
    if (query.includeArchived) parts.push('includeArchived=true');
    if (query.limit) parts.push(`limit=${query.limit}`);
    if (query.after) parts.push(`after=${encodeURIComponent(query.after)}`);
    const suffix = parts.length > 0 ? `?${parts.join('&')}` : '';
    return api.get<SupplierPage>(`/api/vendors${suffix}`);
  },

  /**
   * How many suppliers these books hold.
   *
   * Its own call so a screen can tell "none yet" apart from "the list failed",
   * which is the difference between an explanation and apparent data loss.
   */
  count: async (): Promise<number> =>
    (await api.get<{ count: number }>('/api/vendors/count')).count,

  get: async (id: string): Promise<ServerSupplierParty> =>
    (await api.get<{ supplier: ServerSupplierParty }>(`/api/vendors/${id}`)).supplier,

  history: async (id: string): Promise<SupplierAuditEvent[]> =>
    (await api.get<{ events: SupplierAuditEvent[] }>(`/api/vendors/${id}/history`)).events,

  create: async (input: SupplierWriteInput): Promise<ServerSupplierParty> =>
    (await api.post<{ supplier: ServerSupplierParty }>('/api/vendors', input)).supplier,

  /** `expectedVersion` is required: a stale edit is refused, never merged. */
  update: async (
    id: string,
    input: SupplierWriteInput & { expectedVersion: number },
  ): Promise<ServerSupplierParty> =>
    (await api.patch<{ supplier: ServerSupplierParty }>(`/api/vendors/${id}`, input)).supplier,

  /** Archive or restore. There is deliberately no delete. */
  setArchived: async (
    id: string,
    input: { archived: boolean; expectedVersion: number; reason?: string },
  ): Promise<ServerSupplierParty> =>
    (await api.post<{ supplier: ServerSupplierParty }>(`/api/vendors/${id}/archive`, input)).supplier,

  /**
   * Give an existing party the supplier role.
   *
   * One legal party that both sells to us and buys from us is ONE record, so
   * this is the path that does not require inventing a second code.
   */
  grantSupplierRole: async (
    id: string,
    input: { expectedVersion: number; supplier?: Partial<ServerSupplierProfile> },
  ): Promise<ServerSupplierParty> =>
    (await api.post<{ supplier: ServerSupplierParty }>(`/api/vendors/${id}/supplier-role`, input)).supplier,
};
