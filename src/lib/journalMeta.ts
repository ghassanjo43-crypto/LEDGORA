import type { JournalEntry } from '@/types/journal';
import type { BadgeTone } from '@/data/ifrsOptions';

/**
 * PRESENTATION-ONLY helpers for the General Journal. These derive display
 * metadata from fields that already exist on a {@link JournalEntry} — they do
 * NOT change the data model, posting logic or validation.
 */

export interface EntryTypeInfo {
  label: string;
  tone: BadgeTone;
}

/** Selectable transaction types + their badge tone. '' means auto-classify. */
export const TRANSACTION_TYPES: { label: string; tone: BadgeTone }[] = [
  { label: 'Manual Journal', tone: 'slate' },
  { label: 'Sales Invoice', tone: 'blue' },
  { label: 'Cash Sale', tone: 'blue' },
  { label: 'Customer Receipt', tone: 'green' },
  { label: 'Supplier Bill', tone: 'amber' },
  { label: 'Supplier Payment', tone: 'amber' },
  { label: 'Bank Entry', tone: 'cyan' },
  { label: 'Bank / Loan', tone: 'cyan' },
  { label: 'Depreciation', tone: 'violet' },
  { label: 'Accrual', tone: 'teal' },
  { label: 'Tax', tone: 'rose' },
  { label: 'Opening / Capital', tone: 'indigo' },
];

const TYPE_TONE = new Map(TRANSACTION_TYPES.map((t) => [t.label, t.tone]));

/** Options for the drawer's transaction-type selector. */
export const TRANSACTION_TYPE_OPTIONS = [
  { value: '', label: 'Auto (classify from reference)' },
  ...TRANSACTION_TYPES.map((t) => ({ value: t.label, label: t.label })),
];

/**
 * Resolve an entry's display type: an explicit `transactionType` wins;
 * otherwise fall back to heuristic classification.
 */
export function resolveEntryType(entry: JournalEntry): EntryTypeInfo {
  const explicit = entry.transactionType.trim();
  if (explicit) return { label: explicit, tone: TYPE_TONE.get(explicit) ?? 'slate' };
  return classifyEntry(entry);
}

/**
 * Classify an entry into a human transaction type from its reference / wording.
 * Purely a display hint; user-created entries without a recognised reference
 * fall back to "Manual Journal".
 */
export function classifyEntry(entry: JournalEntry): EntryTypeInfo {
  const ref = entry.reference.trim().toUpperCase();
  const desc = entry.description.toLowerCase();

  const byPrefix: { test: RegExp; info: EntryTypeInfo }[] = [
    { test: /^INV/u, info: { label: 'Sales Invoice', tone: 'blue' } },
    { test: /^CASH/u, info: { label: 'Cash Sale', tone: 'blue' } },
    { test: /^BILL/u, info: { label: 'Supplier Bill', tone: 'amber' } },
    { test: /^PAY/u, info: { label: 'Supplier Payment', tone: 'amber' } },
    { test: /^REC/u, info: { label: 'Customer Receipt', tone: 'green' } },
    { test: /^DEP/u, info: { label: 'Depreciation', tone: 'violet' } },
    { test: /^CAP/u, info: { label: 'Opening / Capital', tone: 'indigo' } },
    { test: /^LOAN/u, info: { label: 'Bank / Loan', tone: 'cyan' } },
    { test: /^BANK/u, info: { label: 'Bank Entry', tone: 'cyan' } },
    { test: /^(VAT|TAX)/u, info: { label: 'Tax', tone: 'rose' } },
    { test: /^(ACR|ACC)/u, info: { label: 'Accrual', tone: 'teal' } },
  ];
  for (const { test, info } of byPrefix) {
    if (test.test(ref)) return info;
  }

  // Fall back to a couple of description keywords, then a neutral default.
  if (desc.includes('depreciation')) return { label: 'Depreciation', tone: 'violet' };
  if (desc.includes('capital') || desc.includes('opening balance')) {
    return { label: 'Opening / Capital', tone: 'indigo' };
  }
  if (desc.includes('accrual')) return { label: 'Accrual', tone: 'teal' };
  return { label: 'Manual Journal', tone: 'slate' };
}

export interface AuditEvent {
  action: string;
  at: string;
  actor: string;
}

/**
 * Build an audit timeline for an entry from its existing timestamps and actor
 * fields. No new persistence — everything shown is already on the record.
 */
export function buildAuditTrail(entry: JournalEntry): AuditEvent[] {
  const events: AuditEvent[] = [
    { action: 'Created', at: entry.createdAt, actor: entry.createdBy || 'System' },
  ];

  const edited = entry.updatedAt && entry.updatedAt !== entry.createdAt;
  if (edited && entry.status === 'draft') {
    events.push({ action: 'Last edited', at: entry.updatedAt, actor: entry.createdBy || 'System' });
  }
  if (entry.status === 'posted' && entry.postedAt) {
    events.push({
      action: 'Posted',
      at: entry.postedAt,
      actor: entry.approvedBy || entry.createdBy || 'System',
    });
  }
  if (entry.status === 'void') {
    events.push({
      action: `Reversed${entry.reversalReference ? ` · ${entry.reversalReference}` : ''}`,
      at: entry.updatedAt,
      actor: entry.approvedBy || entry.createdBy || 'System',
    });
  }

  return events.sort((a, b) => a.at.localeCompare(b.at));
}
