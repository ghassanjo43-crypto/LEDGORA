/**
 * Translating between the server's journal entry and the journal screen's.
 *
 * ══ `reversed` has no browser equivalent, and that is the interesting part ═══
 *
 * The server has four statuses; the browser type has three. `reversed` is the
 * missing one, and how it maps decides whether the ledger reads correctly.
 *
 * When an entry is reversed, the server flips the ORIGINAL to `reversed` and
 * leaves its lines exactly as they were, then posts a mirrored entry. Both are
 * in the books, and both count — that is the rule the report engine is built
 * on. So a reversed entry maps to `posted`, carrying `reversalEntryId` so the
 * screen can say what happened to it.
 *
 * Mapping it to `void` would be the tempting alternative and it would be wrong:
 * the browser's `void` means "this never counted", the reversal figures would
 * then be shown against nothing, and the journal would disagree with every
 * statement produced from the same data.
 *
 * ══ Amounts become numbers HERE and nowhere earlier ══════════════════════════
 *
 * The server holds `numeric` and returns decimal strings. The journal screen's
 * type has held `number` since long before any of this, and changing it reaches
 * every register, ledger and statement view in the application. So the
 * conversion happens at this boundary, once, and is labelled: what the browser
 * shows is a rendering of an exact figure the server keeps. Nothing recomputes
 * a balance from these numbers — the totals come from the server too.
 */
import type { JournalEntry, JournalLine, JournalStatus } from '@/types/journal';
import type { Account } from '@/types';
import type {
  ServerJournal,
  ServerJournalInput,
  ServerJournalLineInput,
} from '@/services/api/accountingApi';
import type { JournalFormValues } from '@/lib/journalValidation';

/** A decimal string for display. Exact arithmetic stays on the server. */
function toDisplayNumber(decimal: string | null | undefined): number {
  const value = Number(decimal ?? '0');
  return Number.isFinite(value) ? value : 0;
}

/** A number from the form as a decimal string, without float notation. */
function toDecimalString(value: number | null | undefined): string {
  if (!value) return '0';
  /* `toFixed` rather than `String`, so 1e-7 never travels as "1e-7". */
  return Number(value).toFixed(6).replace(/\.?0+$/, '') || '0';
}

const STATUS: Record<ServerJournal['status'], JournalStatus> = {
  draft: 'draft',
  posted: 'posted',
  /* Still in the books and still counted — see the note above. */
  reversed: 'posted',
  voided: 'void',
};

/**
 * The journal screen's view of a server entry.
 *
 * `chart` supplies the account code and name snapshots. The server stores the
 * account id on the line and resolves the rest by join; the browser type keeps
 * a snapshot for historical display, so it is filled from the chart that was
 * hydrated alongside. An account missing from the chart renders as its id
 * rather than as an empty cell, because a line pointing at nothing visible is a
 * bug somebody needs to be able to see.
 */
export function toJournalEntry(server: ServerJournal, chart: readonly Account[]): JournalEntry {
  const byId = new Map(chart.map((account) => [account.id, account]));

  const lines: JournalLine[] = server.lines.map((line) => {
    const account = byId.get(line.accountId);
    return {
      id: line.id,
      journalEntryId: server.id,
      lineNumber: line.lineNumber,
      accountId: line.accountId,
      accountCode: account?.code ?? line.accountId,
      accountName: account?.name ?? 'Unknown account',
      description: line.memo,
      debit: toDisplayNumber(line.debit),
      credit: toDisplayNumber(line.credit),
      entityId: line.entityId ?? '',
      entityName: '',
      costCenter: line.costCenterId ?? '',
      project: line.projectId ?? '',
      taxCode: '',
      taxAmount: 0,
      memo: line.memo,
    };
  });

  const totalDebit = lines.reduce((sum, line) => sum + line.debit, 0);
  const totalCredit = lines.reduce((sum, line) => sum + line.credit, 0);

  return {
    id: server.id,
    /* The SERVER allocates this. Nothing in the browser may mint one. */
    entryNumber: server.journalNumber,
    entryDate: server.transactionDate,
    reference: server.reference,
    description: server.description,
    status: STATUS[server.status],
    transactionType: server.journalType === 'general' ? '' : server.journalType,
    currency: server.transactionCurrency,
    exchangeRate: toDisplayNumber(server.exchangeRate) || 1,
    totalDebit,
    totalCredit,
    difference: totalDebit - totalCredit,
    notes: server.notes,
    reversalReference: server.reversalEntryId ?? '',
    lines,
    createdAt: '',
    createdBy: '',
    updatedAt: '',
    updatedBy: '',
    postedAt: server.postedAt ?? '',
    postedBy: '',
    approvedBy: '',
    voidedAt: server.status === 'voided' ? (server.postedAt ?? '') : '',
    voidedBy: '',
    originalEntryId: server.originalEntryId ?? '',
    reversalEntryId: server.reversalEntryId ?? '',
    version: server.version,
    ...(server.replacementEntryId ? { replacementEntryId: server.replacementEntryId } : {}),
    ...(server.sourceType ? { sourceModule: server.sourceType } : {}),
    ...(server.sourceId ? { sourceDocumentId: server.sourceId } : {}),
  };
}

/**
 * A journal form as the server wants it.
 *
 * Currency is deliberately NOT sent. An ordinary transaction is denominated in
 * the company's own currency at par, resolved server-side inside the write
 * transaction; sending a value that disagrees is refused rather than applied,
 * so the safest contract is to omit it entirely.
 */
export function toServerJournalInput(values: JournalFormValues): ServerJournalInput {
  const lines: ServerJournalLineInput[] = values.lines
    .filter((line) => line.accountId && (Number(line.debit) || Number(line.credit)))
    .map((line) => ({
      accountId: line.accountId,
      debit: Number(line.debit) ? toDecimalString(Number(line.debit)) : null,
      credit: Number(line.credit) ? toDecimalString(Number(line.credit)) : null,
      memo: line.description ?? '',
      entityId: line.entityId || null,
      projectId: line.project || null,
      costCenterId: line.costCenter || null,
    }));

  return {
    transactionDate: values.entryDate,
    reference: values.reference ?? '',
    description: values.description ?? '',
    notes: values.notes ?? '',
    lines,
  };
}
