/**
 * Accounting periods — the lock that makes "the books are closed" mean
 * something.
 *
 * ══ Why the lock lives here and not in the UI ════════════════════════════════
 *
 * A closed period is a statement to auditors, tax authorities and lenders that
 * the figures for that month will not move again. Enforcing it in the browser
 * meant it held only for people using the browser: a direct API call, or the
 * same person with devtools open, went straight past it. Every posting path in
 * `journalService` resolves the period through {@link assertPeriodAccepts} in
 * the SAME transaction as the write, so there is no window between the check
 * and the posting for a period to close.
 *
 * ══ Three states, deliberately not two ═══════════════════════════════════════
 *
 *   open        — post and amend freely
 *   soft_closed — posting refused; an authorised correction still permitted,
 *                 which is what a month under review actually needs
 *   locked      — nothing changes without an audited reopen
 *
 * A single "closed" flag would force a choice between blocking legitimate
 * review corrections and leaving the month open to ordinary posting.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import { writeAccountingAudit, type AccountingActor } from './audit.js';

type Executor = Kysely<Database> | Transaction<Database>;

export type PeriodStatus = 'open' | 'soft_closed' | 'locked';

export interface PeriodRecord {
  id: string;
  fiscalYear: number;
  periodNumber: number;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
  lockedAt: string | null;
  lockedBy: string | null;
}

export interface CreatePeriodInput {
  fiscalYear: number;
  periodNumber: number;
  startDate: string;
  endDate: string;
  status?: PeriodStatus;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRecord(row: any): PeriodRecord {
  return {
    id: row.id,
    fiscalYear: row.fiscal_year,
    periodNumber: row.period_number,
    startDate: typeof row.start_date === 'string' ? row.start_date : new Date(row.start_date).toISOString().slice(0, 10),
    endDate: typeof row.end_date === 'string' ? row.end_date : new Date(row.end_date).toISOString().slice(0, 10),
    status: row.status,
    lockedAt: row.locked_at ? new Date(row.locked_at).toISOString() : null,
    lockedBy: row.locked_by,
  };
}

export async function listPeriods(db: Executor, actor: AccountingActor): Promise<PeriodRecord[]> {
  const rows = await db
    .selectFrom('accounting_periods')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .orderBy('fiscal_year')
    .orderBy('period_number')
    .execute();
  return rows.map(toRecord);
}

export async function getPeriod(db: Executor, actor: AccountingActor, periodId: string): Promise<PeriodRecord> {
  const row = await db
    .selectFrom('accounting_periods')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', periodId)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Accounting period');
  return toRecord(row);
}

/**
 * The period a date falls in, or `undefined` when none has been defined.
 *
 * An undefined period is NOT an error: an organization that has not set up a
 * calendar can still post. Refusing would make the accounting engine unusable
 * until somebody configured twelve months, and there is nothing to protect yet.
 */
export async function findPeriodForDate(
  db: Executor,
  organizationId: string,
  companyId: string,
  date: string,
): Promise<PeriodRecord | undefined> {
  const row = await db
    .selectFrom('accounting_periods')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('company_id', '=', companyId)
    .where('start_date', '<=', date)
    .where('end_date', '>=', date)
    .executeTakeFirst();
  return row ? toRecord(row) : undefined;
}

/**
 * May something be POSTED into the period covering this date?
 *
 * Called inside the posting transaction, never before it — see the note at the
 * top of this file about the gap between checking and writing.
 */
export async function assertPeriodAccepts(
  db: Executor,
  organizationId: string,
  companyId: string,
  date: string,
  intent: 'post' | 'amend',
): Promise<PeriodRecord | undefined> {
  const period = await findPeriodForDate(db, organizationId, companyId, date);
  if (!period) return undefined;

  if (period.status === 'locked') {
    throw errors.conflict(
      `Accounting period ${period.startDate} to ${period.endDate} is locked. Reopen the period before ${intent === 'post' ? 'posting into' : 'correcting'} it.`,
    );
  }
  if (period.status === 'soft_closed' && intent === 'post') {
    throw errors.conflict(
      `Accounting period ${period.startDate} to ${period.endDate} is closed for posting. Reopen it, or record the entry in an open period.`,
    );
  }
  return period;
}

/**
 * Refuse a range that overlaps an existing period for THIS COMPANY.
 *
 * Scoped to the company, not the subscriber: two companies keep their own
 * calendars, and an organization-wide check would let one company's January
 * block another company from ever opening its own January.
 */
async function assertNoOverlap(
  db: Executor,
  organizationId: string,
  companyId: string,
  startDate: string,
  endDate: string,
  excludeId?: string,
): Promise<void> {
  let query = db
    .selectFrom('accounting_periods')
    .select(['id', 'start_date', 'end_date'])
    .where('organization_id', '=', organizationId)
    .where('company_id', '=', companyId)
    // Two ranges overlap when each starts before the other ends.
    .where('start_date', '<=', endDate)
    .where('end_date', '>=', startDate);
  if (excludeId) query = query.where('id', '!=', excludeId);

  const clash = await query.executeTakeFirst();
  if (clash) {
    throw errors.conflict(
      `That range overlaps an existing accounting period. A date must belong to exactly one period, or a posting could land in two.`,
    );
  }
}

export async function createPeriod(
  db: Kysely<Database>,
  actor: AccountingActor,
  input: CreatePeriodInput,
): Promise<PeriodRecord> {
  if (!ISO_DATE.test(input.startDate) || !ISO_DATE.test(input.endDate)) {
    throw errors.validation('Period dates must be ISO dates (yyyy-mm-dd).');
  }
  if (input.endDate < input.startDate) {
    throw errors.validation('A period cannot end before it starts.');
  }

  return db.transaction().execute(async (trx) => {
    await assertNoOverlap(trx, actor.organizationId, actor.companyId, input.startDate, input.endDate);

    const duplicate = await trx
      .selectFrom('accounting_periods')
      .select('id')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('fiscal_year', '=', input.fiscalYear)
      .where('period_number', '=', input.periodNumber)
      .executeTakeFirst();
    if (duplicate) {
      throw errors.conflict(`Period ${input.periodNumber} of ${input.fiscalYear} already exists.`);
    }

    const row = await trx
      .insertInto('accounting_periods')
      .values({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        fiscal_year: input.fiscalYear,
        period_number: input.periodNumber,
        start_date: input.startDate,
        end_date: input.endDate,
        status: input.status ?? 'open',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAccountingAudit(trx, actor, {
      action: 'PERIOD_CREATED',
      recordType: 'accounting_period',
      recordId: row.id,
      detail: { fiscalYear: input.fiscalYear, periodNumber: input.periodNumber, startDate: input.startDate, endDate: input.endDate },
    });

    return toRecord(row);
  });
}

const STATUS_AUDIT = {
  open: 'PERIOD_REOPENED',
  soft_closed: 'PERIOD_SOFT_CLOSED',
  locked: 'PERIOD_LOCKED',
} as const;

/**
 * Move a period between states.
 *
 * Reopening is the one that matters: it is the act that makes closed figures
 * movable again, so it demands a reason and is audited with the state it came
 * from. Nothing here silently downgrades a lock.
 */
export async function setPeriodStatus(
  db: Kysely<Database>,
  actor: AccountingActor,
  periodId: string,
  status: PeriodStatus,
  reason = '',
): Promise<PeriodRecord> {
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('accounting_periods')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', periodId)
      .executeTakeFirst();
    if (!existing) throw errors.notFound('Accounting period');

    const reopening = existing.status === 'locked' && status !== 'locked';
    if (reopening && reason.trim().length < 5) {
      throw errors.validation(
        'Reopening a locked accounting period requires a reason, which is recorded permanently in the accounting audit trail.',
      );
    }

    const now = new Date();
    const row = await trx
      .updateTable('accounting_periods')
      .set({
        status,
        locked_at: status === 'locked' ? now : null,
        locked_by: status === 'locked' ? actor.userId : null,
        updated_at: now,
      })
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', periodId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAccountingAudit(trx, actor, {
      action: STATUS_AUDIT[status],
      recordType: 'accounting_period',
      recordId: periodId,
      reason: reason.trim(),
      detail: { from: existing.status, to: status },
    });

    return toRecord(row);
  });
}

export async function updatePeriod(
  db: Kysely<Database>,
  actor: AccountingActor,
  periodId: string,
  input: Partial<CreatePeriodInput> & { reason?: string },
): Promise<PeriodRecord> {
  if (input.status) {
    return setPeriodStatus(db, actor, periodId, input.status, input.reason ?? '');
  }

  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('accounting_periods')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', periodId)
      .executeTakeFirst();
    if (!existing) throw errors.notFound('Accounting period');
    if (existing.status === 'locked') {
      throw errors.conflict('A locked accounting period cannot be edited. Reopen it first.');
    }

    const startDate = input.startDate ?? toRecord(existing).startDate;
    const endDate = input.endDate ?? toRecord(existing).endDate;
    if (endDate < startDate) throw errors.validation('A period cannot end before it starts.');
    await assertNoOverlap(trx, actor.organizationId, actor.companyId, startDate, endDate, periodId);

    const row = await trx
      .updateTable('accounting_periods')
      .set({
        fiscal_year: input.fiscalYear ?? existing.fiscal_year,
        period_number: input.periodNumber ?? existing.period_number,
        start_date: startDate,
        end_date: endDate,
        updated_at: new Date(),
      })
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', periodId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAccountingAudit(trx, actor, {
      action: 'PERIOD_UPDATED',
      recordType: 'accounting_period',
      recordId: periodId,
      detail: { startDate, endDate },
    });

    return toRecord(row);
  });
}
