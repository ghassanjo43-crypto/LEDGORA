/**
 * The customer directory, as the server returns it.
 *
 * ══ One party, one role's view ═══════════════════════════════════════════════
 *
 * A business party may hold the customer role, the supplier role, or both, over
 * one legal identity. These endpoints serve the CUSTOMER view of that party:
 * shared identity plus the customer profile. The supplier profile is a
 * different route that does not exist yet, and this client cannot reach it.
 *
 * ══ The credit limit is a string ═════════════════════════════════════════════
 *
 * It is a money limit compared against a receivable balance, and the balance is
 * `numeric` everywhere. Typing it `number` here would put it through a binary
 * float at the boundary and make the comparison wrong for values a double
 * cannot hold — so it stays a decimal string, exactly as report figures do.
 */
import { api } from './client';

export interface ServerPartyAddress {
  id: string;
  purpose: string;
  isPrimary: boolean;
  addressLine1: string;
  addressLine2: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface ServerCustomerProfile {
  customerCategory: string;
  /** A decimal string. Never parsed in the browser. */
  creditLimit: string;
  defaultRevenueAccountId: string | null;
  defaultReceivableAccountId: string | null;
  defaultInvoiceTemplateId: string | null;
  invoiceDeliveryMethod: string;
  customerPaymentTerms: string;
}

export interface ServerBusinessParty {
  id: string;
  partyCode: string;
  legalName: string;
  tradingName: string;
  isCustomer: boolean;
  isSupplier: boolean;
  contactPerson: string;
  jobTitle: string;
  email: string;
  phone: string;
  mobile: string;
  website: string;
  taxRegistrationNumber: string;
  commercialRegistrationNumber: string;
  paymentTerms: string;
  defaultCurrency: string;
  bankName: string;
  bankAccountName: string;
  iban: string;
  swiftCode: string;
  notes: string;
  /** active | archived. There is no deleted state. */
  status: string;
  version: number;
  addresses: ServerPartyAddress[];
  customer: ServerCustomerProfile | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerWriteInput {
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
  addresses?: Array<Partial<ServerPartyAddress>>;
  customer?: Partial<ServerCustomerProfile>;
}

export interface CustomerPage {
  parties: ServerBusinessParty[];
  nextCursor: string | null;
}

export const customersApi = {
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
  } = {}): Promise<CustomerPage> => {
    const parts: string[] = [];
    if (query.search) parts.push(`search=${encodeURIComponent(query.search)}`);
    if (query.includeArchived) parts.push('includeArchived=true');
    if (query.limit) parts.push(`limit=${query.limit}`);
    if (query.after) parts.push(`after=${encodeURIComponent(query.after)}`);
    const suffix = parts.length > 0 ? `?${parts.join('&')}` : '';
    return api.get<CustomerPage>(`/api/customers${suffix}`);
  },

  get: async (id: string): Promise<ServerBusinessParty> =>
    (await api.get<{ customer: ServerBusinessParty }>(`/api/customers/${id}`)).customer,

  create: async (input: CustomerWriteInput): Promise<ServerBusinessParty> =>
    (await api.post<{ customer: ServerBusinessParty }>('/api/customers', input)).customer,

  /** `expectedVersion` is required: a stale edit is refused, never merged. */
  update: async (
    id: string,
    input: CustomerWriteInput & { expectedVersion: number },
  ): Promise<ServerBusinessParty> =>
    (await api.patch<{ customer: ServerBusinessParty }>(`/api/customers/${id}`, input)).customer,

  /**
   * Archive or restore. There is no delete, deliberately — a party named on an
   * issued document must stay identifiable for as long as the document does.
   */
  setArchived: async (
    id: string,
    input: { archived: boolean; expectedVersion: number; reason?: string },
  ): Promise<ServerBusinessParty> =>
    (await api.post<{ customer: ServerBusinessParty }>(`/api/customers/${id}/archive`, input)).customer,
};
