/**
 * The business-party directory: shared identity, role-scoped detail.
 *
 * ══ Why the customer route cannot touch a supplier field ═════════════════════
 *
 * A party may hold the customer role, the supplier role, or both, over ONE
 * legal identity — one code, one tax number, one address book. Permission is
 * per role (`customers.*` and, later, `vendors.*`), which raises the obvious
 * question of what governs the shared fields both roles read.
 *
 * The answer here is structural rather than disciplined. This module writes
 * `business_parties` (shared) and `business_party_customer_profiles` (customer
 * only). It never writes a supplier profile, because the supplier profile is a
 * different table it does not import. A future `vendorPartyService` gets the
 * mirror deal. Neither can reach the other's columns even by mistake, and no
 * reviewer has to hold that rule in their head.
 *
 * Shared-field edits bump the party's version and are audited with the field
 * names that changed, so a customer edit and a supplier edit racing over the
 * same legal name conflict loudly instead of overwriting each other.
 *
 * ══ Archive, never delete ════════════════════════════════════════════════════
 *
 * There is no delete. A party named on an issued invoice must stay identifiable
 * for as long as the invoice exists, and a directory that can lose a name that
 * documents still reference is a directory that can orphan the books. Archiving
 * hides a party from pickers and leaves every reference intact; restoring is the
 * exact inverse. Dropping the customer ROLE clears one flag and leaves the party
 * and its supplier role untouched.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';

export type PartyExecutor = Kysely<Database> | Transaction<Database>;

/**
 * Who is acting, and on which books.
 *
 * Company sits beside organization and both are required, for the reason
 * `AccountingActor` documents: an optional company compiles at every call site
 * that forgets it and then silently scopes a query to the whole organization.
 */
export interface PartyActor {
  organizationId: string;
  /** Server-resolved from the company selector. Never from a request body. */
  companyId: string;
  userId: string;
  name: string;
  requestId?: string | null;
}

export type PartyAuditAction =
  | 'PARTY_CREATED'
  | 'PARTY_UPDATED'
  | 'PARTY_ARCHIVED'
  | 'PARTY_RESTORED'
  | 'CUSTOMER_ROLE_GRANTED'
  | 'CUSTOMER_ROLE_WITHDRAWN';

export interface PartyAddress {
  id: string;
  purpose: string;
  isPrimary: boolean;
  addressLine1: string;
  addressLine2: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface CustomerProfile {
  customerCategory: string;
  /** A decimal string. Never parsed here; see the migration. */
  creditLimit: string;
  defaultRevenueAccountId: string | null;
  defaultReceivableAccountId: string | null;
  defaultInvoiceTemplateId: string | null;
  invoiceDeliveryMethod: string;
  customerPaymentTerms: string;
}

export interface BusinessParty {
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
  status: string;
  version: number;
  addresses: PartyAddress[];
  /** Present only while the party holds the customer role. */
  customer: CustomerProfile | null;
  createdAt: string;
  updatedAt: string;
}

/* ══ Input shapes ═════════════════════════════════════════════════════════ */

export interface AddressInput {
  purpose?: string;
  isPrimary?: boolean;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postalCode?: string;
  country?: string;
}

export interface CustomerProfileInput {
  customerCategory?: string;
  /** A decimal STRING. A number here would reintroduce the float. */
  creditLimit?: string;
  defaultRevenueAccountId?: string | null;
  defaultReceivableAccountId?: string | null;
  defaultInvoiceTemplateId?: string | null;
  invoiceDeliveryMethod?: string;
  customerPaymentTerms?: string;
}

/** The shared fields a role route may change. Note what is absent: status, */
/** version, organization, company, actor and every supplier column. */
export interface SharedPartyInput {
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
}

export interface CreateCustomerInput extends SharedPartyInput {
  partyCode: string;
  legalName: string;
  addresses?: AddressInput[];
  customer?: CustomerProfileInput;
}

export interface UpdateCustomerInput extends SharedPartyInput {
  expectedVersion: number;
  addresses?: AddressInput[];
  customer?: CustomerProfileInput;
}

/* ══ Normalisation ════════════════════════════════════════════════════════ */

const DECIMAL = /^-?\d{1,18}(\.\d{1,10})?$/;

/**
 * Exactly the normalisation the browser directory already performed.
 *
 * Deliberately no more: inventing validation here — rejecting an email without
 * an `@`, say — would refuse records the product has always accepted, and a
 * migration slice is the wrong place to discover a new rule.
 */
function normalizeShared(input: SharedPartyInput): Record<string, string> {
  const out: Record<string, string> = {};
  const trim = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : value.trim();

  const assign = (column: string, value: string | undefined): void => {
    if (value !== undefined) out[column] = value;
  };

  assign('party_code', trim(input.partyCode));
  assign('legal_name', trim(input.legalName));
  assign('trading_name', trim(input.tradingName));
  assign('contact_person', trim(input.contactPerson));
  assign('job_title', trim(input.jobTitle));
  assign('email', trim(input.email));
  assign('phone', trim(input.phone));
  assign('mobile', trim(input.mobile));
  assign('website', trim(input.website));
  assign('tax_registration_number', trim(input.taxRegistrationNumber));
  assign('commercial_registration_number', trim(input.commercialRegistrationNumber));
  assign('payment_terms', trim(input.paymentTerms));
  assign('notes', input.notes);
  assign('bank_name', trim(input.bankName));
  assign('bank_account_name', trim(input.bankAccountName));

  /* The three the browser store upper-cases or strips. Same rules, same place. */
  if (input.defaultCurrency !== undefined) out.default_currency = input.defaultCurrency.trim().toUpperCase();
  if (input.iban !== undefined) out.iban = input.iban.replace(/\s+/gu, '').toUpperCase();
  if (input.swiftCode !== undefined) out.swift_code = input.swiftCode.trim().toUpperCase();

  return out;
}

function assertDecimal(value: string | undefined, field: string): void {
  if (value === undefined) return;
  if (!DECIMAL.test(value.trim())) {
    throw errors.validation('That is not a valid amount.', {
      fieldErrors: { [field]: 'Enter an amount such as 1000.000.' },
    });
  }
  if (value.trim().startsWith('-')) {
    throw errors.validation('A credit limit cannot be negative.', {
      fieldErrors: { [field]: 'Enter zero or a positive amount.' },
    });
  }
}

/* ══ Reading ══════════════════════════════════════════════════════════════ */

interface PartyRow {
  id: string; party_code: string; legal_name: string; trading_name: string;
  is_customer: boolean; is_supplier: boolean; contact_person: string; job_title: string;
  email: string; phone: string; mobile: string; website: string;
  tax_registration_number: string; commercial_registration_number: string;
  payment_terms: string; default_currency: string; bank_name: string;
  bank_account_name: string; iban: string; swift_code: string; notes: string;
  status: string; version: number; created_at: Date | string; updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function hydrate(
  db: PartyExecutor,
  actor: Pick<PartyActor, 'organizationId' | 'companyId'>,
  rows: PartyRow[],
): Promise<BusinessParty[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const addresses = await db
    .selectFrom('business_party_addresses')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('party_id', 'in', ids)
    .orderBy('purpose')
    .execute();

  const profiles = await db
    .selectFrom('business_party_customer_profiles')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('party_id', 'in', ids)
    .execute();

  const addressesBy = new Map<string, PartyAddress[]>();
  for (const row of addresses) {
    const list = addressesBy.get(row.party_id) ?? [];
    list.push({
      id: row.id,
      purpose: row.purpose,
      isPrimary: row.is_primary,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      city: row.city,
      postalCode: row.postal_code,
      country: row.country,
    });
    addressesBy.set(row.party_id, list);
  }

  const profileBy = new Map(profiles.map((row) => [row.party_id, row]));

  return rows.map((row) => {
    const profile = profileBy.get(row.id);
    return {
      id: row.id,
      partyCode: row.party_code,
      legalName: row.legal_name,
      tradingName: row.trading_name,
      isCustomer: row.is_customer,
      isSupplier: row.is_supplier,
      contactPerson: row.contact_person,
      jobTitle: row.job_title,
      email: row.email,
      phone: row.phone,
      mobile: row.mobile,
      website: row.website,
      taxRegistrationNumber: row.tax_registration_number,
      commercialRegistrationNumber: row.commercial_registration_number,
      paymentTerms: row.payment_terms,
      defaultCurrency: row.default_currency,
      bankName: row.bank_name,
      bankAccountName: row.bank_account_name,
      iban: row.iban,
      swiftCode: row.swift_code,
      notes: row.notes,
      status: row.status,
      version: row.version,
      addresses: addressesBy.get(row.id) ?? [],
      customer: profile
        ? {
            customerCategory: profile.customer_category,
            creditLimit: String(profile.credit_limit),
            defaultRevenueAccountId: profile.default_revenue_account_id,
            defaultReceivableAccountId: profile.default_receivable_account_id,
            defaultInvoiceTemplateId: profile.default_invoice_template_id,
            invoiceDeliveryMethod: profile.invoice_delivery_method,
            customerPaymentTerms: profile.customer_payment_terms,
          }
        : null,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  });
}

export interface ListCustomersQuery {
  /** Matches code, legal name or trading name. */
  search?: string;
  /** Archived parties are excluded unless asked for. */
  includeArchived?: boolean;
  limit?: number;
  /** Keyset cursor: the `partyCode` of the last row of the previous page. */
  after?: string | null;
}

/**
 * The most rows one page carries.
 *
 * A picker wants a bounded, deterministic list rather than a whole directory,
 * and an unbounded query is one a large tenant can make expensive from a
 * keystroke. Ordering is by `party_code`, which is unique per company, so the
 * cursor is a total order and a page boundary cannot repeat or skip a row.
 */
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

export async function listCustomers(
  db: PartyExecutor,
  actor: Pick<PartyActor, 'organizationId' | 'companyId'>,
  query: ListCustomersQuery = {},
): Promise<{ parties: BusinessParty[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);

  let statement = db
    .selectFrom('business_parties')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    /* This route serves the CUSTOMER directory; a supplier-only party is not
     * its business, and returning one would put a supplier in an invoice
     * picker. */
    .where('is_customer', '=', true);

  if (!query.includeArchived) statement = statement.where('status', '=', 'active');
  if (query.after) statement = statement.where('party_code', '>', query.after);

  if (query.search && query.search.trim()) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    statement = statement.where((eb) =>
      eb.or([
        eb(sql`lower(party_code)`, 'like', term),
        eb(sql`lower(legal_name)`, 'like', term),
        eb(sql`lower(trading_name)`, 'like', term),
      ]));
  }

  const rows = (await statement
    .orderBy('party_code')
    .limit(limit + 1)
    .execute()) as unknown as PartyRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const parties = await hydrate(db, actor, page);

  return {
    parties,
    nextCursor: hasMore ? (page[page.length - 1]?.party_code ?? null) : null,
  };
}

export async function getCustomer(
  db: PartyExecutor,
  actor: Pick<PartyActor, 'organizationId' | 'companyId'>,
  id: string,
): Promise<BusinessParty> {
  const rows = (await db
    .selectFrom('business_parties')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', id)
    .where('is_customer', '=', true)
    .execute()) as unknown as PartyRow[];

  /* Another company's party does not resolve, which is the honest answer:
   * there is no such customer in THESE books. */
  const [party] = await hydrate(db, actor, rows);
  if (!party) throw errors.notFound('Customer');
  return party;
}

/* ══ Writing ══════════════════════════════════════════════════════════════ */

async function writeAudit(
  trx: Transaction<Database>,
  actor: PartyActor,
  input: {
    action: PartyAuditAction;
    partyId: string;
    previousVersion?: number | null;
    resultingVersion?: number | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await trx
    .insertInto('business_party_audit_events')
    .values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      party_id: input.partyId,
      action: input.action,
      actor_user_id: actor.userId,
      actor_name: actor.name,
      previous_version: input.previousVersion ?? null,
      resulting_version: input.resultingVersion ?? null,
      detail: JSON.stringify(input.detail ?? {}),
      request_id: actor.requestId ?? null,
    })
    .execute();
}

/**
 * Turn a unique-index violation into the message that names the field.
 *
 * The constraint is the guarantee — two concurrent creates both pass a
 * read-before-write and only the index stops the second — so the race is LOST
 * gracefully here rather than prevented by a check that cannot hold.
 */
function asConflict(cause: unknown): never {
  const message = String((cause as { message?: string })?.message ?? '');
  if (message.includes('business_parties_code_unique')) {
    throw errors.conflict('That party code is already used in these books.');
  }
  if (message.includes('business_parties_tax_number_unique')) {
    throw errors.conflict('That tax registration number is already used by another party in these books.');
  }
  throw cause as Error;
}

async function replaceAddresses(
  trx: Transaction<Database>,
  actor: PartyActor,
  partyId: string,
  addresses: AddressInput[],
): Promise<void> {
  await trx
    .deleteFrom('business_party_addresses')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('party_id', '=', partyId)
    .execute();

  if (addresses.length === 0) return;

  /*
   * At most one primary per purpose is a database constraint, so a payload
   * naming two is refused rather than silently reduced. The first address of a
   * purpose becomes primary when none was marked, because a party whose only
   * address is not primary has an address no document will pick up.
   */
  const seenPrimary = new Set<string>();
  await trx
    .insertInto('business_party_addresses')
    .values(addresses.map((address) => {
      const purpose = address.purpose ?? 'billing';
      const wantsPrimary = address.isPrimary ?? !seenPrimary.has(purpose);
      if (wantsPrimary) seenPrimary.add(purpose);
      return {
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        party_id: partyId,
        purpose,
        is_primary: wantsPrimary,
        address_line1: address.addressLine1 ?? '',
        address_line2: address.addressLine2 ?? '',
        city: address.city ?? '',
        postal_code: address.postalCode ?? '',
        country: address.country ?? '',
      };
    }))
    .execute();
}

async function upsertCustomerProfile(
  trx: Transaction<Database>,
  actor: PartyActor,
  partyId: string,
  profile: CustomerProfileInput,
): Promise<void> {
  assertDecimal(profile.creditLimit, 'creditLimit');

  await trx
    .insertInto('business_party_customer_profiles')
    .values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      party_id: partyId,
      customer_category: profile.customerCategory ?? '',
      credit_limit: profile.creditLimit ?? '0',
      default_revenue_account_id: profile.defaultRevenueAccountId ?? null,
      default_receivable_account_id: profile.defaultReceivableAccountId ?? null,
      default_invoice_template_id: profile.defaultInvoiceTemplateId ?? null,
      invoice_delivery_method: profile.invoiceDeliveryMethod ?? '',
      customer_payment_terms: profile.customerPaymentTerms ?? '',
    })
    .onConflict((oc) => oc
      .columns(['organization_id', 'company_id', 'party_id'])
      .doUpdateSet({
        customer_category: profile.customerCategory ?? '',
        credit_limit: profile.creditLimit ?? '0',
        default_revenue_account_id: profile.defaultRevenueAccountId ?? null,
        default_receivable_account_id: profile.defaultReceivableAccountId ?? null,
        default_invoice_template_id: profile.defaultInvoiceTemplateId ?? null,
        invoice_delivery_method: profile.invoiceDeliveryMethod ?? '',
        customer_payment_terms: profile.customerPaymentTerms ?? '',
        updated_at: sql`now()`,
      }))
    .execute();
}

export async function createCustomer(
  db: Kysely<Database>,
  actor: PartyActor,
  input: CreateCustomerInput,
): Promise<BusinessParty> {
  const shared = normalizeShared(input);
  if (!shared.party_code) throw errors.validation('A party code is required.');
  if (!shared.legal_name) throw errors.validation('A legal name is required.');

  const id = await db.transaction().execute(async (trx) => {
    let partyId: string;
    try {
      const row = await trx
        .insertInto('business_parties')
        .values({
          organization_id: actor.organizationId,
          company_id: actor.companyId,
          /* The role this route owns. A supplier flag is never set here. */
          is_customer: true,
          created_by: actor.userId,
          updated_by: actor.userId,
          ...shared,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
      partyId = row.id;
    } catch (cause) {
      asConflict(cause);
    }

    await replaceAddresses(trx, actor, partyId, input.addresses ?? []);
    await upsertCustomerProfile(trx, actor, partyId, input.customer ?? {});
    await writeAudit(trx, actor, {
      action: 'PARTY_CREATED',
      partyId,
      resultingVersion: 1,
      detail: { partyCode: shared.party_code, roles: ['customer'] },
    });
    return partyId;
  });

  return getCustomer(db, actor, id);
}

const VERSION_CONFLICT =
  'This customer was changed by someone else while you were editing it. '
  + 'Review the latest version before applying your changes.';

export async function updateCustomer(
  db: Kysely<Database>,
  actor: PartyActor,
  id: string,
  input: UpdateCustomerInput,
): Promise<BusinessParty> {
  const shared = normalizeShared(input);

  await db.transaction().execute(async (trx) => {
    /*
     * Locked, then version-checked. `FOR UPDATE` matters: without it two
     * concurrent edits both read version 3, both write version 4, and the
     * second silently discards the first — which is exactly what a version
     * column exists to prevent.
     */
    const current = await trx
      .selectFrom('business_parties')
      .select(['id', 'version', 'status', 'is_customer'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!current || !current.is_customer) throw errors.notFound('Customer');
    if (current.version !== input.expectedVersion) throw errors.conflict(VERSION_CONFLICT);

    try {
      await trx
        .updateTable('business_parties')
        .set({
          ...shared,
          version: current.version + 1,
          updated_by: actor.userId,
          updated_at: sql`now()`,
        } as never)
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', id)
        .execute();
    } catch (cause) {
      asConflict(cause);
    }

    if (input.addresses) await replaceAddresses(trx, actor, id, input.addresses);
    if (input.customer) await upsertCustomerProfile(trx, actor, id, input.customer);

    await writeAudit(trx, actor, {
      action: 'PARTY_UPDATED',
      partyId: id,
      previousVersion: current.version,
      resultingVersion: current.version + 1,
      /* The field NAMES, so a shared-field edit is findable when a supplier
       * edit later collides with it. Values are not copied: an audit trail is
       * not a second store of the customer's data. */
      detail: { changed: Object.keys(shared).sort() },
    });
  });

  return getCustomer(db, actor, id);
}

/**
 * Archive or restore. There is no delete, by construction.
 *
 * An archived party keeps every reference an issued document holds; it simply
 * stops appearing where somebody would pick a new one.
 */
export async function setCustomerArchived(
  db: Kysely<Database>,
  actor: PartyActor,
  id: string,
  input: { archived: boolean; expectedVersion: number; reason?: string },
): Promise<BusinessParty> {
  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('business_parties')
      .select(['id', 'version', 'status', 'is_customer'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!current || !current.is_customer) throw errors.notFound('Customer');
    if (current.version !== input.expectedVersion) throw errors.conflict(VERSION_CONFLICT);

    const status = input.archived ? 'archived' : 'active';
    if (current.status === status) return;

    await trx
      .updateTable('business_parties')
      .set({
        status,
        archived_at: input.archived ? sql`now()` : null,
        version: current.version + 1,
        updated_by: actor.userId,
        updated_at: sql`now()`,
      } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writeAudit(trx, actor, {
      action: input.archived ? 'PARTY_ARCHIVED' : 'PARTY_RESTORED',
      partyId: id,
      previousVersion: current.version,
      resultingVersion: current.version + 1,
      detail: input.reason ? { reason: input.reason } : {},
    });
  });

  return getCustomer(db, actor, id);
}

/** One party's audit trail, newest first. */
export async function customerHistory(
  db: PartyExecutor,
  actor: Pick<PartyActor, 'organizationId' | 'companyId'>,
  id: string,
): Promise<Array<{
  action: string; actorName: string; at: string;
  previousVersion: number | null; resultingVersion: number | null;
  detail: Record<string, unknown>;
}>> {
  const rows = await db
    .selectFrom('business_party_audit_events')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('party_id', '=', id)
    .orderBy('at', 'desc')
    .limit(200)
    .execute();

  return rows.map((row) => ({
    action: row.action,
    actorName: row.actor_name,
    at: toIso(row.at as unknown as Date | string),
    previousVersion: row.previous_version,
    resultingVersion: row.resulting_version,
    detail: row.detail as Record<string, unknown>,
  }));
}
