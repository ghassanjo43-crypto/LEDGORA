/**
 * The rules every piece of fixed-asset configuration shares.
 *
 * ══ Why account eligibility is decided here and never by the client ══════════
 *
 * A category names the accounts an asset's depreciation will one day post
 * through. The client offers a picker, but the picker is a convenience: what
 * makes a mapping legal is the account's own type, its NORMAL BALANCE, its
 * posting flags and the company it belongs to — and all four live in the
 * database. A caller that sent an account id it liked would otherwise be
 * choosing where depreciation lands.
 *
 * ══ The contra-asset rule, and why it is not a guess ═════════════════════════
 *
 * Accumulated depreciation is a CONTRA-ASSET: it sits in the asset section and
 * carries a credit balance, so the balance sheet shows cost less depreciation
 * rather than an expense that never closes.
 *
 * This chart of accounts represents that exactly, and with controlled columns
 * rather than a naming convention: `account_type` is CHECK-constrained to the
 * ledger's five, and `normal_balance` is NOT NULL and CHECK-constrained to
 * ('debit','credit'). The shipped chart already models "Accumulated
 * depreciation — PP&E" as an ASSET whose normal balance is a CREDIT. So the
 * rule below is the model's own, read off two constrained columns:
 *
 *   asset cost               → asset,   normal balance DEBIT
 *   accumulated depreciation → asset,   normal balance CREDIT   (contra-asset)
 *   depreciation expense     → expense, normal balance DEBIT
 *
 * What the chart does NOT have is a controlled non-current marker —
 * `ifrs_category` and `ifrs_subcategory` are free text, and a classification
 * that turns on spelling is not one to refuse a bookkeeper's account over. So
 * "non-current" is left to the chart's structure and is not asserted from a
 * string comparison.
 *
 * ══ Why cash is refused for every role ═══════════════════════════════════════
 *
 * None of these three is ever a bank. A cash-classified account here would put
 * an asset's cost, or its depreciation, into the cash-flow statement — and
 * depreciation is the textbook non-cash charge.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import { assessPostingAccount } from '../accounting/accountEligibility.js';
import { monetaryDecimalsFor, renderAmount } from '../accounting/currencyPrecision.js';

export type FixedAssetExecutor = Kysely<Database> | Transaction<Database>;

export interface FixedAssetActor {
  organizationId: string;
  /** The server-resolved company. Never taken from a request body. */
  companyId: string;
  userId: string;
  name: string;
  requestId?: string;
}

export type FixedAssetSubject = 'category' | 'asset';

/* ── The vocabulary F1 can evaluate ────────────────────────────────────────── */

/**
 * The depreciation methods this slice supports, and only these.
 *
 * `straight_line` is complete: the charge is (cost − residual) ÷ life in
 * months, and the convention is settled (see below). `none` is not a formula at
 * all — land does not depreciate — so there is nothing about it to get wrong.
 */
export const DEPRECIATION_METHODS = ['straight_line', 'none'] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

/**
 * Methods a caller may name and this slice refuses BY NAME.
 *
 * A generic "unsupported method" would leave somebody guessing whether they had
 * mistyped it or whether it genuinely is not here. Each of these is a real
 * method that a real business uses, and the refusal says which piece of it this
 * product has not established.
 */
export const REFUSED_METHODS: Readonly<Record<string, string>> = {
  reducing_balance:
    'Reducing balance is not available yet. Its annual rate exists only on an individual asset — '
    + 'an asset category has no rate to state — so a category typed "reducing balance" could not '
    + 'express the policy it claims. It arrives with the depreciation engine that needs it.',
  declining_balance:
    'Declining balance is not available yet. See reducing balance: this product holds no rate on a '
    + 'category, so the policy cannot be stated here.',
  double_declining_balance:
    'Double declining balance is not available yet. This product implements no declining method and '
    + 'no switch-to-straight-line rule, and inventing either would decide a depreciation policy that '
    + 'is the business’s to decide.',
  units_of_production:
    'Units of production is not available yet. It charges depreciation against units consumed in a '
    + 'period, and this product has no source of usage — no meter, no output record, nothing that '
    + 'could say how much an asset was used. A schedule with no usage behind it would be invented.',
  sum_of_years_digits:
    'Sum of the years’ digits is not available yet. It is not implemented anywhere in this product, '
    + 'and adding a formula here would be choosing an accounting policy rather than recording one.',
  annuity:
    'Annuity depreciation is not available yet. It is not implemented anywhere in this product.',
  custom:
    'A custom depreciation method is not available. A method is a formula, a convention and the '
    + 'inputs to state both; none of the three can be supplied through this API.',
};

/**
 * The one established proration convention.
 *
 * `monthsInclusive(from, to)` in the product's own calculations is the whole of
 * it: whole calendar months, the start month counted in full, the end month
 * counted in full. There is no daily, half-month, mid-quarter or actual-days
 * code anywhere, so there is exactly one value a category may carry.
 */
export const DEPRECIATION_CONVENTIONS = ['full_month'] as const;
export type DepreciationConvention = (typeof DEPRECIATION_CONVENTIONS)[number];

export const REFUSED_CONVENTIONS: Readonly<Record<string, string>> = {
  half_month:
    'The half-month convention is not available. This product prorates in whole calendar months, '
    + 'counting the month depreciation starts in full, and implements no half-period rule.',
  half_year:
    'The half-year convention is not available. This product prorates in whole calendar months and '
    + 'implements no half-period rule.',
  mid_quarter:
    'The mid-quarter convention is not available. This product prorates in whole calendar months.',
  daily:
    'Daily proration is not available. This product prorates in whole calendar months, and a daily '
    + 'basis would produce a different charge for the same asset in the same month.',
  actual_days:
    'Actual-days proration is not available. This product prorates in whole calendar months.',
};

/** Useful life is measured in MONTHS everywhere in this product. */
export const USEFUL_LIFE_UNIT = 'months';
/** A sanity bound, not an accounting policy: 1 month to 100 years. */
export const MAX_USEFUL_LIFE_MONTHS = 1200;

/* ── Audit ─────────────────────────────────────────────────────────────────── */

export interface FixedAssetAuditInput {
  subjectType: FixedAssetSubject;
  subjectId?: string | null;
  action: string;
  previousVersion?: number | null;
  resultingVersion?: number | null;
  reason?: string;
  detail?: Record<string, unknown>;
}

/**
 * Every writer passes the TRANSACTION, never the pool.
 *
 * If the audit insert fails, the change it describes must fail with it. An
 * audit written on a separate connection would survive a rolled-back write and
 * claim something happened that did not, which is worse than no audit at all.
 */
export async function writeFixedAssetAudit(
  trx: FixedAssetExecutor,
  actor: FixedAssetActor,
  input: FixedAssetAuditInput,
): Promise<void> {
  await trx
    .insertInto('fixed_asset_audit_events')
    .values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      subject_type: input.subjectType,
      subject_id: input.subjectId ?? null,
      action: input.action,
      previous_version: input.previousVersion ?? null,
      resulting_version: input.resultingVersion ?? null,
      reason: input.reason ?? '',
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

interface AccountRoleSpec {
  /** The ledger type this role demands. */
  type: 'asset' | 'expense';
  /** The normal balance this role demands. A contra-asset is the credit one. */
  normalBalance: 'debit' | 'credit';
  label: string;
  /** Said when the normal balance is wrong, because the reason is not obvious. */
  balanceReason: string;
}

export const ACCOUNT_ROLES = {
  assetCost: {
    type: 'asset',
    normalBalance: 'debit',
    label: 'fixed asset cost',
    balanceReason:
      'An asset held at cost carries a debit balance. An asset account with a credit normal balance '
      + 'is a contra-asset — that is where accumulated depreciation goes, not cost.',
  },
  accumulatedDepreciation: {
    type: 'asset',
    normalBalance: 'credit',
    label: 'accumulated depreciation',
    balanceReason:
      'Accumulated depreciation is a CONTRA-ASSET: an asset-type account whose normal balance is a '
      + 'credit, so the balance sheet can show cost less depreciation. An ordinary debit-balance '
      + 'asset account here would add depreciation to the asset instead of subtracting it, and an '
      + 'expense account would charge the same cost to profit twice.',
  },
  depreciationExpense: {
    type: 'expense',
    normalBalance: 'debit',
    label: 'depreciation expense',
    balanceReason: 'An expense carries a debit balance.',
  },
} satisfies Record<string, AccountRoleSpec>;

export type FixedAssetAccountRole = keyof typeof ACCOUNT_ROLES;

/**
 * Resolve one account id and refuse everything unsuitable, by reason.
 *
 * A generic "invalid account" would leave a bookkeeper guessing which of six
 * reasons applied, so each says what is actually wrong with the choice.
 */
export async function assertAccountForRole(
  db: FixedAssetExecutor,
  actor: FixedAssetActor,
  role: FixedAssetAccountRole,
  accountId: string | null | undefined,
  field: string,
): Promise<void> {
  if (!accountId) return;
  const spec: AccountRoleSpec = ACCOUNT_ROLES[role];

  const account = await db
    .selectFrom('accounts')
    .select([
      'id', 'account_code', 'account_name', 'account_type', 'normal_balance',
      'cash_classification', 'is_postable', 'active', 'blocked', 'archived',
    ])
    /* Company scope in the QUERY, not merely in a later check: an account from
     * another company must be invisible, not visible-and-refused. */
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', accountId)
    .executeTakeFirst();

  if (!account) {
    throw errors.validation(
      `The ${spec.label} account does not exist in these books.`,
      { fieldErrors: { [field]: 'Choose an account from this company’s chart of accounts.' } },
    );
  }

  if (account.account_type !== spec.type) {
    throw errors.validation(
      `${account.account_code} (${account.account_name}) is ${account.account_type}, and the `
      + `${spec.label} account must be ${spec.type}. Mapping it here would post fixed assets into a `
      + 'part of the statements they do not belong in.',
      { fieldErrors: { [field]: `Choose an ${spec.type} account.` } },
    );
  }

  if (account.normal_balance !== spec.normalBalance) {
    throw errors.validation(
      `${account.account_code} (${account.account_name}) has a ${account.normal_balance} normal `
      + `balance, and the ${spec.label} account must have a ${spec.normalBalance} one. `
      + spec.balanceReason,
      {
        fieldErrors: {
          [field]: `Choose an account whose normal balance is a ${spec.normalBalance}.`,
        },
      },
    );
  }

  /* Never a bank. Depreciation is the textbook non-cash charge, and an asset's
   * cost is not money either. */
  if (account.cash_classification && account.cash_classification !== 'none') {
    throw errors.validation(
      `${account.account_code} (${account.account_name}) is a cash or bank account, which cannot be `
      + `the ${spec.label} account. A fixed asset is not money, and depreciation moves none.`,
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

/* ── Currency precision ────────────────────────────────────────────────────── */

/**
 * How many decimals this tenant's amounts are written to.
 *
 * Read from `organizations.base_currency`, which is the ONE authoritative
 * source — the same one `journalService` uses. A residual value stored in
 * `numeric(28,10)` comes back from PostgreSQL as `99.9900000000`, and a form
 * that round-trips that is a form that shows a bookkeeper ten decimal places
 * for a two-decimal currency.
 */
export async function monetaryDecimals(
  db: FixedAssetExecutor,
  actor: FixedAssetActor,
): Promise<number> {
  const row = await db
    .selectFrom('organizations')
    .select('base_currency')
    .where('id', '=', actor.organizationId)
    .executeTakeFirst();
  return monetaryDecimalsFor(row?.base_currency);
}

/**
 * A stored figure at the tenant's own precision: JOD 1250.125, USD 99.99,
 * JPY 15000.
 *
 * Never rounds past a non-zero digit — posting refuses an over-precise amount,
 * so one should not exist, and showing it is the honest failure if it does.
 */
export function renderMonetary(value: unknown, decimals: number): string {
  return renderAmount(value, decimals);
}

/* ── Shared helpers ────────────────────────────────────────────────────────── */

export const trimmed = (value: string | null | undefined): string => (value ?? '').trim();

const DECIMAL = /^\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A non-negative decimal amount, exactly as typed.
 *
 * Parsed from TEXT rather than a JSON number, for the same reason every other
 * money field in these books is: a float has already lost the third place by
 * the time it reaches here, and a JOD residual value has three.
 */
export function decimalAmount(
  value: string | number | null | undefined,
  field: string,
  label: string,
): string {
  if (value === undefined || value === null || String(value).trim() === '') return '0';
  const text = String(value).trim();
  if (!DECIMAL.test(text)) {
    throw errors.validation(
      `The ${label} must be a plain decimal amount, such as 12.500.`,
      { fieldErrors: { [field]: 'Enter an amount like 12.500 — no signs, spaces or exponents.' } },
    );
  }
  /* `numeric(28,10)` is the column. More than ten places would be silently
   * rounded by PostgreSQL, and a residual value nobody typed is worse than a
   * refusal. */
  const [, fraction = ''] = text.split('.');
  if (fraction.length > 10) {
    throw errors.validation(
      `The ${label} carries more than ten decimal places.`,
      { fieldErrors: { [field]: 'Enter an amount with at most ten decimal places.' } },
    );
  }
  return text;
}

/** A calendar date, or a refusal. Never a timestamp, never a timezone. */
export function calendarDateInput(
  value: string | null | undefined,
  field: string,
  label: string,
  { required }: { required: boolean },
): string | null {
  const text = trimmed(value);
  if (!text) {
    if (required) {
      throw errors.validation(`The ${label} is required.`, {
        fieldErrors: { [field]: 'Choose a date.' },
      });
    }
    return null;
  }
  if (!ISO_DATE.test(text)) {
    throw errors.validation(`The ${label} must be a calendar date, such as 2026-03-01.`, {
      fieldErrors: { [field]: 'Enter a date as yyyy-mm-dd.' },
    });
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

/* ── What F1 deliberately does not do ──────────────────────────────────────── */

/**
 * The refusals, in one place, so every route and every screen says the same
 * thing about the same missing workflow.
 */
export const CAPITALIZATION_UNSUPPORTED =
  'Capitalisation is not available yet. Recording an asset\'s cost creates a journal — Dr the asset, '
  + 'Cr whatever paid for it — and this slice posts nothing. The register names the asset and the '
  + 'policy that will apply to it; the cost arrives with the posting that puts it in the books.';

export const DEPRECIATION_UNSUPPORTED =
  'Depreciation is not available yet. No schedule is generated, no run is stored and no accumulated '
  + 'depreciation is posted. This slice records the POLICY — method, useful life, residual value, '
  + 'convention and the accounts a charge will use — and nothing that has been charged.';

export const DISPOSAL_UNSUPPORTED =
  'Disposal, sale, write-off and retirement are not available yet. Each derecognises a cost and an '
  + 'accumulated depreciation this slice has never posted, so there is nothing here to remove.';

export const IMPAIRMENT_UNSUPPORTED =
  'Impairment and impairment reversal are not available yet. Both measure a carrying amount against '
  + 'a recoverable one, and this slice holds no carrying amount.';

export const REVALUATION_UNSUPPORTED =
  'Revaluation is not available yet. It restates a carrying amount this slice does not hold, and it '
  + 'needs a revaluation surplus and loss account whose eligibility no posting has settled.';

export const TRANSFER_UNSUPPORTED =
  'Asset transfers are not available yet. A transfer between companies moves a carrying amount, and '
  + 'this slice holds none.';

export const BILL_CAPITALIZATION_UNSUPPORTED =
  'A supplier bill cannot create or capitalise a fixed asset yet. What a capital purchase costs, '
  + 'when it is capitalised, how input tax is treated, what happens on a partial capitalisation and '
  + 'what a reversal must undo are all decisions this slice has not made. Register the asset here, '
  + 'and record the bill as it stands.';

export const COMPONENT_ACCOUNTING_UNSUPPORTED =
  'Component accounting is not available. This product has never held a parent-and-part relationship '
  + 'between assets, so a component would be an ordinary asset record wearing a name that implied '
  + 'depreciation it will not get. Register significant components as their own assets.';

export const MULTIPLE_BOOKS_UNSUPPORTED =
  'Tax depreciation and multiple accounting books are not available. This product keeps one set of '
  + 'books, and a second basis would need its own methods, lives, conventions and journals — none of '
  + 'which exist here.';

export const ATTACHMENTS_UNSUPPORTED =
  'Attaching documents to an asset is not available yet. This server has no document store for '
  + 'business records — the only files it keeps are platform payment proofs — so an attachment would '
  + 'be a link to something nothing is holding.';

export const FOREIGN_CURRENCY_UNSUPPORTED =
  'A fixed asset in a foreign currency is not available yet. An asset\'s cost is translated once, at '
  + 'a rate on a date, and never retranslated; this slice records no cost and no rate.';

/**
 * How many server-authoritative accounting facts exist for one asset.
 *
 * ══ The seam, written before anything can meet it ════════════════════════════
 *
 * F1 posts nothing, so this is structurally zero — every table it would count
 * belongs to a slice that has not been built. It exists anyway, and the freeze
 * rules in `assetService` are written and tested against it NOW, so the guard
 * is in place before the first capitalisation can reach it rather than being
 * remembered afterwards.
 *
 * When F2 adds asset transactions, this reads them and every freeze below
 * starts refusing for real without a line of those rules changing.
 */
export async function countAccountingActivityFor(
  _db: FixedAssetExecutor,
  _actor: FixedAssetActor,
  _assetId: string,
): Promise<number> {
  return 0;
}
