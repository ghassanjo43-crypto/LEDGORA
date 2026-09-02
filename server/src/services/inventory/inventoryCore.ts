/**
 * The rules every piece of inventory master data shares.
 *
 * ══ Why account eligibility is decided here and never by the client ══════════
 *
 * An item names the accounts its stock will one day post through. The client
 * offers a picker, but the picker is a convenience: what makes a mapping legal
 * is the account's own type, its posting flags and the company it belongs to,
 * and all three live in the database. A caller that sent an account id it liked
 * would otherwise be choosing where cost of sales lands.
 *
 * ══ Why a role has a required type ═══════════════════════════════════════════
 *
 * Inventory is an asset; cost of sales is an expense; revenue is income. These
 * are not preferences. Mapping inventory to a bank account would put stock in
 * the cash-flow statement, and mapping cost of sales to a payable would make a
 * liability grow every time something was sold. So each role declares the type
 * it must have, and cash-classified accounts are refused outright for every
 * role — none of these is ever a bank.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import { assessPostingAccount } from '../accounting/accountEligibility.js';

export type InventoryExecutor = Kysely<Database> | Transaction<Database>;

export interface InventoryActor {
  organizationId: string;
  companyId: string;
  userId: string;
  name: string;
  requestId?: string;
}

export type InventorySubject = 'item' | 'warehouse' | 'unit' | 'settings';

/* ── Audit ─────────────────────────────────────────────────────────────────── */

export interface InventoryAuditInput {
  subjectType: InventorySubject;
  subjectId?: string | null;
  action: string;
  resultingVersion?: number | null;
  detail?: Record<string, unknown>;
}

export async function writeInventoryAudit(
  trx: InventoryExecutor,
  actor: InventoryActor,
  input: InventoryAuditInput,
): Promise<void> {
  await trx
    .insertInto('inventory_audit_events')
    .values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      subject_type: input.subjectType,
      subject_id: input.subjectId ?? null,
      action: input.action,
      resulting_version: input.resultingVersion ?? null,
      detail: JSON.stringify(input.detail ?? {}),
      actor_user_id: actor.userId,
      actor_name: actor.name,
      request_id: actor.requestId ?? '',
    } as never)
    .execute();
}

/* ── Optimistic concurrency ────────────────────────────────────────────────── */

export const STALE =
  'This record was changed by another user while you were editing it. Reload and try again so you '
  + 'do not overwrite their change.';

export function assertVersion(current: number, expected: number): void {
  if (current !== expected) throw errors.conflict(STALE);
}

/* ── Account eligibility ───────────────────────────────────────────────────── */

/**
 * The account roles I1 can validate, and the ledger type each must be.
 *
 * `purchase` is an EXPENSE and not an asset: it is where a NON-STOCK item's
 * purchase goes, which is a cost the moment it is incurred. The asset case is
 * `inventory`, and it is a different role precisely because the two must not be
 * confused by a form.
 */
interface AccountRoleSpec {
  /** The ledger type this role demands, or null where more than one is defensible. */
  type: string | null;
  label: string;
}

export const ACCOUNT_ROLES = {
  inventory: { type: 'asset', label: 'inventory asset' },
  cogs: { type: 'expense', label: 'cost of sales' },
  sales: { type: 'income', label: 'sales revenue' },
  purchase: { type: 'expense', label: 'purchase / expense' },
  adjustment: { type: 'expense', label: 'inventory adjustment' },
  gain: { type: 'income', label: 'inventory gain' },
  loss: { type: 'expense', label: 'inventory loss' },
  transit: { type: 'asset', label: 'stock in transit' },
  /* No required type: goods received may accrue as a liability or sit in a
   * clearing asset, and both are defensible. Everything else still applies. */
  grni: { type: null, label: 'goods received not invoiced' },
} satisfies Record<string, AccountRoleSpec>;

export type AccountRole = keyof typeof ACCOUNT_ROLES;

/**
 * Resolve one account id and refuse everything unsuitable, by name.
 *
 * A generic "invalid account" would leave a bookkeeper guessing which of five
 * reasons applied, so each says what is actually wrong with the choice.
 */
export async function assertAccountForRole(
  db: InventoryExecutor,
  actor: InventoryActor,
  role: AccountRole,
  accountId: string | null | undefined,
  field: string,
): Promise<void> {
  if (!accountId) return;
  const spec = ACCOUNT_ROLES[role];

  const account = await db
    .selectFrom('accounts')
    .select([
      'id', 'account_code', 'account_name', 'account_type', 'cash_classification',
      'is_postable', 'active', 'blocked', 'archived',
    ])
    .where('organization_id', '=', actor.organizationId)
    /* Company scope in the QUERY, not merely in a later check: an account from
     * another company must be invisible, not visible-and-refused. */
    .where('company_id', '=', actor.companyId)
    .where('id', '=', accountId)
    .executeTakeFirst();

  if (!account) {
    throw errors.validation(
      `The ${spec.label} account does not exist in these books.`,
      { fieldErrors: { [field]: 'Choose an account from this company’s chart of accounts.' } },
    );
  }

  if (spec.type && account.account_type !== spec.type) {
    throw errors.validation(
      `${account.account_code} (${account.account_name}) is ${account.account_type}, and the `
      + `${spec.label} account must be ${spec.type}. Mapping it here would post inventory into a `
      + 'part of the statements it does not belong in.',
      { fieldErrors: { [field]: `Choose an ${spec.type} account.` } },
    );
  }

  /*
   * Never a bank. Every role here is stock, its cost or its revenue; none of
   * them is cash, and a cash-classified account would put stock movements into
   * the cash-flow statement.
   */
  if (account.cash_classification && account.cash_classification !== 'none') {
    throw errors.validation(
      `${account.account_code} (${account.account_name}) is a cash or bank account, which cannot be `
      + `the ${spec.label} account. Stock is not money.`,
      { fieldErrors: { [field]: 'Choose an account that is not cash or bank.' } },
    );
  }

  const children = await db
    .selectFrom('accounts')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('parent_account_id', '=', accountId)
    .executeTakeFirst();

  const verdict = assessPostingAccount(
    {
      archived: account.archived,
      blocked: account.blocked,
      active: account.active,
      isPostable: account.is_postable,
    },
    Number(children?.n ?? '0') > 0,
  );
  if (!verdict.eligible) {
    throw errors.validation(
      `${account.account_code} (${account.account_name}) cannot be the ${spec.label} account. `
      + verdict.message,
      { fieldErrors: { [field]: verdict.message ?? 'Choose a postable account.' } },
    );
  }
}

/* ── Tax code eligibility ──────────────────────────────────────────────────── */

/**
 * An item's tax codes are DEFAULTS a form copies onto a line. The invoice and
 * bill services still resolve and validate tax themselves at posting, so
 * nothing here is trusted later — but a default that faces the wrong way would
 * quietly propose reclaiming input tax on a sale, so direction is checked now.
 */
export async function assertTaxCodeForDirection(
  db: InventoryExecutor,
  actor: InventoryActor,
  taxCodeId: string | null | undefined,
  direction: 'sales' | 'purchase',
  field: string,
): Promise<void> {
  if (!taxCodeId) return;

  const code = await db
    .selectFrom('tax_codes')
    .select(['id', 'code', 'name', 'status', 'direction'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', taxCodeId)
    .executeTakeFirst();

  if (!code) {
    throw errors.validation(
      'That tax code does not exist in these books.',
      { fieldErrors: { [field]: 'Choose a tax code from this company.' } },
    );
  }
  if (code.status !== 'active') {
    throw errors.validation(
      `Tax code ${code.code} is ${code.status} and cannot be a default.`,
      { fieldErrors: { [field]: 'Choose an active tax code.' } },
    );
  }

  /*
   * One code may face both ways — a business that charges 16% and reclaims 16%
   * is looking at the same tax — so `both` satisfies either side. What is
   * refused is a code that faces only the other way.
   */
  const faces = String(code.direction ?? 'both');
  if (faces !== 'both' && faces !== direction) {
    throw errors.validation(
      `Tax code ${code.code} (${code.name}) is a ${faces} code and cannot be the ${direction} `
      + 'default. A code that faces one way charges a different tax from the one that faces the other.',
      { fieldErrors: { [field]: `Choose a ${direction} tax code.` } },
    );
  }
}

/* ── Seeded units ──────────────────────────────────────────────────────────── */

/**
 * The canonical base units, exactly as the product has always defined them.
 *
 * Copied from `src/lib/inventorySeed.ts` rather than reinvented: a company that
 * has used Ledgora in the browser already knows these codes, and giving the
 * server a different list would make the same unit mean two things.
 *
 * They are seeded because an item requires a base unit, while the unit
 * MANAGEMENT screen is an Inventory feature — so a subscriber entitled to the
 * shared item catalogue but not to Inventory would otherwise have nothing to
 * choose and no way to create one.
 */
export const SEED_UNITS: ReadonlyArray<{
  code: string; name: string; symbol: string; category: string; decimalPlaces: number;
}> = [
  { code: 'EA', name: 'Each', symbol: 'ea', category: 'quantity', decimalPlaces: 0 },
  { code: 'BOX', name: 'Box', symbol: 'box', category: 'quantity', decimalPlaces: 0 },
  { code: 'KG', name: 'Kilogram', symbol: 'kg', category: 'weight', decimalPlaces: 3 },
  { code: 'G', name: 'Gram', symbol: 'g', category: 'weight', decimalPlaces: 0 },
  { code: 'L', name: 'Litre', symbol: 'L', category: 'volume', decimalPlaces: 3 },
  { code: 'M', name: 'Metre', symbol: 'm', category: 'length', decimalPlaces: 2 },
  { code: 'M2', name: 'Square metre', symbol: 'm²', category: 'area', decimalPlaces: 2 },
  { code: 'M3', name: 'Cubic metre', symbol: 'm³', category: 'volume', decimalPlaces: 2 },
  { code: 'HOUR', name: 'Hour', symbol: 'h', category: 'time', decimalPlaces: 2 },
];

/**
 * Give a company its base units if it has none.
 *
 * Idempotent by construction — it inserts only when the register is empty, and
 * the unique index on `lower(code)` settles a race between two callers. Safe to
 * call on every read.
 */
export async function ensureBaseUnits(
  db: Kysely<Database>,
  actor: InventoryActor,
): Promise<void> {
  const existing = await db
    .selectFrom('units_of_measure')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .executeTakeFirst();
  if (Number(existing?.n ?? '0') > 0) return;

  try {
    await db
      .insertInto('units_of_measure')
      .values(SEED_UNITS.map((unit) => ({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        code: unit.code,
        name: unit.name,
        symbol: unit.symbol,
        category: unit.category,
        decimal_places: unit.decimalPlaces,
        is_system: true,
        created_by: actor.userId,
        updated_by: actor.userId,
      })) as never)
      .execute();
  } catch {
    /* Another request seeded first. The register is populated either way, which
     * is all this function promises. */
  }
}

/* ── Shared helpers ────────────────────────────────────────────────────────── */

export const trimmed = (value: string | null | undefined): string => (value ?? '').trim();

/** An empty barcode is NO barcode: NULL keeps the partial unique index honest. */
export const nullIfBlank = (value: string | null | undefined): string | null => {
  const text = trimmed(value);
  return text.length ? text : null;
};

/**
 * A monetary default, as an exact decimal string or nothing at all.
 *
 * Parsed from text rather than a JSON number, for the same reason every other
 * money field in these books is: a float has already lost the third place by
 * the time it reaches here.
 */
export function decimalOrNull(
  value: string | null | undefined,
  field: string,
  label: string,
): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw errors.validation(
      `The ${label} must be a plain decimal amount, such as 12.500.`,
      { fieldErrors: { [field]: 'Enter an amount like 12.500 — no signs, spaces or exponents.' } },
    );
  }
  return text;
}

/**
 * Turn a unique-violation into the sentence a bookkeeper needs.
 *
 * Read-before-write cannot close this: two concurrent creates both find the
 * code free and both proceed. The unique index is what actually stops the
 * second, so this is the only place the duplicate is genuinely known.
 */
export function asDuplicate(cause: unknown, map: Record<string, string>): never {
  const message = String((cause as { message?: string })?.message ?? '');
  for (const [index, sentence] of Object.entries(map)) {
    if (message.includes(index)) throw errors.conflict(sentence);
  }
  throw cause as Error;
}
