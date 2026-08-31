/**
 * The supplier directory, server-authoritative.
 *
 * ══ The mirror of the customer route, and why that shape ═════════════════════
 *
 * A party may hold the customer role, the supplier role, or both, over ONE
 * legal identity — one code, one tax number, one address book. The product has
 * always modelled it that way (`EntityType = 'customer' | 'supplier' | 'both'`),
 * and migration 030 kept it: identity lives once, roles are flags.
 *
 * So this service writes the shared party columns and
 * `business_party_supplier_profiles`, and NOTHING else. It never touches
 * `business_party_customer_profiles` — not because it is careful, but because
 * it never issues a statement against that table. `businessPartyService` has
 * the same guarantee in the other direction. Both read the whole party, because
 * reading a profile is not writing one.
 *
 * ══ Codes are supplied, not allocated ════════════════════════════════════════
 *
 * There is no supplier NUMBER sequence in this product and this slice does not
 * invent one. `party_code` is entered by the user, required, and unique per
 * company case-insensitively — the browser directory has always worked that
 * way, and `suggestEntityCode` merely proposes a free one from the name.
 *
 * Two concurrent creates therefore both pass any read-before-write check, and
 * the UNIQUE INDEX is what stops the second. The race is LOST gracefully rather
 * than prevented by a check that cannot hold, which is the same arrangement the
 * customer route relies on.
 *
 * ══ What P1 does not do ══════════════════════════════════════════════════════
 *
 * No bills, payments, purchase orders, goods receipts, supplier balances or
 * statements; no purchase tax; no opening balances. A supplier here is master
 * data and a payable account assignment, and nothing in this file posts to a
 * ledger.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import { assessPostingAccount } from '../accounting/accountEligibility.js';
import { loadAccountsForPosting } from '../accounting/accountService.js';
import {
  hydrate,
  normalizeShared,
  replaceAddresses,
  writeAudit,
  asConflict,
  type AddressInput,
  type BusinessParty,
  type PartyActor,
  type PartyExecutor,
  type PartyRow,
  type SharedPartyInput,
} from '../sales/businessPartyService.js';

/* ══ Input shapes ═════════════════════════════════════════════════════════ */

export interface SupplierProfileInput {
  supplierCategory?: string;
  defaultPayableAccountId?: string | null;
  defaultExpenseAccountId?: string | null;
  supplierPaymentTerms?: string;
  withholdingTaxApplicable?: boolean;
  preferredPaymentMethod?: string;
}

export interface CreateSupplierInput extends SharedPartyInput {
  partyCode: string;
  legalName: string;
  addresses?: AddressInput[];
  supplier?: SupplierProfileInput;
}

export interface UpdateSupplierInput extends SharedPartyInput {
  expectedVersion: number;
  addresses?: AddressInput[];
  supplier?: SupplierProfileInput;
}

export interface ListSuppliersQuery {
  search?: string;
  includeArchived?: boolean;
  limit?: number;
  after?: string | null;
}

/* ══ Account eligibility ══════════════════════════════════════════════════ */

/**
 * The account a supplier's bills will credit.
 *
 * ══ Why this is checked here and not left to the key ═════════════════════════
 *
 * The composite foreign key already makes another company's account
 * unrepresentable. What it cannot express is everything else that decides
 * whether an account may receive a posting — active, unblocked, unarchived,
 * postable, not a parent — and, for a payable, that it is a LIABILITY.
 *
 * A payable pointing at an income account balances any entry it appears in
 * while recording what the business owes as what it earned. That is invisible
 * in a trial balance and wrong in every statement, so the type is checked
 * rather than assumed. The client's claim about an account is never accepted:
 * the id is resolved against this company's chart and judged here.
 */
async function assertAssignableAccount(
  db: PartyExecutor,
  actor: Pick<PartyActor, 'organizationId' | 'companyId'>,
  accountId: string,
  options: { field: string; requiredType: 'liability' | 'expense'; label: string },
): Promise<void> {
  const accounts = await loadAccountsForPosting(
    db, actor.organizationId, actor.companyId, [accountId],
  );
  const account = accounts.get(accountId);

  if (!account) {
    /* Identical to "no such account", so the API cannot be used to discover
     * which ids exist in another company's chart. */
    throw errors.validation(
      `That ${options.label} does not exist in these books.`,
      { fieldErrors: { [options.field]: "Choose an account from this company's chart." } },
    );
  }

  if (account.accountType !== options.requiredType) {
    throw errors.validation(
      `A ${options.label} must be ${options.requiredType === 'liability' ? 'a liability' : 'an expense'} `
      + `account. ${account.accountCode} (${account.accountName}) is ${account.accountType}. `
      + (options.requiredType === 'liability'
        ? 'What the business owes a supplier is a liability; recording it anywhere else misstates '
          + 'every statement it appears in.'
        : ''),
      { fieldErrors: { [options.field]: `Choose ${options.requiredType === 'liability' ? 'a liability' : 'an expense'} account.` } },
    );
  }

  const verdict = assessPostingAccount(account, account.hasChildren);
  if (!verdict.eligible) {
    throw errors.validation(
      `That ${options.label} cannot receive postings: ${verdict.message}`,
      { fieldErrors: { [options.field]: 'Choose an active, postable account.' } },
    );
  }
}

async function assertProfileAccounts(
  db: PartyExecutor,
  actor: Pick<PartyActor, 'organizationId' | 'companyId'>,
  profile: SupplierProfileInput | undefined,
): Promise<void> {
  if (!profile) return;
  if (profile.defaultPayableAccountId) {
    await assertAssignableAccount(db, actor, profile.defaultPayableAccountId, {
      field: 'supplier.defaultPayableAccountId',
      requiredType: 'liability',
      label: 'accounts payable account',
    });
  }
  if (profile.defaultExpenseAccountId) {
    await assertAssignableAccount(db, actor, profile.defaultExpenseAccountId, {
      field: 'supplier.defaultExpenseAccountId',
      requiredType: 'expense',
      label: 'default expense account',
    });
  }
}

/* ══ Reading ══════════════════════════════════════════════════════════════ */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface SupplierPage {
  parties: BusinessParty[];
  /** The `partyCode` to pass as `after` for the next page, or null at the end. */
  nextCursor: string | null;
}

/**
 * The directory, paged.
 *
 * Bounded by construction: a picker asks for a page and a search term, never
 * for a whole tenant's directory. The cursor is the party code — unique per
 * company, so a page boundary can neither repeat nor skip a row.
 */
export async function listSuppliers(
  db: PartyExecutor,
  actor: Pick<PartyActor, 'organizationId' | 'companyId'>,
  query: ListSuppliersQuery = {},
): Promise<SupplierPage> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  let builder = db
    .selectFrom('business_parties')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('is_supplier', '=', true);

  if (!query.includeArchived) builder = builder.where('status', '=', 'active');

  const search = (query.search ?? '').trim();
  if (search) {
    const pattern = `%${search.toLowerCase()}%`;
    builder = builder.where((eb) => eb.or([
      eb(sql`lower(party_code)`, 'like', pattern),
      eb(sql`lower(legal_name)`, 'like', pattern),
      eb(sql`lower(trading_name)`, 'like', pattern),
    ]));
  }

  if (query.after) builder = builder.where('party_code', '>', query.after);

  const rows = (await builder
    .orderBy('party_code', 'asc')
    .limit(limit + 1)
    .execute()) as unknown as PartyRow[];

  const page = rows.slice(0, limit);
  const parties = await hydrate(db, actor, page);
  return {
    parties,
    nextCursor: rows.length > limit ? (page[page.length - 1]?.party_code ?? null) : null,
  };
}

export async function getSupplier(
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
    .where('is_supplier', '=', true)
    .execute()) as unknown as PartyRow[];

  /* Another company's party does not resolve, which is the honest answer:
   * there is no such supplier in THESE books. */
  const [party] = await hydrate(db, actor, rows);
  if (!party) throw errors.notFound('Supplier');
  return party;
}

export async function supplierHistory(
  db: PartyExecutor,
  actor: Pick<PartyActor, 'organizationId' | 'companyId'>,
  id: string,
): Promise<Array<{
  action: string; actorName: string; at: string;
  previousVersion: number | null; resultingVersion: number | null;
  detail: Record<string, unknown>;
}>> {
  /* Scoped by the party's own company first, so a foreign id yields a
   * "not found" rather than another tenant's trail. */
  await getSupplier(db, actor, id);

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
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
    previousVersion: row.previous_version,
    resultingVersion: row.resulting_version,
    detail: row.detail as Record<string, unknown>,
  }));
}

/* ══ Writing ══════════════════════════════════════════════════════════════ */

async function upsertSupplierProfile(
  trx: Transaction<Database>,
  actor: PartyActor,
  partyId: string,
  profile: SupplierProfileInput,
): Promise<void> {
  const values = {
    supplier_category: profile.supplierCategory ?? '',
    default_payable_account_id: profile.defaultPayableAccountId ?? null,
    default_expense_account_id: profile.defaultExpenseAccountId ?? null,
    supplier_payment_terms: profile.supplierPaymentTerms ?? '',
    withholding_tax_applicable: profile.withholdingTaxApplicable ?? false,
    preferred_payment_method: profile.preferredPaymentMethod ?? '',
  };

  await trx
    .insertInto('business_party_supplier_profiles')
    .values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      party_id: partyId,
      ...values,
    } as never)
    .onConflict((oc) => oc
      .columns(['organization_id', 'company_id', 'party_id'])
      .doUpdateSet({ ...values, updated_at: sql`now()` } as never))
    .execute();
}

/** The payable account as it stands, for an audit event that names the change. */
async function currentPayable(
  trx: Transaction<Database>,
  actor: PartyActor,
  partyId: string,
): Promise<string | null> {
  const row = await trx
    .selectFrom('business_party_supplier_profiles')
    .select('default_payable_account_id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('party_id', '=', partyId)
    .executeTakeFirst();
  return row?.default_payable_account_id ?? null;
}

export async function createSupplier(
  db: Kysely<Database>,
  actor: PartyActor,
  input: CreateSupplierInput,
): Promise<BusinessParty> {
  const shared = normalizeShared(input);
  if (!shared.party_code) throw errors.validation('A supplier code is required.', {
    fieldErrors: { partyCode: 'Enter the code a bookkeeper will recognise.' },
  });
  if (!shared.legal_name) throw errors.validation('A legal name is required.', {
    fieldErrors: { legalName: 'Enter the supplier’s registered name.' },
  });

  /* Validated BEFORE the transaction opens, so a refused account leaves no
   * half-created party behind. */
  await assertProfileAccounts(db, actor, input.supplier);

  const id = await db.transaction().execute(async (trx) => {
    let partyId: string;
    try {
      const created = await trx
        .insertInto('business_parties')
        .values({
          organization_id: actor.organizationId,
          company_id: actor.companyId,
          is_supplier: true,
          is_customer: false,
          created_by: actor.userId,
          updated_by: actor.userId,
          ...shared,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
      partyId = created.id;
    } catch (cause) {
      /* Two concurrent creates both pass any read-before-write; the unique
       * index is what stops the second, and this names the field. */
      asConflict(cause);
    }

    await replaceAddresses(trx, actor, partyId, input.addresses ?? []);
    await upsertSupplierProfile(trx, actor, partyId, input.supplier ?? {});

    await writeAudit(trx, actor, {
      action: 'PARTY_CREATED',
      partyId,
      resultingVersion: 1,
      detail: { role: 'supplier', partyCode: shared.party_code },
    });
    await writeAudit(trx, actor, {
      action: 'SUPPLIER_ROLE_GRANTED',
      partyId,
      resultingVersion: 1,
      detail: { payableAccountId: input.supplier?.defaultPayableAccountId ?? null },
    });

    return partyId;
  });

  return getSupplier(db, actor, id);
}

export async function updateSupplier(
  db: Kysely<Database>,
  actor: PartyActor,
  id: string,
  input: UpdateSupplierInput,
): Promise<BusinessParty> {
  const shared = normalizeShared(input);
  await assertProfileAccounts(db, actor, input.supplier);

  await db.transaction().execute(async (trx) => {
    /*
     * Locked and version-checked together. A stale update must fail rather than
     * overwrite a newer record, and reading without the lock would let two
     * editors both see the version they expected.
     */
    const { rows } = await sql<{
      version: number; status: string; is_supplier: boolean; tax_registration_number: string;
    }>`
      SELECT version, status, is_supplier, tax_registration_number
        FROM business_parties
       WHERE organization_id = ${actor.organizationId}
         AND company_id = ${actor.companyId}
         AND id = ${id}
       FOR UPDATE
    `.execute(trx);

    const current = rows[0];
    if (!current || !current.is_supplier) throw errors.notFound('Supplier');
    if (current.version !== input.expectedVersion) {
      throw errors.conflict(
        'This supplier was changed by someone else while you were editing it. '
        + 'Reload to see their change before saving yours.',
      );
    }
    if (current.status === 'archived') {
      throw errors.validation(
        'This supplier is archived. Restore it before making changes.',
      );
    }

    const payableBefore = await currentPayable(trx, actor, id);

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
    if (input.supplier) await upsertSupplierProfile(trx, actor, id, input.supplier);

    await writeAudit(trx, actor, {
      action: 'PARTY_UPDATED',
      partyId: id,
      previousVersion: current.version,
      resultingVersion: current.version + 1,
    });

    /*
     * Two changes get their OWN events, because both are material and both are
     * questions somebody asks of the trail later: where does this supplier post,
     * and when did its tax identity change.
     */
    const payableAfter = input.supplier
      ? (input.supplier.defaultPayableAccountId ?? null)
      : payableBefore;
    if (payableAfter !== payableBefore) {
      await writeAudit(trx, actor, {
        action: 'SUPPLIER_PAYABLE_ACCOUNT_CHANGED',
        partyId: id,
        previousVersion: current.version,
        resultingVersion: current.version + 1,
        detail: { from: payableBefore, to: payableAfter },
      });
    }

    const taxAfter = shared.tax_registration_number;
    if (taxAfter !== undefined && taxAfter !== current.tax_registration_number) {
      await writeAudit(trx, actor, {
        action: 'SUPPLIER_TAX_IDENTITY_CHANGED',
        partyId: id,
        previousVersion: current.version,
        resultingVersion: current.version + 1,
        detail: { from: current.tax_registration_number, to: taxAfter },
      });
    }
  });

  return getSupplier(db, actor, id);
}

/**
 * Archive or restore. There is NO delete.
 *
 * A supplier named on a bill — today a browser record, tomorrow a server one —
 * must stay identifiable for as long as the document does. Archiving takes it
 * out of pickers and leaves every reference intact, which is the whole
 * difference between archiving and deleting.
 */
export async function setSupplierArchived(
  db: Kysely<Database>,
  actor: PartyActor,
  id: string,
  input: { archived: boolean; expectedVersion: number; reason?: string },
): Promise<BusinessParty> {
  await db.transaction().execute(async (trx) => {
    const { rows } = await sql<{ version: number; status: string; is_supplier: boolean }>`
      SELECT version, status, is_supplier FROM business_parties
       WHERE organization_id = ${actor.organizationId}
         AND company_id = ${actor.companyId}
         AND id = ${id}
       FOR UPDATE
    `.execute(trx);

    const current = rows[0];
    if (!current || !current.is_supplier) throw errors.notFound('Supplier');
    if (current.version !== input.expectedVersion) {
      throw errors.conflict(
        'This supplier was changed by someone else while you were editing it. Reload and try again.',
      );
    }

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

  return getSupplier(db, actor, id);
}

/**
 * Give an EXISTING party the supplier role.
 *
 * ══ Why this exists rather than "create it again" ════════════════════════════
 *
 * One legal party that sells to us and buys from us is ONE record — that is the
 * whole reason 030 chose roles over separate tables. Since the party code and
 * the tax number are unique per company, creating a second record for the same
 * entity is refused by the database anyway; without this endpoint the user's
 * only escape would be to invent a second code, which is precisely the
 * duplication the model exists to prevent.
 *
 * It is deliberately separate from `createSupplier`: silently mutating an
 * existing customer because a "new supplier" form happened to reuse its code
 * would be a surprising write, and a surprising write to a shared record is how
 * one department edits another's data without knowing.
 */
export async function grantSupplierRole(
  db: Kysely<Database>,
  actor: PartyActor,
  id: string,
  input: { expectedVersion: number; supplier?: SupplierProfileInput },
): Promise<BusinessParty> {
  await assertProfileAccounts(db, actor, input.supplier);

  await db.transaction().execute(async (trx) => {
    const { rows } = await sql<{ version: number; is_supplier: boolean; status: string }>`
      SELECT version, is_supplier, status FROM business_parties
       WHERE organization_id = ${actor.organizationId}
         AND company_id = ${actor.companyId}
         AND id = ${id}
       FOR UPDATE
    `.execute(trx);

    const current = rows[0];
    if (!current) throw errors.notFound('Party');
    if (current.version !== input.expectedVersion) {
      throw errors.conflict('This party was changed by someone else. Reload and try again.');
    }
    if (current.is_supplier) {
      throw errors.validation('This party is already a supplier.');
    }
    if (current.status === 'archived') {
      throw errors.validation('This party is archived. Restore it before giving it a new role.');
    }

    await trx
      .updateTable('business_parties')
      .set({
        is_supplier: true,
        version: current.version + 1,
        updated_by: actor.userId,
        updated_at: sql`now()`,
      } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await upsertSupplierProfile(trx, actor, id, input.supplier ?? {});
    await writeAudit(trx, actor, {
      action: 'SUPPLIER_ROLE_GRANTED',
      partyId: id,
      previousVersion: current.version,
      resultingVersion: current.version + 1,
      detail: { payableAccountId: input.supplier?.defaultPayableAccountId ?? null },
    });
  });

  return getSupplier(db, actor, id);
}

/**
 * How many parties in these books hold the supplier role.
 *
 * Read by the screen that has to explain an empty list: a durable subscriber
 * whose suppliers are still in a browser sees "none here yet, and here is why"
 * rather than a blank table that looks like data loss.
 */
export async function countSuppliers(
  db: PartyExecutor,
  actor: Pick<PartyActor, 'organizationId' | 'companyId'>,
): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n FROM business_parties
     WHERE organization_id = ${actor.organizationId}
       AND company_id = ${actor.companyId}
       AND is_supplier = true
  `.execute(db);
  return Number(rows[0]?.n ?? '0');
}
