/**
 * Company-scoped sales tax codes, and the effective-dated rates behind them.
 *
 * ══ What this owns, and what it refuses ══════════════════════════════════════
 *
 * The browser tax model is enormous — ten categories, seven scopes, four
 * calculation methods, recoverability, withholding timing, reverse-charge
 * account pairs. Most of it describes accounting this server has no controlled
 * mapping for, and a half-implemented reverse charge is worse than none: it
 * would post a self-assessed liability against an account nobody chose.
 *
 * So this owns the part that can be posted correctly today — percentage sales
 * tax, exclusive or inclusive, across the five categories a sales document
 * actually distinguishes — and refuses the rest by name, in the database as a
 * CHECK and here as a message that says which slice would bring it.
 *
 * ══ Why rates are their own rows ═════════════════════════════════════════════
 *
 * §5: do not overwrite historical tax rates. A rate is a property of a code on
 * a DATE. Editing one number would rewrite what every past invoice says it
 * charged, including documents a tax authority already cleared.
 *
 * ══ Why archiving never deletes ══════════════════════════════════════════════
 *
 * An issued invoice names its tax code, and the foreign key is RESTRICT. A code
 * that has been charged to a customer must stay identifiable for as long as the
 * document does — so a code leaves circulation by being archived, and the
 * invoices already carrying it are untouched. That is the whole difference
 * between archiving and deleting, and it is the same rule the customer
 * directory follows.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type {
  Database,
  SalesTaxCategory,
  SalesTaxMethod,
  SalesTaxStatus,
} from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import type { AccountingActor } from '../accounting/audit.js';
import { assessPostingAccount } from '../accounting/accountEligibility.js';
import { loadAccountsForPosting } from '../accounting/accountService.js';
import * as Money from '../accounting/money.js';
import { chargesTax } from '../accounting/salesTax.js';
import { toCalendarDate } from '../accounting/calendarDate.js';

type Executor = Kysely<Database> | Transaction<Database>;
type Trx = Transaction<Database>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const SUPPORTED_CATEGORIES: readonly SalesTaxCategory[] =
  ['standard', 'reduced', 'zero-rated', 'exempt', 'out-of-scope'];
export const SUPPORTED_METHODS: readonly SalesTaxMethod[] = ['exclusive', 'inclusive'];

/**
 * The methods and categories the browser knows and this server does not, with
 * the reason each is absent. Named individually because "unsupported" on its
 * own tells a bookkeeper nothing about whether to wait or to do something else.
 */
const REFUSED_METHODS: Record<string, string> = {
  compound: 'Compound tax applies each rate to the base plus the previous tax, and the order is '
    + 'configuration this server does not hold yet.',
  'self-assessed': 'Self-assessed tax posts a debit and a credit to a pair of accounts that are '
    + 'not configured here yet.',
  fixed: 'Fixed-amount tax is a charge per unit or per document rather than a percentage, and it '
    + 'has no controlled account or base on the server yet.',
};

const REFUSED_CATEGORIES: Record<string, string> = {
  'reverse-charge': 'Reverse charge creates a self-assessed output AND input tax at once, and the '
    + 'account pair for it is not configured on the server yet.',
  import: 'Import tax is assessed at the border against accounts this server does not hold yet.',
  'self-assessed': 'Self-assessed tax needs a debit and a credit account pair that is not '
    + 'configured here yet.',
  withholding: 'Withholding is recognised at a payment or receipt stage this slice does not cover.',
  custom: 'A custom category has no defined accounting treatment, so the server cannot post it.',
};

export interface TaxRateVersionRecord {
  id: string;
  taxCodeId: string;
  rate: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  outputTaxAccountId: string | null;
  createdAt: string | null;
}

export interface TaxCodeRecord {
  id: string;
  code: string;
  name: string;
  description: string;
  category: SalesTaxCategory;
  calculationMethod: SalesTaxMethod;
  status: SalesTaxStatus;
  outputTaxAccountId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  version: number;
  rateVersions: TaxRateVersionRecord[];
}

export interface TaxCodeAuditRecord {
  id: string;
  at: string;
  action: string;
  detail: unknown;
  previousVersion: number | null;
  resultingVersion: number | null;
  actorName: string;
}

/* ══ Mapping ═══════════════════════════════════════════════════════════════ */

/* See `calendarDate`: converting a bare `date` to UTC loses a day east of
 * Greenwich, which would end-date a rate version on the wrong day. */
const dateText = toCalendarDate;

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value ? String(value) : null;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function toVersion(row: any): TaxRateVersionRecord {
  return {
    id: row.id,
    taxCodeId: row.tax_code_id,
    rate: String(row.rate),
    effectiveFrom: dateText(row.effective_from),
    effectiveTo: row.effective_to ? dateText(row.effective_to) : null,
    outputTaxAccountId: row.output_tax_account_id ?? null,
    createdAt: iso(row.created_at),
  };
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function toRecord(row: any, versions: TaxRateVersionRecord[]): TaxCodeRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    category: row.category,
    calculationMethod: row.calculation_method,
    status: row.status,
    outputTaxAccountId: row.output_tax_account_id ?? null,
    effectiveFrom: dateText(row.effective_from),
    effectiveTo: row.effective_to ? dateText(row.effective_to) : null,
    version: Number(row.version),
    rateVersions: versions,
  };
}

/* ══ Validation ════════════════════════════════════════════════════════════ */

export interface TaxCodeInput {
  code?: string;
  name?: string;
  description?: string;
  category?: string;
  calculationMethod?: string;
  outputTaxAccountId?: string | null;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  /** The opening rate, for a create. Later changes go through a rate version. */
  rate?: string;
}

function assertCategory(value: string | undefined): SalesTaxCategory {
  if (!value) throw errors.validation('A tax category is required.', {
    fieldErrors: { category: 'Choose what kind of supply this code covers.' },
  });
  const refusal = REFUSED_CATEGORIES[value];
  if (refusal) {
    throw errors.validation(
      `${refusal} Nothing has been saved. Supported categories are: ${SUPPORTED_CATEGORIES.join(', ')}.`,
      { fieldErrors: { category: 'Choose a supported category.' } },
    );
  }
  if (!SUPPORTED_CATEGORIES.includes(value as SalesTaxCategory)) {
    throw errors.validation(
      `"${value}" is not a tax category this server recognises. Supported categories are: `
      + `${SUPPORTED_CATEGORIES.join(', ')}.`,
      { fieldErrors: { category: 'Choose a supported category.' } },
    );
  }
  return value as SalesTaxCategory;
}

function assertMethod(value: string | undefined): SalesTaxMethod {
  if (!value) throw errors.validation('A calculation method is required.', {
    fieldErrors: { calculationMethod: 'Choose exclusive or inclusive.' },
  });
  const refusal = REFUSED_METHODS[value];
  if (refusal) {
    throw errors.validation(
      `${refusal} Nothing has been saved. Supported methods are: ${SUPPORTED_METHODS.join(', ')}.`,
      { fieldErrors: { calculationMethod: 'Choose a supported method.' } },
    );
  }
  if (!SUPPORTED_METHODS.includes(value as SalesTaxMethod)) {
    throw errors.validation(
      `"${value}" is not a calculation method this server recognises. Supported methods are: `
      + `${SUPPORTED_METHODS.join(', ')}.`,
      { fieldErrors: { calculationMethod: 'Choose a supported method.' } },
    );
  }
  return value as SalesTaxMethod;
}

function assertDate(value: string | undefined | null, field: string): string {
  if (!value || !ISO_DATE.test(value)) {
    throw errors.validation(`${field} must be an ISO date (yyyy-mm-dd).`, {
      fieldErrors: { [field]: 'Use the format yyyy-mm-dd.' },
    });
  }
  return value;
}

/** A percentage, exact, and inside what the CHECK allows. */
function assertRate(value: string | undefined, field = 'rate'): Money.Amount {
  if (value === undefined || value === null || value === '') {
    throw errors.validation('A rate is required.', {
      fieldErrors: { [field]: 'Enter the percentage, for example 16.' },
    });
  }
  let amount: Money.Amount;
  try {
    amount = Money.toAmount(value, field);
  } catch {
    throw errors.validation(`The rate "${value}" is not a number.`, {
      fieldErrors: { [field]: 'Enter the percentage as a number, for example 16.' },
    });
  }
  if (Money.isNegative(amount)) {
    throw errors.validation('A tax rate cannot be negative.', {
      fieldErrors: { [field]: 'Enter zero or more.' },
    });
  }
  if (amount >= Money.toAmount('1000')) {
    throw errors.validation('A tax rate of 1000% or more is not a rate, it is a typing error.', {
      fieldErrors: { [field]: 'Enter a percentage below 1000.' },
    });
  }
  return amount;
}

/**
 * The output account a taxable code credits.
 *
 * Checked with the SAME rule the ledger uses for every other posting, so an
 * invoice and a journal cannot disagree about whether an account may receive
 * one. Scoped to this company by the query itself, which is what makes another
 * company's account a "does not exist" rather than a subtle cross-book posting.
 */
async function assertOutputAccount(
  trx: Executor,
  actor: AccountingActor,
  accountId: string,
  field = 'outputTaxAccountId',
): Promise<void> {
  const accounts = await loadAccountsForPosting(trx, actor.organizationId, actor.companyId, [accountId]);
  const account = accounts.get(accountId);
  if (!account) {
    throw errors.validation(
      'That output tax account does not exist in these books. Tax collected is held for an '
      + 'authority, so it must post to an account this company actually owns.',
      { fieldErrors: { [field]: 'Choose an account from this company\'s chart.' } },
    );
  }
  const verdict = assessPostingAccount(account, account.hasChildren);
  if (!verdict.eligible) {
    throw errors.validation(
      `That output tax account cannot receive postings: ${verdict.message}`,
      { fieldErrors: { [field]: 'Choose an active, postable account.' } },
    );
  }
}

/* ══ Reads ═════════════════════════════════════════════════════════════════ */

async function versionsFor(
  db: Executor,
  actor: AccountingActor,
  taxCodeIds: readonly string[],
): Promise<Map<string, TaxRateVersionRecord[]>> {
  if (taxCodeIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('tax_rate_versions')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('tax_code_id', 'in', [...taxCodeIds])
    .orderBy('effective_from', 'asc')
    .execute();
  const grouped = new Map<string, TaxRateVersionRecord[]>();
  for (const row of rows) {
    const list = grouped.get(row.tax_code_id) ?? [];
    list.push(toVersion(row));
    grouped.set(row.tax_code_id, list);
  }
  return grouped;
}

export async function listTaxCodes(
  db: Executor,
  actor: AccountingActor,
  options: { includeArchived?: boolean } = {},
): Promise<TaxCodeRecord[]> {
  let query = db
    .selectFrom('tax_codes')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId);
  if (!options.includeArchived) query = query.where('status', '!=', 'archived');
  const rows = await query.orderBy('code', 'asc').execute();
  const versions = await versionsFor(db, actor, rows.map((row) => row.id));
  return rows.map((row) => toRecord(row, versions.get(row.id) ?? []));
}

export async function getTaxCode(
  db: Executor,
  actor: AccountingActor,
  id: string,
): Promise<TaxCodeRecord> {
  const row = await db
    .selectFrom('tax_codes')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Tax code');
  const versions = await versionsFor(db, actor, [id]);
  return toRecord(row, versions.get(id) ?? []);
}

export async function taxCodeHistory(
  db: Executor,
  actor: AccountingActor,
  id: string,
): Promise<TaxCodeAuditRecord[]> {
  const rows = await db
    .selectFrom('tax_code_audit_events')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('tax_code_id', '=', id)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    at: iso(row.created_at) ?? '',
    action: row.action,
    detail: typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail,
    previousVersion: row.previous_version,
    resultingVersion: row.resulting_version,
    actorName: row.actor_name,
  }));
}

/* ══ Audit ═════════════════════════════════════════════════════════════════ */

async function writeAudit(
  trx: Trx,
  actor: AccountingActor,
  input: {
    taxCodeId: string;
    action: string;
    detail?: Record<string, unknown>;
    previousVersion?: number | null;
    resultingVersion?: number | null;
  },
): Promise<void> {
  await trx.insertInto('tax_code_audit_events').values({
    organization_id: actor.organizationId,
    company_id: actor.companyId,
    tax_code_id: input.taxCodeId,
    action: input.action,
    detail: JSON.stringify(input.detail ?? {}),
    previous_version: input.previousVersion ?? null,
    resulting_version: input.resultingVersion ?? null,
    actor_user_id: actor.userId,
    actor_name: actor.name,
  }).execute();
}

/* ══ Writes ════════════════════════════════════════════════════════════════ */

async function lockCode(
  trx: Trx,
  actor: AccountingActor,
  id: string,
  expectedVersion: number | undefined,
): Promise<{ id: string; version: number; status: SalesTaxStatus; category: SalesTaxCategory }> {
  const { rows } = await sql<{ id: string; version: number; status: SalesTaxStatus; category: SalesTaxCategory }>`
    SELECT id, version, status, category FROM tax_codes
     WHERE organization_id = ${actor.organizationId}
       AND company_id = ${actor.companyId}
       AND id = ${id}
     FOR UPDATE
  `.execute(trx);
  const row = rows[0];
  if (!row) throw errors.notFound('Tax code');
  if (typeof expectedVersion !== 'number') {
    throw errors.validation(
      'This change did not carry the version it was based on, so the server cannot tell whether '
      + 'somebody else has already changed the code. Reload and try again.',
      { fieldErrors: { expectedVersion: 'Reload the tax code and retry.' } },
    );
  }
  if (Number(row.version) !== expectedVersion) {
    throw errors.conflict(
      'This tax code was changed by another user while you were editing it. Reload to see their '
      + 'change before saving yours.',
    );
  }
  return { ...row, version: Number(row.version) };
}

export async function createTaxCode(
  db: Kysely<Database>,
  actor: AccountingActor,
  input: TaxCodeInput,
): Promise<TaxCodeRecord> {
  const code = (input.code ?? '').trim();
  const name = (input.name ?? '').trim();
  if (!code) throw errors.validation('A tax code needs a code.', {
    fieldErrors: { code: 'Enter the short code a bookkeeper will recognise, for example VAT16.' },
  });
  if (!name) throw errors.validation('A tax code needs a name.', {
    fieldErrors: { name: 'Enter a name, for example Standard-rated sales.' },
  });

  const category = assertCategory(input.category);
  const method = assertMethod(input.calculationMethod);
  const effectiveFrom = assertDate(input.effectiveFrom, 'effectiveFrom');
  const effectiveTo = input.effectiveTo ? assertDate(input.effectiveTo, 'effectiveTo') : null;
  if (effectiveTo && effectiveTo < effectiveFrom) {
    throw errors.validation('A tax code cannot stop applying before it starts.', {
      fieldErrors: { effectiveTo: 'Choose a date on or after the start date.' },
    });
  }

  const taxable = chargesTax(category);
  const rate = assertRate(taxable ? input.rate : (input.rate ?? '0'));
  if (!taxable && !Money.isZero(rate)) {
    throw errors.validation(
      `A ${category} supply charges no tax, so it cannot carry a rate. Zero-rated, exempt and `
      + 'out-of-scope are distinct from one another but all charge nothing.',
      { fieldErrors: { rate: 'Leave the rate at zero for this category.' } },
    );
  }

  /*
   * A zero-tax code may NOT name an output account, and the absence is the
   * point: an account here would imply a credit that must never be posted.
   */
  const outputTaxAccountId = input.outputTaxAccountId?.trim() || null;
  if (!taxable && outputTaxAccountId) {
    throw errors.validation(
      `A ${category} supply posts no tax, so it has no output tax account.`,
      { fieldErrors: { outputTaxAccountId: 'Remove the account for this category.' } },
    );
  }
  if (outputTaxAccountId) await assertOutputAccount(db, actor, outputTaxAccountId);

  return db.transaction().execute(async (trx) => {
    const duplicate = await trx
      .selectFrom('tax_codes')
      .select('id')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where(sql`lower(code)`, '=', code.toLowerCase())
      .executeTakeFirst();
    if (duplicate) {
      throw errors.conflict(
        `A tax code "${code}" already exists in these books. Codes are how a bookkeeper picks the `
        + 'right tax on a line, so two cannot share one.',
      );
    }

    const created = await trx.insertInto('tax_codes').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      code,
      name,
      description: input.description ?? '',
      category,
      calculation_method: method,
      status: 'active',
      output_tax_account_id: outputTaxAccountId,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      created_by: actor.userId,
      updated_by: actor.userId,
    } as never).returningAll().executeTakeFirstOrThrow();

    /* The opening rate is a VERSION from the outset, so there is never a period
     * whose rate came from somewhere other than the effective-dated table. */
    await trx.insertInto('tax_rate_versions').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      tax_code_id: created.id,
      rate: Money.toDecimalString(rate),
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      output_tax_account_id: outputTaxAccountId,
      created_by: actor.userId,
    } as never).execute();

    await writeAudit(trx, actor, {
      taxCodeId: created.id,
      action: 'TAX_CODE_CREATED',
      detail: { code, category, method, rate: Money.toDecimalString(rate), effectiveFrom },
      resultingVersion: 1,
    });

    const versions = await versionsFor(trx, actor, [created.id]);
    return toRecord(created, versions.get(created.id) ?? []);
  });
}

export async function updateTaxCode(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  input: TaxCodeInput & { expectedVersion?: number },
): Promise<TaxCodeRecord> {
  return db.transaction().execute(async (trx) => {
    const current = await lockCode(trx, actor, id, input.expectedVersion);
    if (current.status === 'archived') {
      throw errors.validation(
        'This tax code is archived. Archived codes are kept so the invoices that used them stay '
        + 'readable; they are not edited.',
      );
    }

    const name = (input.name ?? '').trim();
    if (!name) throw errors.validation('A tax code needs a name.', {
      fieldErrors: { name: 'Enter a name.' },
    });

    /*
     * The CATEGORY and METHOD are not editable.
     *
     * Both are frozen onto every line already issued under this code. Changing
     * one would leave the code describing a different tax from the one the
     * historical snapshots say it is — and a bookkeeper reading the code
     * afterwards would draw the wrong conclusion about documents that were
     * correct when issued. A new code is the honest way to change the treatment.
     */
    if (input.category && input.category !== current.category) {
      throw errors.validation(
        'A tax code\'s category cannot be changed. Invoices already issued under it have that '
        + 'category frozen on their lines, and editing it here would describe them wrongly. '
        + 'Create a new code and archive this one.',
        { fieldErrors: { category: 'Create a new tax code instead.' } },
      );
    }
    if (input.calculationMethod) assertMethod(input.calculationMethod);

    const outputTaxAccountId = input.outputTaxAccountId?.trim() || null;
    const taxable = chargesTax(current.category);
    if (!taxable && outputTaxAccountId) {
      throw errors.validation(
        `A ${current.category} supply posts no tax, so it has no output tax account.`,
        { fieldErrors: { outputTaxAccountId: 'Remove the account for this category.' } },
      );
    }
    if (outputTaxAccountId) await assertOutputAccount(trx, actor, outputTaxAccountId);

    const effectiveTo = input.effectiveTo ? assertDate(input.effectiveTo, 'effectiveTo') : null;

    const updated = await trx.updateTable('tax_codes').set({
      name,
      description: input.description ?? '',
      output_tax_account_id: outputTaxAccountId,
      effective_to: effectiveTo,
      version: current.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .returningAll().executeTakeFirstOrThrow();

    await writeAudit(trx, actor, {
      taxCodeId: id,
      action: 'TAX_CODE_UPDATED',
      detail: { name, outputTaxAccountId, effectiveTo },
      previousVersion: current.version,
      resultingVersion: current.version + 1,
    });

    const versions = await versionsFor(trx, actor, [id]);
    return toRecord(updated, versions.get(id) ?? []);
  });
}

export async function setTaxCodeStatus(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  status: SalesTaxStatus,
  expectedVersion: number | undefined,
): Promise<TaxCodeRecord> {
  return db.transaction().execute(async (trx) => {
    const current = await lockCode(trx, actor, id, expectedVersion);
    if (current.status === status) return getTaxCode(trx, actor, id);

    const updated = await trx.updateTable('tax_codes').set({
      status,
      version: current.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .returningAll().executeTakeFirstOrThrow();

    await writeAudit(trx, actor, {
      taxCodeId: id,
      action: status === 'archived' ? 'TAX_CODE_ARCHIVED'
        : status === 'active' ? 'TAX_CODE_ACTIVATED' : 'TAX_CODE_DEACTIVATED',
      previousVersion: current.version,
      resultingVersion: current.version + 1,
    });

    const versions = await versionsFor(trx, actor, [id]);
    return toRecord(updated, versions.get(id) ?? []);
  });
}

/**
 * Add an effective-dated rate.
 *
 * The open-ended predecessor is end-dated to the day before this one starts,
 * rather than left overlapping — §5 requires periods not to overlap, and an
 * overlap is not a cosmetic problem: `resolveRate` would have two answers for
 * one date and the tie would be broken by whichever sorted first.
 */
export async function addRateVersion(
  db: Kysely<Database>,
  actor: AccountingActor,
  taxCodeId: string,
  input: { rate?: string; effectiveFrom?: string; effectiveTo?: string | null; outputTaxAccountId?: string | null; expectedVersion?: number },
): Promise<TaxCodeRecord> {
  const effectiveFrom = assertDate(input.effectiveFrom, 'effectiveFrom');
  const effectiveTo = input.effectiveTo ? assertDate(input.effectiveTo, 'effectiveTo') : null;
  if (effectiveTo && effectiveTo < effectiveFrom) {
    throw errors.validation('A rate cannot stop applying before it starts.', {
      fieldErrors: { effectiveTo: 'Choose a date on or after the start date.' },
    });
  }

  return db.transaction().execute(async (trx) => {
    const current = await lockCode(trx, actor, taxCodeId, input.expectedVersion);
    if (current.status === 'archived') {
      throw errors.validation('This tax code is archived, so its rates are history and are not extended.');
    }

    const taxable = chargesTax(current.category);
    const rate = assertRate(taxable ? input.rate : (input.rate ?? '0'));
    if (!taxable && !Money.isZero(rate)) {
      throw errors.validation(
        `A ${current.category} supply charges no tax, so it cannot carry a rate.`,
        { fieldErrors: { rate: 'Leave the rate at zero for this category.' } },
      );
    }

    const outputTaxAccountId = input.outputTaxAccountId?.trim() || null;
    if (!taxable && outputTaxAccountId) {
      throw errors.validation(`A ${current.category} supply posts no tax, so it has no output tax account.`);
    }
    if (outputTaxAccountId) await assertOutputAccount(trx, actor, outputTaxAccountId);

    /* Existing versions, under the code's lock so two concurrent adds cannot
     * both believe they are the only one. */
    const existing = await trx
      .selectFrom('tax_rate_versions')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('tax_code_id', '=', taxCodeId)
      .orderBy('effective_from', 'asc')
      .execute();

    const newTo = effectiveTo ?? '9999-12-31';
    for (const row of existing) {
      const from = dateText(row.effective_from);
      const to = row.effective_to ? dateText(row.effective_to) : '9999-12-31';
      /* An open-ended predecessor is closed rather than treated as a clash. */
      if (!row.effective_to && from < effectiveFrom) continue;
      if (from <= newTo && effectiveFrom <= to) {
        throw errors.conflict(
          `A rate for this code already covers ${from} to ${row.effective_to ? to : 'open-ended'}. `
          + 'Rate periods may not overlap — two rates applying on one date would make the tax on '
          + 'that day a matter of which row was read first.',
        );
      }
    }

    const predecessor = existing.find((row) => !row.effective_to && dateText(row.effective_from) < effectiveFrom);
    if (predecessor) {
      const dayBefore = new Date(`${effectiveFrom}T00:00:00.000Z`);
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      await trx.updateTable('tax_rate_versions')
        .set({ effective_to: dayBefore.toISOString().slice(0, 10) } as never)
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', predecessor.id)
        .execute();
    }

    await trx.insertInto('tax_rate_versions').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      tax_code_id: taxCodeId,
      rate: Money.toDecimalString(rate),
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      output_tax_account_id: outputTaxAccountId,
      created_by: actor.userId,
    } as never).execute();

    await trx.updateTable('tax_codes').set({
      version: current.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', taxCodeId)
      .execute();

    await writeAudit(trx, actor, {
      taxCodeId,
      action: 'TAX_RATE_VERSION_ADDED',
      detail: { rate: Money.toDecimalString(rate), effectiveFrom, effectiveTo },
      previousVersion: current.version,
      resultingVersion: current.version + 1,
    });

    return getTaxCode(trx, actor, taxCodeId);
  });
}

/* ══ Resolution ════════════════════════════════════════════════════════════ */

export interface ResolvedTax {
  taxCodeId: string;
  code: string;
  name: string;
  category: SalesTaxCategory;
  method: SalesTaxMethod;
  rate: Money.Amount;
  rateVersionId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Null for the three zero-tax categories, which post nothing. */
  outputTaxAccountId: string | null;
}

/**
 * The rate applying to a document on its tax date.
 *
 * ══ Which date, and why ══════════════════════════════════════════════════════
 *
 * §5: "New documents resolve the version applicable on their document/posting
 * date." For a sales invoice those are ONE field — `issue_date` is what the
 * customer sees, what UBL emits as cbc:IssueDate, and what the ledger posts on,
 * which is also the date period locks are enforced against. Resolving tax on
 * anything else would let the tax rate and the ledger period disagree about
 * when the supply happened.
 *
 * A legal time-of-supply that differs from the invoice date — delivery-based or
 * payment-based tax points — is NOT modelled here. Inventing which of those
 * rules applies would be inventing tax policy, so the column exists on the line
 * to record what was used and the rule stays the one the spec states.
 */
export async function resolveTaxForDate(
  db: Executor,
  actor: AccountingActor,
  taxCodeId: string,
  taxPointDate: string,
): Promise<ResolvedTax> {
  const code = await db
    .selectFrom('tax_codes')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', taxCodeId)
    .executeTakeFirst();

  if (!code) {
    throw errors.validation(
      'That tax code does not exist in these books. A durable invoice may only name a tax code '
      + 'this company owns — which is what stops one company\'s invoice charging another\'s tax.',
      { fieldErrors: { taxCodeId: 'Choose a tax code from this company.' } },
    );
  }
  if (code.status === 'archived') {
    throw errors.validation(
      `Tax code ${code.code} is archived and cannot be put on a new invoice. Invoices already `
      + 'issued under it keep it, and their figures are unaffected.',
      { fieldErrors: { taxCodeId: 'Choose an active tax code.' } },
    );
  }
  if (code.status === 'inactive') {
    throw errors.validation(
      `Tax code ${code.code} is inactive and cannot be put on a new invoice.`,
      { fieldErrors: { taxCodeId: 'Choose an active tax code.' } },
    );
  }

  const effectiveFrom = dateText(code.effective_from);
  const codeTo = code.effective_to ? dateText(code.effective_to) : null;
  if (taxPointDate < effectiveFrom || (codeTo && taxPointDate > codeTo)) {
    throw errors.validation(
      `Tax code ${code.code} does not apply on ${taxPointDate}: it runs from ${effectiveFrom}`
      + `${codeTo ? ` to ${codeTo}` : ' onwards'}. An invoice cannot charge a tax that was not in `
      + 'force on its own date.',
      { fieldErrors: { taxCodeId: 'Choose a code effective on this invoice\'s date.' } },
    );
  }

  const versions = await db
    .selectFrom('tax_rate_versions')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('tax_code_id', '=', taxCodeId)
    .orderBy('effective_from', 'desc')
    .execute();

  const applicable = versions.find((row) => {
    const from = dateText(row.effective_from);
    const to = row.effective_to ? dateText(row.effective_to) : null;
    return taxPointDate >= from && (!to || taxPointDate <= to);
  });

  if (!applicable) {
    throw errors.validation(
      `Tax code ${code.code} has no rate in force on ${taxPointDate}. A rate is effective-dated so `
      + 'historical invoices keep the rate they charged; there is no rate to apply on this date, '
      + 'and the server will not fall back to a different period\'s.',
      { fieldErrors: { taxCodeId: 'Add a rate covering this date, or choose another code.' } },
    );
  }

  const taxable = chargesTax(code.category);
  const outputTaxAccountId = taxable
    ? (applicable.output_tax_account_id ?? code.output_tax_account_id ?? null)
    : null;

  return {
    taxCodeId,
    code: code.code,
    name: code.name,
    category: code.category,
    method: code.calculation_method,
    rate: Money.toAmount(String(applicable.rate), 'rate'),
    rateVersionId: applicable.id,
    effectiveFrom: dateText(applicable.effective_from),
    effectiveTo: applicable.effective_to ? dateText(applicable.effective_to) : null,
    outputTaxAccountId,
  };
}

/**
 * The account check that must happen at ISSUE, not only at configuration.
 *
 * An account is eligible when it is chosen and can stop being eligible before
 * the invoice is posted — archived, blocked, deactivated, or given a child and
 * so no longer a leaf. Checking only at configuration time would post tax to an
 * account the ledger would refuse from any other door.
 */
export async function assertOutputAccountPostable(
  trx: Executor,
  actor: AccountingActor,
  resolved: ResolvedTax,
): Promise<string> {
  if (!resolved.outputTaxAccountId) {
    throw errors.validation(
      `Tax code ${resolved.code} charges tax but has no output tax account, so this invoice cannot `
      + 'say where the tax it collects is held. Tax collected on an authority\'s behalf is a '
      + 'liability, not revenue — set the account on the tax code and issue again. Nothing has been saved.',
      { fieldErrors: { taxCodeId: 'Set an output tax account on this tax code.' } },
    );
  }
  const accounts = await loadAccountsForPosting(
    trx, actor.organizationId, actor.companyId, [resolved.outputTaxAccountId],
  );
  const account = accounts.get(resolved.outputTaxAccountId);
  if (!account) {
    throw errors.validation(
      `The output tax account for ${resolved.code} is not an account in these books. Nothing has been saved.`,
    );
  }
  const verdict = assessPostingAccount(account, account.hasChildren);
  if (!verdict.eligible) {
    throw errors.validation(
      `The output tax account for ${resolved.code} cannot receive postings: ${verdict.message} `
      + 'Nothing has been saved.',
    );
  }
  return resolved.outputTaxAccountId;
}
