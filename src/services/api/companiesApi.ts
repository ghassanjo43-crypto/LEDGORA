/**
 * The server company registry, from the browser.
 *
 * ── What a company is here ───────────────────────────────────────────────────
 * A set of books. The browser has always had its own notion of one — an id like
 * `co_lx8f2a_9d4kz1` in `companyStore`, with the books beside it in local
 * storage. This client is how that local notion acquires a server identity.
 *
 * ── Registration is adoption, not creation ───────────────────────────────────
 * `register` sends the browser's EXISTING reference. The server mints a uuid of
 * its own and records the reference alongside it, so nothing in the books has
 * to be re-keyed and no existing record changes. Re-sending the same reference
 * is safe by design: the server answers with the company it already holds
 * rather than minting a second one, which matters because this call is made on
 * start-up and will therefore be repeated on every reload, in every tab.
 *
 * The one thing it will not do quietly is rename. The same reference arriving
 * with a different legal name is a disagreement about what these books are, not
 * a rename, and comes back as a 409 — see the server service for why.
 */
import { api, apiRequest } from './client';

export type BookkeepingLanguage = 'en' | 'ar';

export interface ServerCompany {
  /** The server's key. Displayed and correlated; never sent as a selector. */
  id: string;
  organizationId: string;
  /** The browser's own id for the same books — this IS the selector. */
  clientReference: string;
  legalName: string;
  bookkeepingLanguage: BookkeepingLanguage | null;
  languageLockedAt: string | null;
  languageSelectedBy: string | null;
  createdAt: string;
  /**
   * NULL means the organization's books have not been claimed by any client
   * yet. Registering adopts that row — same server id — rather than adding a
   * second company for the same legal entity.
   */
  adoptedAt: string | null;
  adoptedBy: string | null;
}

export const companiesApi = {
  /** Every set of books this organization keeps, oldest first. */
  list: async (): Promise<ServerCompany[]> =>
    (await api.get<{ companies: ServerCompany[] }>('/api/organizations/current/companies')).companies,

  /**
   * Register these books, or adopt them if the server already knows them.
   *
   * `created` distinguishes a first registration from a replay, so a caller can
   * tell the difference without inferring it from a status code.
   */
  register: async (input: { clientReference: string; legalName: string }): Promise<{
    company: ServerCompany;
    created: boolean;
    adopted: boolean;
  }> =>
    apiRequest<{ company: ServerCompany; created: boolean; adopted: boolean }>(
      '/api/organizations/current/companies',
      /*
       * Exempt from the adoption gate: this call IS the adoption. Waiting for
       * itself would deadlock the first request every subscriber makes.
       */
      { method: 'POST', body: input, skipCompanyRegistration: true },
    ),

  /**
   * Choose the bookkeeping language, once and permanently.
   *
   * Named by the SERVER id, which is safe because the server scopes the lookup
   * by the caller's own organization as well — an id from another tenant
   * resolves to nothing and answers 404, exactly as an invented one does.
   *
   * There is deliberately no counterpart that changes it. A database trigger
   * refuses every later change, so a "change language" call could only ever
   * fail; offering one would imply the decision is revisable when it is not.
   */
  lockBookkeepingLanguage: async (
    companyId: string,
    language: BookkeepingLanguage,
  ): Promise<ServerCompany> =>
    (await api.post<{ company: ServerCompany }>(
      `/api/organizations/current/companies/${companyId}/bookkeeping-language`,
      { language },
    )).company,
};
