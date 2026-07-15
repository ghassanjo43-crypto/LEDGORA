import type { Account } from '@/types';
import type {
  JournalApprovalStatus,
  JournalApprovalStep,
  JournalEntry,
} from '@/types/journal';
import { getPostingErrors } from '@/lib/journalValidation';

/** Derived row status for the dense table (never mutates the entry). */
export type JournalDisplayStatus = 'posted' | 'pending' | 'draft' | 'void';

/** Tabs above the table. */
export type JournalTab = 'all' | 'draft' | 'pending' | 'posted';

/** A draft that passes all posting checks is "ready" (pending approval). */
export function isPendingApproval(entry: JournalEntry, accountsById: Map<string, Account>): boolean {
  return entry.status === 'draft' && getPostingErrors(entry, accountsById).length === 0;
}

export function journalDisplayStatus(entry: JournalEntry, accountsById: Map<string, Account>): JournalDisplayStatus {
  if (entry.status === 'posted') return 'posted';
  if (entry.status === 'void') return 'void';
  return isPendingApproval(entry, accountsById) ? 'pending' : 'draft';
}

export function deriveApprovalStatus(entry: JournalEntry, accountsById: Map<string, Account>): JournalApprovalStatus {
  if (entry.approvalStatus) return entry.approvalStatus;
  if (entry.status === 'posted') return 'approved';
  if (entry.status === 'void') return 'rejected';
  return isPendingApproval(entry, accountsById) ? 'pending_approval' : 'pending_review';
}

/** Filter entries for a tab. Draft/Pending partition the drafts cleanly. */
export function filterByTab(
  entries: JournalEntry[],
  tab: JournalTab,
  accountsById: Map<string, Account>,
): JournalEntry[] {
  switch (tab) {
    case 'draft':
      return entries.filter((e) => e.status === 'draft' && !isPendingApproval(e, accountsById));
    case 'pending':
      return entries.filter((e) => isPendingApproval(e, accountsById));
    case 'posted':
      return entries.filter((e) => e.status === 'posted');
    default:
      return entries;
  }
}

export interface TabCounts {
  all: number;
  draft: number;
  pending: number;
  posted: number;
}

export function tabCounts(entries: JournalEntry[], accountsById: Map<string, Account>): TabCounts {
  let draft = 0;
  let pending = 0;
  let posted = 0;
  for (const e of entries) {
    if (e.status === 'posted') posted += 1;
    else if (e.status === 'draft') {
      if (isPendingApproval(e, accountsById)) pending += 1;
      else draft += 1;
    }
  }
  return { all: entries.length, draft, pending, posted };
}

export interface JournalSummary {
  totalDebit: number;
  totalCredit: number;
  difference: number;
  draftCount: number;
  draftTotal: number;
  postedCount: number;
  postedTotal: number;
}

/** Header KPI figures. Debit/credit totals reflect POSTED entries. */
export function journalSummary(entries: JournalEntry[]): JournalSummary {
  let totalDebit = 0;
  let totalCredit = 0;
  let draftCount = 0;
  let draftTotal = 0;
  let postedCount = 0;
  let postedTotal = 0;
  for (const e of entries) {
    if (e.status === 'posted') {
      totalDebit += e.totalDebit;
      totalCredit += e.totalCredit;
      postedCount += 1;
      postedTotal += e.totalDebit;
    } else if (e.status === 'draft') {
      draftCount += 1;
      draftTotal += e.totalDebit;
    }
  }
  const r = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
  return {
    totalDebit: r(totalDebit),
    totalCredit: r(totalCredit),
    difference: r(totalDebit - totalCredit),
    draftCount,
    draftTotal: r(draftTotal),
    postedCount,
    postedTotal: r(postedTotal),
  };
}

export interface Pageder<T> {
  items: T[];
  total: number;
  totalPages: number;
  from: number;
  to: number;
  page: number;
}

/** Slice a list for pagination (1-based page). */
export function paginate<T>(items: T[], page: number, perPage: number): Pageder<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const clamped = Math.min(Math.max(1, page), totalPages);
  const start = (clamped - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return {
    items: slice,
    total,
    totalPages,
    page: clamped,
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + perPage, total),
  };
}

/** Compact page-number list with ellipses, e.g. [1,2,3,'…',6]. */
export function pageNumbers(current: number, totalPages: number): (number | '…')[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages: (number | '…')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(totalPages - 1, current + 1);
  if (start > 2) pages.push('…');
  for (let i = start; i <= end; i += 1) pages.push(i);
  if (end < totalPages - 1) pages.push('…');
  pages.push(totalPages);
  return pages;
}

/** Vertical approval workflow steps derived from the entry's audit fields. */
export function buildWorkflowSteps(entry: JournalEntry): JournalApprovalStep[] {
  const done = entry.status === 'posted' || entry.status === 'void';
  const posted = entry.status === 'posted';
  return [
    {
      id: 'created',
      stage: 'created',
      status: 'complete',
      assignedTo: entry.createdBy || 'System',
      completedAt: entry.createdAt,
    },
    {
      id: 'review',
      stage: 'review',
      status: done ? 'complete' : 'pending',
      assignedTo: entry.updatedBy || undefined,
      completedAt: done ? entry.updatedAt : undefined,
    },
    {
      id: 'approval',
      stage: 'approval',
      status: posted ? 'complete' : entry.status === 'void' ? 'rejected' : 'pending',
      assignedTo: entry.approvedBy || 'Approver',
      completedAt: posted ? entry.postedAt : undefined,
    },
    {
      id: 'posting',
      stage: 'posting',
      status: posted ? 'complete' : 'pending',
      assignedTo: entry.postedBy || undefined,
      completedAt: posted ? entry.postedAt : undefined,
    },
  ];
}
