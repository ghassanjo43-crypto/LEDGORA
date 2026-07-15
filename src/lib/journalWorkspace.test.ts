import { describe, it, expect } from 'vitest';
import type { Account } from '@/types';
import type { JournalEntry, JournalLine, JournalStatus } from '@/types/journal';
import {
  journalDisplayStatus,
  filterByTab,
  tabCounts,
  journalSummary,
  paginate,
  pageNumbers,
  buildWorkflowSteps,
} from './journalWorkspace';

function acc(id: string, normalBalance: Account['normalBalance']): Account {
  return {
    id, code: id, name: id, type: 'ASSET', parentId: null, level: 1, normalBalance,
    ifrsStatement: 'STATEMENT_OF_FINANCIAL_POSITION', ifrsCategory: '', ifrsSubcategory: '',
    cashFlowCategory: 'NOT_APPLICABLE', isPostingAccount: true, isActive: true, description: '',
    industryTag: 'general', sortOrder: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  };
}
const A = acc('a', 'DEBIT');
const B = acc('b', 'CREDIT');
const byId = new Map([[A.id, A], [B.id, B]]);

let seq = 0;
function ln(accountId: string, debit: number, credit: number): JournalLine {
  seq += 1;
  return { id: `l${seq}`, journalEntryId: '', lineNumber: 0, accountId, accountCode: '', accountName: '', description: '', debit, credit, entityId: '', entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '' };
}
function entry(id: string, status: JournalStatus, lines: JournalLine[]): JournalEntry {
  const td = lines.reduce((s, l) => s + l.debit, 0);
  const tc = lines.reduce((s, l) => s + l.credit, 0);
  return {
    id, entryNumber: id, entryDate: '2026-02-01', reference: '', description: id, status,
    transactionType: '', currency: 'USD', exchangeRate: 1, totalDebit: td, totalCredit: tc, difference: td - tc,
    notes: '', reversalReference: '', lines, createdAt: '2026-02-01T00:00:00Z', createdBy: 'Dave', updatedAt: '2026-02-01T00:00:00Z',
    updatedBy: 'Dave', postedAt: status === 'posted' ? '2026-02-02T00:00:00Z' : '', postedBy: status === 'posted' ? 'Mgr' : '',
    approvedBy: status === 'posted' ? 'Mgr' : '', voidedAt: '', voidedBy: '', originalEntryId: '', reversalEntryId: '',
  };
}

const POSTED = entry('P1', 'posted', [ln('a', 100, 0), ln('b', 0, 100)]);
const READY_DRAFT = entry('D-READY', 'draft', [ln('a', 50, 0), ln('b', 0, 50)]); // balanced → pending
const BAD_DRAFT = entry('D-BAD', 'draft', [ln('a', 50, 0), ln('b', 0, 40)]); // unbalanced → draft
const VOIDED = entry('V1', 'void', [ln('a', 10, 0), ln('b', 0, 10)]);
const ALL = [POSTED, READY_DRAFT, BAD_DRAFT, VOIDED];

describe('display status', () => {
  it('classifies posted / pending / draft / void', () => {
    expect(journalDisplayStatus(POSTED, byId)).toBe('posted');
    expect(journalDisplayStatus(READY_DRAFT, byId)).toBe('pending');
    expect(journalDisplayStatus(BAD_DRAFT, byId)).toBe('draft');
    expect(journalDisplayStatus(VOIDED, byId)).toBe('void');
  });
});

describe('tab counts & filtering', () => {
  it('counts each tab (draft and pending partition drafts)', () => {
    const c = tabCounts(ALL, byId);
    expect(c).toEqual({ all: 4, draft: 1, pending: 1, posted: 1 });
  });
  it('filters by tab', () => {
    expect(filterByTab(ALL, 'posted', byId).map((e) => e.id)).toEqual(['P1']);
    expect(filterByTab(ALL, 'pending', byId).map((e) => e.id)).toEqual(['D-READY']);
    expect(filterByTab(ALL, 'draft', byId).map((e) => e.id)).toEqual(['D-BAD']);
    expect(filterByTab(ALL, 'all', byId)).toHaveLength(4);
  });
});

describe('summary', () => {
  it('debit/credit totals come from posted entries and difference is zero when balanced', () => {
    const s = journalSummary(ALL);
    expect(s.totalDebit).toBe(100);
    expect(s.totalCredit).toBe(100);
    expect(s.difference).toBe(0);
    expect(s.draftCount).toBe(2);
    expect(s.postedCount).toBe(1);
  });
});

describe('pagination', () => {
  const items = Array.from({ length: 64 }, (_, i) => i + 1);
  it('slices and reports range', () => {
    const p = paginate(items, 1, 20);
    expect(p.items).toHaveLength(20);
    expect(p.from).toBe(1);
    expect(p.to).toBe(20);
    expect(p.total).toBe(64);
    expect(p.totalPages).toBe(4);
  });
  it('clamps out-of-range pages', () => {
    const p = paginate(items, 99, 20);
    expect(p.page).toBe(4);
    expect(p.from).toBe(61);
    expect(p.to).toBe(64);
  });
  it('builds page numbers with ellipses', () => {
    expect(pageNumbers(1, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pageNumbers(1, 10)).toEqual([1, 2, '…', 10]);
    expect(pageNumbers(5, 10)).toEqual([1, '…', 4, 5, 6, '…', 10]);
  });
});

describe('workflow steps', () => {
  it('created is complete; posting pending for drafts', () => {
    const steps = buildWorkflowSteps(READY_DRAFT);
    expect(steps[0]).toMatchObject({ stage: 'created', status: 'complete' });
    expect(steps[3]).toMatchObject({ stage: 'posting', status: 'pending' });
  });
  it('all complete for posted', () => {
    const steps = buildWorkflowSteps(POSTED);
    expect(steps.every((s) => s.status === 'complete')).toBe(true);
  });
});
