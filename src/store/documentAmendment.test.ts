import { describe, it, expect, beforeEach } from 'vitest';
import { useInvoiceStore } from './invoiceStore';
import { useBillStore } from './billStore';
import { useCreditNoteStore } from './creditNoteStore';
import { useReceiptStore } from './receiptStore';
import { usePaymentStore } from './paymentStore';
import { useInvoiceTemplateStore } from './invoiceTemplateStore';
import { useInventoryStore } from './inventoryStore';
import { useJournalStore } from './journalStore';
import { useEntitlementStore } from './entitlementStore';
import { useTaxPeriodStore } from './taxPeriodStore';
import { useAmendmentAuditStore } from './amendmentAuditStore';
import { useAmendmentPolicyStore } from './amendmentPolicyStore';
import { useAuthStore } from './authStore';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import {
  amendPostedDocument,
  amendmentChain,
  amendmentFingerprint,
  assessAmendment,
} from '@/services/documentAmendmentService';
import { getQuantityOnHand, getInventoryValue } from '@/lib/inventoryBalance';
import { makeInventorySeed, ENTITY } from '@/lib/inventorySeed';
import { buildTrialBalanceRows, calculateTrialBalanceTotals } from '@/lib/trialBalanceCalculations';
import type { AmendmentRequest } from '@/types/documentAmendment';
import type { OrganizationRole } from '@/types/roles';
import type { RegisteredUser } from '@/types/onboarding';

/* ── Harness ──────────────────────────────────────────────────────────────── */

const inv = () => useInventoryStore.getState();
const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const customerId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;
const supplierId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'supplier' || e.entityType === 'both')!.id;
const entries = () => useJournalStore.getState().entries;
const posted = () => entries().filter((e) => e.status === 'posted');

function seedInventory(): void {
  const s = makeInventorySeed('core');
  useInventoryStore.setState({ ...s, movements: [], documents: [], auditTrail: [], seeded: true });
}

/**
 * Sign a user in with a given role.
 *
 * The permission resolver reads the acting user from `authStore`, exactly as
 * the stores do, so a test that wants to be an accountant becomes one rather
 * than passing a role into a function that would otherwise ignore it.
 */
function signInAs(role: OrganizationRole, id = 'user_test'): RegisteredUser {
  const user: RegisteredUser = {
    id,
    fullName: `Test ${role}`,
    email: `${id}@example.test`,
    mobile: '',
    country: 'JO',
    passwordHash: 'x',
    emailVerified: true,
    role,
    status: 'active',
    organizationId: 'org_test',
    createdAt: new Date().toISOString(),
  };
  useAuthStore.setState({ users: [user], currentUserId: user.id });
  return user;
}

function signOut(): void {
  useAuthStore.setState({ users: [], currentUserId: undefined });
}

let correlation = 0;
function request(partial: Partial<AmendmentRequest> & Pick<AmendmentRequest, 'documentType' | 'documentId'>): AmendmentRequest {
  correlation += 1;
  return {
    reason: 'Customer was billed the wrong quantity',
    expectedVersion: 1,
    correlationId: `corr-${correlation}`,
    patch: {},
    confirmed: true,
    ...partial,
  };
}

/* ── Document builders ────────────────────────────────────────────────────── */

async function postedInvoice(opts?: { quantity?: number; unitPrice?: number; inventory?: boolean; issueDate?: string }): Promise<string> {
  const issueDate = opts?.issueDate ?? '2026-03-05';
  const { id } = await useInvoiceStore.getState().createDraft({ customerId: customerId(), issueDate, dueDate: issueDate });
  const draft = useInvoiceStore.getState().getInvoice(id!)!;
  const line = {
    ...draft.lines[0]!,
    accountId: acc('4110'),
    description: 'Trading goods',
    quantity: opts?.quantity ?? 4,
    unitPrice: opts?.unitPrice ?? 25,
    taxRate: 0,
    ...(opts?.inventory
      ? { inventoryItemId: 'item_goods', warehouseId: 'wh_main', inventoryFulfillmentMode: 'issue-on-invoice' as const }
      : {}),
  };
  await useInvoiceStore.getState().updateDraft(id!, { lines: [line], issueDate, dueDate: issueDate });
  const res = await useInvoiceStore.getState().issueInvoice(id!);
  expect(res.ok, res.error).toBe(true);
  return id!;
}

function postedBill(opts?: { quantity?: number; unitPrice?: number; inventory?: boolean; billDate?: string }): string {
  const billDate = opts?.billDate ?? '2026-03-05';
  const { id } = useBillStore.getState().createDraft({ supplierId: supplierId(), billDate, dueDate: billDate });
  const draft = useBillStore.getState().getBill(id!)!;
  const line = {
    ...draft.lines[0]!,
    accountId: opts?.inventory ? acc('1213') : acc('6200'),
    description: 'Supplies',
    quantity: opts?.quantity ?? 10,
    unitPrice: opts?.unitPrice ?? 12,
    taxRate: 0,
    ...(opts?.inventory
      ? { inventoryItemId: 'item_goods', warehouseId: 'wh_main', inventoryReceiptMode: 'receive-on-bill' as const }
      : {}),
  };
  useBillStore.getState().updateDraft(id!, { lines: [line], supplierInvoiceNumber: `SUP-${id!.slice(-5)}`, billDate, dueDate: billDate });
  const res = useBillStore.getState().postBill(id!);
  expect(res.ok, res.error).toBe(true);
  return id!;
}

async function issuedCreditNote(invoiceId: string, quantity = 1): Promise<string> {
  const created = useCreditNoteStore.getState().createCreditNoteFromInvoice(invoiceId, { creditType: 'partial' });
  expect(created.ok, created.error).toBe(true);
  const note = useCreditNoteStore.getState().getCreditNoteById(created.id!)!;
  const line = { ...note.lines[0]!, quantity, taxRate: 0 };
  useCreditNoteStore.getState().saveCreditNoteDraft(created.id!, { lines: [line], issueDate: '2026-03-06' });
  const res = useCreditNoteStore.getState().issueCreditNote(created.id!, { autoApplyToOriginal: false });
  expect(res.ok, res.error).toBe(true);
  return created.id!;
}

/* ── Setup ────────────────────────────────────────────────────────────────── */

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  /*
   * The demo seed posts to trade receivables and payables among others, which
   * would sit underneath every reconciliation in this file and make a passing
   * assertion say nothing about the amendment. These tests start from an empty
   * ledger and post everything they measure.
   */
  useJournalStore.setState({ entries: [] });
  useEntitlementStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useInvoiceStore.setState({ backend: 'browser' });
  useBillStore.getState().resetToDefault();
  useCreditNoteStore.getState().resetToDefault();
  useReceiptStore.getState().resetToDefault();
  usePaymentStore.getState().resetToDefault();
  useInventoryStore.getState().resetToDefault();
  useTaxPeriodStore.getState().resetToDefault();
  useAmendmentAuditStore.getState().resetToDefault();
  useAmendmentPolicyStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
  seedInventory();
  signOut();
});

/* ══ 1. The core reversal-and-reposting behaviour ═══════════════════════════ */

describe('amending a posted sales invoice', () => {
  it('preserves the original, posts a reversal and posts a corrected replacement', async () => {
    const id = await postedInvoice({ quantity: 4, unitPrice: 25 });
    const original = useInvoiceStore.getState().getInvoice(id)!;
    const originalEntry = entries().find((e) => e.id === original.journalEntryId)!;
    const originalSnapshot = JSON.parse(JSON.stringify(originalEntry)) as typeof originalEntry;

    const result = await amendPostedDocument(request({
      documentType: 'invoice',
      documentId: id,
      patch: { lines: [{ ...original.lines[0]!, quantity: 6 }] },
    }));

    expect(result.ok, result.error).toBe(true);

    /* The original document is untouched apart from its links and its status. */
    const kept = useInvoiceStore.getState().getInvoice(id)!;
    expect(kept.invoiceNumber).toBe(original.invoiceNumber);
    expect(kept.grandTotal).toBe(original.grandTotal);
    expect(kept.lines).toEqual(original.lines);
    expect(kept.issueDate).toBe(original.issueDate);
    expect(kept.journalEntryId).toBe(original.journalEntryId);
    expect(kept.status).toBe('superseded');
    expect(kept.supersededByDocumentId).toBe(result.replacementId);

    /* The original JOURNAL ENTRY's figures are untouched. */
    const afterEntry = entries().find((e) => e.id === original.journalEntryId)!;
    expect(afterEntry.lines).toEqual(originalSnapshot.lines);
    expect(afterEntry.totalDebit).toBe(originalSnapshot.totalDebit);
    expect(afterEntry.status).toBe('posted');

    /* The reversal exactly negates the original posting, in the same period. */
    const reversal = entries().find((e) => e.id === result.reversalJournalEntryId)!;
    expect(reversal.status).toBe('posted');
    expect(reversal.entryDate).toBe(originalSnapshot.entryDate);
    expect(reversal.totalDebit).toBe(originalSnapshot.totalCredit);
    expect(reversal.totalCredit).toBe(originalSnapshot.totalDebit);
    for (const line of originalSnapshot.lines) {
      const mirrored = reversal.lines.find((l) => l.accountId === line.accountId);
      expect(mirrored).toBeTruthy();
      expect(mirrored!.debit).toBe(line.credit);
      expect(mirrored!.credit).toBe(line.debit);
    }

    /* The replacement reflects the corrected document and is posted. */
    const replacement = useInvoiceStore.getState().getInvoice(result.replacementId!)!;
    expect(replacement.grandTotal).toBe(150);
    expect(replacement.status).toBe('issued');
    expect(replacement.invoiceNumber).not.toBe(original.invoiceNumber);
    const replacementEntry = entries().find((e) => e.id === replacement.journalEntryId)!;
    expect(replacementEntry.status).toBe('posted');
    expect(replacementEntry.totalDebit).toBe(150);
  });

  it('links original, reversal and replacement in both directions', async () => {
    const id = await postedInvoice();
    const original = useInvoiceStore.getState().getInvoice(id)!;
    const result = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, patch: { notes: 'corrected' },
    }));
    expect(result.ok, result.error).toBe(true);

    const kept = useInvoiceStore.getState().getInvoice(id)!;
    const replacement = useInvoiceStore.getState().getInvoice(result.replacementId!)!;
    expect(kept.amendmentReversalJournalEntryId).toBe(result.reversalJournalEntryId);
    expect(kept.supersededByDocumentNumber).toBe(replacement.invoiceNumber);
    expect(replacement.amendsDocumentId).toBe(id);
    expect(replacement.amendsDocumentNumber).toBe(original.invoiceNumber);
    expect(replacement.amendmentVersion).toBe(2);
    expect(replacement.amendmentChainId).toBe(id);

    /* The journal side links too: the original names its reversal. */
    const originalEntry = entries().find((e) => e.id === original.journalEntryId)!;
    expect(originalEntry.reversalEntryId).toBe(result.reversalJournalEntryId);
  });

  it('keeps debits equal to credits and the trial balance balanced', async () => {
    const id = await postedInvoice({ quantity: 4, unitPrice: 25 });
    const original = useInvoiceStore.getState().getInvoice(id)!;
    await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, patch: { lines: [{ ...original.lines[0]!, quantity: 9 }] },
    }));

    for (const entry of posted()) {
      expect(entry.totalDebit).toBeCloseTo(entry.totalCredit, 6);
    }
    const base = useStore.getState().settings.baseCurrency;
    const rows = buildTrialBalanceRows(
      useStore.getState().accounts, entries(), { from: '2026-01-01', to: '2026-12-31' }, base,
    );
    const totals = calculateTrialBalanceTotals(rows);
    expect(totals.closingDebit).toBeCloseTo(totals.closingCredit, 6);
    expect(totals.periodDebits).toBeCloseTo(totals.periodCredits, 6);
  });

  it('leaves the net ledger effect equal to the corrected document alone', async () => {
    const id = await postedInvoice({ quantity: 4, unitPrice: 25 });
    const original = useInvoiceStore.getState().getInvoice(id)!;
    await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, patch: { lines: [{ ...original.lines[0]!, quantity: 6 }] },
    }));

    /* Original 100 + reversal (100) + replacement 150 = 150 of revenue. */
    const revenue = posted()
      .flatMap((e) => e.lines)
      .filter((l) => l.accountId === acc('4110'))
      .reduce((sum, l) => sum + l.credit - l.debit, 0);
    expect(revenue).toBeCloseTo(150, 6);
  });

  it('forms a traceable chain over repeated amendments without erasing a version', async () => {
    const id = await postedInvoice({ quantity: 2, unitPrice: 50 });
    const first = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, patch: { notes: 'v2' },
    }));
    expect(first.ok, first.error).toBe(true);
    const second = await amendPostedDocument(request({
      documentType: 'invoice', documentId: first.replacementId!, expectedVersion: 2, patch: { notes: 'v3' },
    }));
    expect(second.ok, second.error).toBe(true);

    const chain = amendmentChain('invoice', second.replacementId!);
    expect(chain.map((c) => c.version)).toEqual([1, 2, 3]);
    expect(chain.map((c) => c.id)).toEqual([...new Set(chain.map((c) => c.id))]);
    expect(chain.filter((c) => c.current)).toHaveLength(1);
    expect(chain[2]!.id).toBe(second.replacementId);
    /* Every earlier version still exists and still carries its own number. */
    expect(new Set(chain.map((c) => c.number)).size).toBe(3);
    /* And the chain is findable from the ORIGINAL as well as from the latest. */
    expect(amendmentChain('invoice', id).map((c) => c.id)).toEqual(chain.map((c) => c.id));

    const v2 = useInvoiceStore.getState().getInvoice(first.replacementId!)!;
    expect(v2.amendmentVersion).toBe(2);
    expect(v2.supersededByDocumentId).toBe(second.replacementId);
    const v3 = useInvoiceStore.getState().getInvoice(second.replacementId!)!;
    expect(v3.amendmentVersion).toBe(3);
    expect(v3.supersededByDocumentId).toBeUndefined();
    expect(v3.amendmentChainId).toBe(id);
  });
});

describe('amending a posted purchase bill', () => {
  it('reverses and reposts, preserving the original bill and its journal', async () => {
    const id = postedBill({ quantity: 10, unitPrice: 12 });
    const original = useBillStore.getState().getBill(id)!;
    const originalEntry = entries().find((e) => e.id === original.journalEntryId)!;
    const before = JSON.parse(JSON.stringify(originalEntry)) as typeof originalEntry;

    const result = await amendPostedDocument(request({
      documentType: 'bill', documentId: id, patch: { lines: [{ ...original.lines[0]!, unitPrice: 15 }] },
    }));
    expect(result.ok, result.error).toBe(true);

    const kept = useBillStore.getState().getBill(id)!;
    expect(kept.status).toBe('superseded');
    expect(kept.billNumber).toBe(original.billNumber);
    expect(kept.grandTotal).toBe(original.grandTotal);
    expect(entries().find((e) => e.id === original.journalEntryId)!.lines).toEqual(before.lines);

    const reversal = entries().find((e) => e.id === result.reversalJournalEntryId)!;
    expect(reversal.status).toBe('posted');
    expect(reversal.totalDebit).toBeCloseTo(before.totalCredit, 6);

    const replacement = useBillStore.getState().getBill(result.replacementId!)!;
    expect(replacement.grandTotal).toBe(150);
    expect(replacement.status).toBe('posted');
    expect(replacement.supplierInvoiceNumber).toBe(original.supplierInvoiceNumber);
  });

  it('does not double-count a superseded bill in payables', async () => {
    const id = postedBill({ quantity: 10, unitPrice: 12 });
    const original = useBillStore.getState().getBill(id)!;
    await amendPostedDocument(request({
      documentType: 'bill', documentId: id, patch: { lines: [{ ...original.lines[0]!, unitPrice: 15 }] },
    }));

    const payable = posted()
      .flatMap((e) => e.lines)
      .filter((l) => l.accountId === acc('2210'))
      .reduce((sum, l) => sum + l.credit - l.debit, 0);
    expect(payable).toBeCloseTo(150, 6);

    const open = useBillStore.getState().bills.filter((b) => b.status === 'posted' || b.status === 'partially-paid');
    expect(open).toHaveLength(1);
    expect(open[0]!.grandTotal).toBe(150);
  });
});

describe('amending a posted customer credit note', () => {
  it('reverses and reposts, keeping the original note and its number', async () => {
    const invoiceId = await postedInvoice({ quantity: 4, unitPrice: 25 });
    const noteId = await issuedCreditNote(invoiceId, 1);
    const original = useCreditNoteStore.getState().getCreditNoteById(noteId)!;

    const result = await amendPostedDocument(request({
      documentType: 'credit-note',
      documentId: noteId,
      patch: { lines: [{ ...original.lines[0]!, quantity: 2 }] },
    }));
    expect(result.ok, result.error).toBe(true);

    const kept = useCreditNoteStore.getState().getCreditNoteById(noteId)!;
    expect(kept.status).toBe('superseded');
    expect(kept.creditNoteNumber).toBe(original.creditNoteNumber);
    expect(kept.grandTotal).toBe(original.grandTotal);

    const replacement = useCreditNoteStore.getState().getCreditNoteById(result.replacementId!)!;
    expect(replacement.grandTotal).toBe(50);
    expect(replacement.status).toBe('issued');
    expect(entries().find((e) => e.id === result.reversalJournalEntryId)!.status).toBe('posted');
  });
});

describe('amending a posted supplier debit note', () => {
  it('reverses the note’s posting and raises a corrected one against the same bill', async () => {
    const billId = postedBill({ quantity: 10, unitPrice: 12 });
    const created = useBillStore.getState().createSupplierCredit(billId, {
      netAmount: 24, creditAccountId: acc('6200'), reason: 'Two units returned', date: '2026-03-08',
    });
    expect(created.ok, created.error).toBe(true);
    const bill = useBillStore.getState().getBill(billId)!;
    const note = bill.supplierCredits[0]!;
    expect(bill.supplierCreditsApplied).toBe(24);

    const result = await amendPostedDocument(request({
      documentType: 'supplier-debit-note',
      documentId: note.id,
      reason: 'Three units were returned, not two',
      patch: { netAmount: 36, creditAccountId: acc('6200') },
    }));
    expect(result.ok, result.error).toBe(true);

    const after = useBillStore.getState().getBill(billId)!;
    const kept = after.supplierCredits.find((c) => c.id === note.id)!;
    expect(kept.amount).toBe(24);
    expect(kept.creditNumber).toBe(note.creditNumber);
    expect(kept.supersededByDocumentId).toBe(result.replacementId);
    expect(kept.journalEntryId).toBe(note.journalEntryId);

    const replacement = after.supplierCredits.find((c) => c.id === result.replacementId)!;
    expect(replacement.amount).toBe(36);
    expect(after.supplierCreditsApplied).toBe(36);
    expect(after.balanceDue).toBe(84);

    /* The net ledger effect of the two notes plus the reversal is 36. */
    const expense = posted()
      .flatMap((e) => e.lines)
      .filter((l) => l.accountId === acc('6200'))
      .reduce((sum, l) => sum + l.debit - l.credit, 0);
    expect(expense).toBeCloseTo(120 - 36, 6);
  });
});

/* ══ 2. Permissions ════════════════════════════════════════════════════════ */

describe('permissions', () => {
  it('lets the owner amend, and refuses an accountant by default', async () => {
    const id = await postedInvoice();
    signInAs('accountant');
    const refused = await amendPostedDocument(request({ documentType: 'invoice', documentId: id }));
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/does not include permission/i);
    expect(useInvoiceStore.getState().getInvoice(id)!.status).toBe('issued');

    signInAs('owner', 'user_owner');
    const allowed = await amendPostedDocument(request({ documentType: 'invoice', documentId: id }));
    expect(allowed.ok, allowed.error).toBe(true);
  });

  it('honours a role grant the owner adds, and a user deny on top of it', async () => {
    signInAs('owner', 'user_owner');
    const granted = useAmendmentPolicyStore.getState().setRoleGrant('accountant', 'invoices:amend', true);
    expect(granted.ok, granted.error).toBe(true);

    const id = await postedInvoice();
    signInAs('accountant', 'user_acc');
    const allowed = await amendPostedDocument(request({ documentType: 'invoice', documentId: id }));
    expect(allowed.ok, allowed.error).toBe(true);

    /* A deny for that one person beats the role grant. */
    signInAs('owner', 'user_owner');
    useAmendmentPolicyStore.getState().setUserOverride('user_acc', 'invoices:amend', 'deny');
    const second = await postedInvoice();
    signInAs('accountant', 'user_acc');
    const refused = await amendPostedDocument(request({ documentType: 'invoice', documentId: second }));
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/permission/i);
  });

  it('grants one document type without granting the others', async () => {
    signInAs('owner', 'user_owner');
    useAmendmentPolicyStore.getState().setRoleGrant('manager', 'invoices:amend', true);
    const invoiceId = await postedInvoice();
    const billId = postedBill();

    signInAs('manager', 'user_mgr');
    expect((await amendPostedDocument(request({ documentType: 'invoice', documentId: invoiceId }))).ok).toBe(true);
    const bill = await amendPostedDocument(request({ documentType: 'bill', documentId: billId }));
    expect(bill.ok).toBe(false);
    expect(bill.error).toMatch(/purchase bills/i);
  });

  it('refuses a manager who tries to grant themselves the permission', () => {
    signInAs('manager', 'user_mgr');
    const result = useAmendmentPolicyStore.getState().setRoleGrant('manager', 'invoices:amend', true);
    expect(result.ok).toBe(false);
    expect(useAmendmentPolicyStore.getState().roleGrants).toHaveLength(0);
  });

  it('refuses an unknown permission key rather than storing it', () => {
    signInAs('owner', 'user_owner');
    const result = useAmendmentPolicyStore.getState()
      .setRoleGrant('viewer', 'everything:amend' as never, true);
    expect(result.ok).toBe(false);
    expect(useAmendmentPolicyStore.getState().roleGrants).toHaveLength(0);
  });

  it('refuses at the service even when the caller bypasses every screen', async () => {
    const id = await postedInvoice();
    signInAs('viewer', 'user_viewer');
    const result = await amendPostedDocument(request({ documentType: 'invoice', documentId: id }));
    expect(result.ok).toBe(false);
    /* And the journal store refuses the reversal on its own account too. */
    const invoice = useInvoiceStore.getState().getInvoice(id)!;
    const direct = useJournalStore.getState().reverseForSourceDocument(invoice.journalEntryId!, {
      sourceDocumentType: 'invoice', sourceDocumentId: id, sourceDocumentNumber: invoice.invoiceNumber,
      reason: 'trying to go round the front door',
    });
    expect(direct.ok).toBe(false);
    expect(entries().filter((e) => e.reversalReference)).toHaveLength(0);
  });

  it('refuses an unauthorized user on EVERY document type, not just invoices', async () => {
    const invoiceId = await postedInvoice();
    const billId = postedBill();
    const noteId = await issuedCreditNote(invoiceId, 1);
    const credit = useBillStore.getState().createSupplierCredit(billId, {
      netAmount: 20, creditAccountId: acc('6200'), reason: 'Returned', date: '2026-03-08',
    });
    expect(credit.ok, credit.error).toBe(true);
    const debitNoteId = useBillStore.getState().getBill(billId)!.supplierCredits[0]!.id;

    signInAs('member', 'user_member');
    const targets = [
      ['invoice', invoiceId],
      ['bill', billId],
      ['credit-note', noteId],
      ['supplier-debit-note', debitNoteId],
    ] as const;
    for (const [documentType, documentId] of targets) {
      const result = await amendPostedDocument(request({ documentType, documentId }));
      expect(result.ok, `${documentType} must be refused for a member`).toBe(false);
      expect(assessAmendment(documentType, documentId)!.eligible).toBe(false);
    }
    /* Nothing was reversed anywhere. */
    expect(entries().filter((e) => e.reversalReference)).toHaveLength(0);
  });

  it('lets the owner amend EVERY document type', async () => {
    signInAs('owner', 'user_owner');
    const invoiceId = await postedInvoice();
    const billId = postedBill();
    const noteId = await issuedCreditNote(invoiceId, 1);
    const credit = useBillStore.getState().createSupplierCredit(billId, {
      netAmount: 20, creditAccountId: acc('6200'), reason: 'Returned', date: '2026-03-08',
    });
    expect(credit.ok, credit.error).toBe(true);
    const debitNoteId = useBillStore.getState().getBill(billId)!.supplierCredits[0]!.id;

    const targets = [
      ['invoice', invoiceId, { notes: 'corrected' }],
      ['bill', billId, { notes: 'corrected' }],
      ['credit-note', noteId, { reasonDescription: 'corrected' }],
      ['supplier-debit-note', debitNoteId, { netAmount: 25, creditAccountId: acc('6200') }],
    ] as const;
    for (const [documentType, documentId, patch] of targets) {
      const result = await amendPostedDocument(request({ documentType, documentId, patch }));
      expect(result.ok, `${documentType}: ${result.error}`).toBe(true);
      expect(result.replacementId).toBeTruthy();
      expect(result.reversalJournalEntryId).toBeTruthy();
    }
    for (const entry of posted()) expect(entry.totalDebit).toBeCloseTo(entry.totalCredit, 6);
  });

  it('reports the permission refusal through the assessment, so the menu can explain it', async () => {
    const id = await postedInvoice();
    signInAs('member', 'user_member');
    const assessment = assessAmendment('invoice', id)!;
    expect(assessment.eligible).toBe(false);
    expect(assessment.blockers.some((b) => b.kind === 'permission')).toBe(true);
    expect(assessment.reason).toMatch(/permission/i);
  });
});

/* ══ 3. Tenant and company isolation ═══════════════════════════════════════ */

describe('tenant and company isolation', () => {
  it('refuses an id that is not in this company’s books', async () => {
    await postedInvoice();
    const result = await amendPostedDocument(request({
      documentType: 'invoice', documentId: 'inv_from_another_tenant',
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in this company/i);
    expect(assessAmendment('invoice', 'inv_from_another_tenant')).toBeNull();
  });

  it('refuses a document carrying another company’s issuing entity', async () => {
    const id = await postedInvoice();
    useInvoiceStore.setState((s) => ({
      invoices: s.invoices.map((i) => (i.id === id ? { ...i, entityId: 'other_company' } : i)),
    }));
    const assessment = assessAmendment('invoice', id)!;
    expect(assessment.eligible).toBe(false);
    expect(assessment.reason).toMatch(/another company/i);
    const result = await amendPostedDocument(request({ documentType: 'invoice', documentId: id }));
    expect(result.ok).toBe(false);
  });
});

/* ══ 4. Guard rails on the workflow itself ═════════════════════════════════ */

describe('workflow guards', () => {
  it('requires a meaningful reason', async () => {
    const id = await postedInvoice();
    for (const reason of ['', '   ', 'oops']) {
      const result = await amendPostedDocument(request({ documentType: 'invoice', documentId: id, reason }));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/reason is required/i);
    }
    expect(useInvoiceStore.getState().getInvoice(id)!.status).toBe('issued');
  });

  it('does nothing at all when the amendment is not confirmed', async () => {
    const id = await postedInvoice();
    const before = JSON.parse(JSON.stringify({ invoices: useInvoiceStore.getState().invoices, entries: entries() }));
    const result = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, confirmed: false, patch: { notes: 'never applied' },
    }));
    expect(result.ok).toBe(false);
    expect(useInvoiceStore.getState().invoices).toEqual(before.invoices);
    expect(entries()).toEqual(before.entries);
  });

  it('replays a duplicate submission instead of reversing twice', async () => {
    const id = await postedInvoice();
    const first = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, correlationId: 'same-key', patch: { notes: 'once' },
    }));
    expect(first.ok, first.error).toBe(true);
    const entryCount = entries().length;
    const invoiceCount = useInvoiceStore.getState().invoices.length;

    const second = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, correlationId: 'same-key', patch: { notes: 'twice' },
    }));
    expect(second.ok).toBe(true);
    expect(second.idempotentReplay).toBe(true);
    expect(second.replacementId).toBe(first.replacementId);
    expect(entries()).toHaveLength(entryCount);
    expect(useInvoiceStore.getState().invoices).toHaveLength(invoiceCount);
  });

  it('lets a refused attempt be retried under the same id once the problem is fixed', async () => {
    const id = await postedInvoice({ quantity: 4, unitPrice: 25 });
    const original = useInvoiceStore.getState().getInvoice(id)!;

    /* An empty line set cannot be posted, so this attempt is refused. */
    const refused = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, correlationId: 'retry-key', patch: { lines: [] },
    }));
    expect(refused.ok).toBe(false);

    /*
     * The operator goes back, corrects the mistake and confirms again in the
     * same drawer — which means the same correlation id. A failed attempt left
     * nothing behind, so this must go through rather than replay the refusal.
     */
    const retried = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, correlationId: 'retry-key',
      patch: { lines: [{ ...original.lines[0]!, quantity: 6 }] },
    }));
    expect(retried.ok, retried.error).toBe(true);
    expect(retried.idempotentReplay).toBeFalsy();
    expect(useInvoiceStore.getState().getInvoice(retried.replacementId!)!.grandTotal).toBe(150);

    /* And NOW the id is spent: a third call replays rather than amending again. */
    const third = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, correlationId: 'retry-key', patch: { notes: 'again' },
    }));
    expect(third.idempotentReplay).toBe(true);
    expect(third.replacementId).toBe(retried.replacementId);
  });

  it('rejects a stale amendment', async () => {
    const id = await postedInvoice();
    const first = await amendPostedDocument(request({ documentType: 'invoice', documentId: id, patch: { notes: 'v2' } }));
    expect(first.ok, first.error).toBe(true);

    /* Version 2 exists; a request still claiming version 1 of it is stale. */
    const stale = await amendPostedDocument(request({
      documentType: 'invoice', documentId: first.replacementId!, expectedVersion: 1,
    }));
    expect(stale.ok).toBe(false);
    expect(stale.conflict).toEqual({ currentVersion: 2, expectedVersion: 1 });
    expect(stale.error).toMatch(/changed while the amendment was open/i);
  });

  it('rejects an amendment whose document was settled after the drawer opened', async () => {
    const id = await postedInvoice();
    const openedWith = amendmentFingerprint('invoice', id)!;
    const paid = await useInvoiceStore.getState().recordPayment(id, {
      amount: 10, date: '2026-03-07', bankAccountId: acc('1252'),
    });
    expect(paid.ok, paid.error).toBe(true);
    expect(amendmentFingerprint('invoice', id)).not.toBe(openedWith);
    const result = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, expectedFingerprint: openedWith,
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/changed while the amendment was open/i);
  });

  it('refuses to amend a draft, a void document or an already-superseded version', async () => {
    const draft = await useInvoiceStore.getState().createDraft({ customerId: customerId() });
    const draftAssessment = assessAmendment('invoice', draft.id!)!;
    expect(draftAssessment.eligible).toBe(false);
    expect(draftAssessment.blockers[0]!.kind).toBe('not_posted');

    const voided = await postedInvoice();
    await useInvoiceStore.getState().voidInvoice(voided, 'cancelled by customer');
    expect(assessAmendment('invoice', voided)!.eligible).toBe(false);

    const id = await postedInvoice();
    const first = await amendPostedDocument(request({ documentType: 'invoice', documentId: id, patch: { notes: 'v2' } }));
    expect(first.ok, first.error).toBe(true);
    const supersededAssessment = assessAmendment('invoice', id)!;
    expect(supersededAssessment.eligible).toBe(false);
    expect(supersededAssessment.blockers[0]!.kind).toBe('not_current');
  });

  it('drops fields the accounting rules do not allow an amendment to change', async () => {
    const id = await postedInvoice();
    const original = useInvoiceStore.getState().getInvoice(id)!;
    const result = await amendPostedDocument(request({
      documentType: 'invoice',
      documentId: id,
      patch: {
        notes: 'legitimate',
        invoiceNumber: 'FORGED-0001',
        journalEntryId: 'je_forged',
        amountPaid: 9999,
        amendmentVersion: 99,
      },
    }));
    expect(result.ok, result.error).toBe(true);
    const replacement = useInvoiceStore.getState().getInvoice(result.replacementId!)!;
    expect(replacement.invoiceNumber).not.toBe('FORGED-0001');
    expect(replacement.journalEntryId).not.toBe('je_forged');
    expect(replacement.amountPaid).toBe(0);
    expect(replacement.amendmentVersion).toBe(2);
    expect(replacement.notes).toBe('legitimate');
    expect(useInvoiceStore.getState().getInvoice(id)!.invoiceNumber).toBe(original.invoiceNumber);
  });
});

/* ══ 5. Fiscal periods, tax and e-invoicing ════════════════════════════════ */

describe('period, tax and e-invoice controls', () => {
  function taxPeriod(status: 'open' | 'prepared' | 'filed' | 'locked'): void {
    const created = useTaxPeriodStore.getState().createPeriod({
      entityId: 'primary', jurisdictionId: 'jo', periodStart: '2026-03-01', periodEnd: '2026-03-31',
    });
    useTaxPeriodStore.getState().setStatus(created.id!, status);
  }

  it('refuses an amendment inside a filed tax return', async () => {
    const id = await postedInvoice({ issueDate: '2026-03-05' });
    taxPeriod('filed');
    const assessment = assessAmendment('invoice', id)!;
    expect(assessment.eligible).toBe(false);
    expect(assessment.blockers.some((b) => b.kind === 'filed_tax_return')).toBe(true);
    expect(assessment.blockers[0]!.correctiveWorkflow).toMatch(/credit note/i);

    const result = await amendPostedDocument(request({ documentType: 'invoice', documentId: id }));
    expect(result.ok).toBe(false);
    expect(useInvoiceStore.getState().getInvoice(id)!.status).toBe('issued');
  });

  it('refuses an amendment inside a locked period and never reopens it', async () => {
    const id = await postedInvoice({ issueDate: '2026-03-05' });
    taxPeriod('locked');
    const result = await amendPostedDocument(request({ documentType: 'invoice', documentId: id }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/locked/i);
    expect(useTaxPeriodStore.getState().periods[0]!.status).toBe('locked');
    expect(entries().filter((e) => e.reversalReference)).toHaveLength(0);
  });

  it('allows an amendment in a period that is merely prepared, but asks for confirmation', async () => {
    const id = await postedInvoice({ issueDate: '2026-03-05' });
    taxPeriod('prepared');
    const assessment = assessAmendment('invoice', id)!;
    expect(assessment.eligible).toBe(true);
    expect(assessment.confirmations.some((c) => c.kind === 'filed_tax_return')).toBe(true);
    expect((await amendPostedDocument(request({ documentType: 'invoice', documentId: id }))).ok).toBe(true);
  });

  it('refuses a document that carries an external fiscal identity', async () => {
    const id = await postedInvoice();
    /*
     * Ledgora has no live e-invoicing integration, so this is injected the only
     * way such an identity could arrive today — on the record itself. The point
     * of the test is that the probe REFUSES rather than restating a cleared
     * document behind the authority's back.
     */
    const { invoiceSubject } = await import('@/lib/documentAmendmentProbes');
    const { collectAmendmentFindings } = await import('@/lib/documentAmendmentProbes');
    const subject = invoiceSubject(useInvoiceStore.getState().getInvoice(id)!);
    const findings = collectAmendmentFindings({ ...subject, externalFiscalIdentity: 'JO-CLEARED-9f2c' });
    const blocker = findings.findings.find((f) => f.kind === 'external_einvoice');
    expect(blocker).toBeTruthy();
    expect(blocker!.severity).toBe('blocks');
    expect(blocker!.correctiveWorkflow).toMatch(/credit note|debit note/i);
  });
});

/* ══ 6. Payments, receipts and allocations ════════════════════════════════ */

describe('settlement', () => {
  it('amends an unpaid document through the ordinary workflow', async () => {
    const id = await postedInvoice({ quantity: 4, unitPrice: 25 });
    const assessment = assessAmendment('invoice', id)!;
    expect(assessment.eligible).toBe(true);
    expect(assessment.impact.settlement.amountSettled).toBe(0);
    expect((await amendPostedDocument(request({ documentType: 'invoice', documentId: id }))).ok).toBe(true);
  });

  it('carries a receipt allocation across without touching the receipt’s own posting', async () => {
    const id = await postedInvoice({ quantity: 4, unitPrice: 25 });
    const receipt = useReceiptStore.getState().createReceiptForInvoice(id);
    expect(receipt.ok, receipt.error).toBe(true);
    useReceiptStore.getState().updateDraft(receipt.id!, { amount: 40, bankAccountId: acc('1252'), receiptDate: '2026-03-07', transactionReference: 'TRF-40', allocations: [] });
    const postedReceipt = useReceiptStore.getState().postReceipt(receipt.id!);
    expect(postedReceipt.ok, postedReceipt.error).toBe(true);
    const applied = useReceiptStore.getState().applyReceiptToInvoices(receipt.id!, [{ invoiceId: id, amount: 40 }]);
    expect(applied.ok, applied.error).toBe(true);

    const receiptBefore = useReceiptStore.getState().getReceiptById(receipt.id!)!;
    const original = useInvoiceStore.getState().getInvoice(id)!;
    expect(original.amountPaid).toBe(40);

    const result = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, patch: { lines: [{ ...original.lines[0]!, quantity: 5 }] },
    }));
    expect(result.ok, result.error).toBe(true);

    const replacement = useInvoiceStore.getState().getInvoice(result.replacementId!)!;
    expect(replacement.grandTotal).toBe(125);
    expect(replacement.amountPaid).toBe(40);
    expect(replacement.balanceDue).toBe(85);
    expect(replacement.status).toBe('partially-paid');

    /* The receipt keeps its number, its total and its own bank journal entry. */
    const receiptAfter = useReceiptStore.getState().getReceiptById(receipt.id!)!;
    expect(receiptAfter.receiptNumber).toBe(receiptBefore.receiptNumber);
    expect(receiptAfter.journalEntryId).toBe(receiptBefore.journalEntryId);
    expect(receiptAfter.amount).toBe(receiptBefore.amount);
    expect(receiptAfter.allocationTotal).toBe(40);
    /* Only the allocation moved. */
    expect(receiptAfter.allocations[0]!.invoiceId).toBe(result.replacementId);
    expect(receiptAfter.allocations[0]!.invoiceNumber).toBe(replacement.invoiceNumber);
  });

  it('refuses rather than over-allocating when the corrected total is smaller than what is settled', async () => {
    const id = await postedInvoice({ quantity: 4, unitPrice: 25 });
    const receipt = useReceiptStore.getState().createReceiptForInvoice(id);
    useReceiptStore.getState().updateDraft(receipt.id!, { amount: 100, bankAccountId: acc('1252'), receiptDate: '2026-03-07', transactionReference: 'TRF-100', allocations: [] });
    const rp = useReceiptStore.getState().postReceipt(receipt.id!);
    expect(rp.ok, rp.error).toBe(true);
    const ra = useReceiptStore.getState().applyReceiptToInvoices(receipt.id!, [{ invoiceId: id, amount: 100 }]);
    expect(ra.ok, ra.error).toBe(true);

    const original = useInvoiceStore.getState().getInvoice(id)!;
    const result = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, patch: { lines: [{ ...original.lines[0]!, quantity: 1 }] },
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/over-allocate/i);

    /* Nothing at all changed: no reversal, no replacement, no lost receipt. */
    expect(useInvoiceStore.getState().getInvoice(id)!.status).toBe('paid');
    expect(useInvoiceStore.getState().getInvoice(id)!.amountPaid).toBe(100);
    expect(useInvoiceStore.getState().invoices).toHaveLength(1);
    expect(entries().filter((e) => e.reversalReference)).toHaveLength(0);
    const receiptAfter = useReceiptStore.getState().getReceiptById(receipt.id!)!;
    expect(receiptAfter.allocations[0]!.invoiceId).toBe(id);
    expect(receiptAfter.allocationTotal).toBe(100);
  });

  it('carries a bill payment allocation across to the amended bill', async () => {
    const billId = postedBill({ quantity: 10, unitPrice: 12 });
    const payment = usePaymentStore.getState().createPaymentForBill(billId);
    expect(payment.ok, payment.error).toBe(true);
    usePaymentStore.getState().updateDraft(payment.id!, { grossAmount: 50, bankAccountId: acc('1252'), paymentDate: '2026-03-07', transactionReference: 'TRF-50', allocations: [] });
    const postedPayment = usePaymentStore.getState().postPayment(payment.id!);
    expect(postedPayment.ok, postedPayment.error).toBe(true);
    const applied = usePaymentStore.getState().applyPaymentToBills(payment.id!, [{ billId, amount: 50 }]);
    expect(applied.ok, applied.error).toBe(true);

    const original = useBillStore.getState().getBill(billId)!;
    const result = await amendPostedDocument(request({
      documentType: 'bill', documentId: billId, patch: { lines: [{ ...original.lines[0]!, unitPrice: 15 }] },
    }));
    expect(result.ok, result.error).toBe(true);

    const replacement = useBillStore.getState().getBill(result.replacementId!)!;
    expect(replacement.amountPaid).toBe(50);
    expect(replacement.balanceDue).toBe(100);
    const paymentAfter = usePaymentStore.getState().getPayment(payment.id!)!;
    expect(paymentAfter.allocations[0]!.billId).toBe(result.replacementId);
    expect(paymentAfter.journalEntryId).toBeTruthy();
  });

  it('reconciles the customer balance after an amendment', async () => {
    const id = await postedInvoice({ quantity: 4, unitPrice: 25 });
    const original = useInvoiceStore.getState().getInvoice(id)!;
    await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, patch: { lines: [{ ...original.lines[0]!, quantity: 6 }] },
    }));

    const receivableFromLedger = posted()
      .flatMap((e) => e.lines)
      .filter((l) => l.accountId === acc('1221'))
      .reduce((sum, l) => sum + l.debit - l.credit, 0);
    const receivableFromDocuments = useInvoiceStore.getState().invoices
      .filter((i) => i.status !== 'superseded' && i.status !== 'void' && i.status !== 'draft')
      .reduce((sum, i) => sum + i.balanceDue, 0);
    expect(receivableFromDocuments).toBeCloseTo(receivableFromLedger, 6);
    expect(receivableFromDocuments).toBeCloseTo(150, 6);

    /* Exactly one live invoice remains, and it is the corrected one. */
    const live = useInvoiceStore.getState().invoices.filter((i) => i.status === 'issued');
    expect(live).toHaveLength(1);
    expect(live[0]!.grandTotal).toBe(150);
  });
});

describe('a document whose linked document was amended', () => {
  it('keeps a credit note usable after its invoice is amended, with the frozen reference intact', async () => {
    const invoiceId = await postedInvoice({ quantity: 4, unitPrice: 25 });
    const noteId = await issuedCreditNote(invoiceId, 1);
    const frozen = useCreditNoteStore.getState().getCreditNoteById(noteId)!.invoiceReferenceSnapshot;
    const originalNumber = useInvoiceStore.getState().getInvoice(invoiceId)!.invoiceNumber;

    const amended = await amendPostedDocument(request({
      documentType: 'invoice', documentId: invoiceId, patch: { notes: 'corrected' },
    }));
    expect(amended.ok, amended.error).toBe(true);
    const replacement = useInvoiceStore.getState().getInvoice(amended.replacementId!)!;

    const note = useCreditNoteStore.getState().getCreditNoteById(noteId)!;
    /* The LIVE link follows the version in force… */
    expect(note.originalInvoiceId).toBe(replacement.id);
    expect(note.originalInvoiceNumber).toBe(replacement.invoiceNumber);
    /* …and the FROZEN historical reference does not move. */
    expect(note.invoiceReferenceSnapshot).toEqual(frozen);
    expect(note.invoiceReferenceSnapshot?.invoiceNumber).toBe(originalNumber);

    /* And the note can still be amended, rather than being orphaned. */
    expect(assessAmendment('credit-note', noteId)!.eligible).toBe(true);
    const noteAmended = await amendPostedDocument(request({
      documentType: 'credit-note', documentId: noteId, patch: { reasonDescription: 'Corrected reason' },
    }));
    expect(noteAmended.ok, noteAmended.error).toBe(true);
  });

  it('keeps a supplier debit note usable after its bill is amended, and lists it once', async () => {
    const billId = postedBill({ quantity: 10, unitPrice: 12 });
    const created = useBillStore.getState().createSupplierCredit(billId, {
      netAmount: 24, creditAccountId: acc('6200'), reason: 'Two units returned', date: '2026-03-08',
    });
    expect(created.ok, created.error).toBe(true);
    const noteId = useBillStore.getState().getBill(billId)!.supplierCredits[0]!.id;

    const amended = await amendPostedDocument(request({
      documentType: 'bill', documentId: billId, patch: { notes: 'corrected' },
    }));
    expect(amended.ok, amended.error).toBe(true);

    /* The note is on both bills — history and current — but is ONE note. */
    const onOriginal = useBillStore.getState().getBill(billId)!.supplierCredits;
    const onReplacement = useBillStore.getState().getBill(amended.replacementId!)!.supplierCredits;
    expect(onOriginal).toHaveLength(1);
    expect(onReplacement).toHaveLength(1);
    expect(amendmentChain('supplier-debit-note', noteId)).toHaveLength(1);

    /* And amending it acts on the bill in force, not on the superseded one. */
    const noteAmended = await amendPostedDocument(request({
      documentType: 'supplier-debit-note', documentId: noteId,
      reason: 'Three units were returned, not two',
      patch: { netAmount: 36, creditAccountId: acc('6200') },
    }));
    expect(noteAmended.ok, noteAmended.error).toBe(true);
    const current = useBillStore.getState().getBill(amended.replacementId!)!;
    expect(current.supplierCreditsApplied).toBe(36);
    /* The superseded bill is untouched by any of it. */
    expect(useBillStore.getState().getBill(billId)!.supplierCreditsApplied).toBe(24);
  });
});

describe('tax', () => {
  it('reconciles output tax to the corrected document alone', async () => {
    const issueDate = '2026-03-05';
    const { id } = await useInvoiceStore.getState().createDraft({ customerId: customerId(), issueDate, dueDate: issueDate });
    const draft = useInvoiceStore.getState().getInvoice(id!)!;
    await useInvoiceStore.getState().updateDraft(id!, {
      lines: [{ ...draft.lines[0]!, accountId: acc('4110'), description: 'Taxed goods', quantity: 4, unitPrice: 25, taxRate: 16 }],
      issueDate, dueDate: issueDate,
    });
    expect((await useInvoiceStore.getState().issueInvoice(id!)).ok).toBe(true);

    const original = useInvoiceStore.getState().getInvoice(id!)!;
    expect(original.taxTotal).toBeCloseTo(16, 6);

    const result = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id!, patch: { lines: [{ ...original.lines[0]!, quantity: 6 }] },
    }));
    expect(result.ok, result.error).toBe(true);

    const replacement = useInvoiceStore.getState().getInvoice(result.replacementId!)!;
    expect(replacement.taxTotal).toBeCloseTo(24, 6);

    /* Original 16 + reversal (16) + replacement 24 = 24 of output tax. */
    const outputTax = posted()
      .flatMap((e) => e.lines)
      .filter((l) => l.accountId === acc('2270'))
      .reduce((sum, l) => sum + l.credit - l.debit, 0);
    expect(outputTax).toBeCloseTo(24, 6);

    /* And the document-side tax total agrees with the ledger. */
    const documentTax = useInvoiceStore.getState().invoices
      .filter((i) => i.status !== 'superseded' && i.status !== 'void' && i.status !== 'draft')
      .reduce((sum, i) => sum + i.taxTotal, 0);
    expect(documentTax).toBeCloseTo(outputTax, 6);
  });
});

/* ══ 7. Inventory ═════════════════════════════════════════════════════════ */

describe('inventory', () => {
  function receiveStock(quantity: number, unitCost: number): void {
    const res = inv().postGoodsReceipt({
      date: '2026-03-01', reference: 'GRN-SEED',
      lines: [{ id: 'l1', itemId: 'item_goods', warehouseId: 'wh_main', quantity, unitId: 'uom_ea', unitCost }],
    });
    expect(res.ok, res.error).toBe(true);
  }

  it('reverses and reposts stock movements and COGS at the original cost', async () => {
    receiveStock(100, 10);
    const id = await postedInvoice({ quantity: 4, unitPrice: 25, inventory: true });
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: 'item_goods' })).toBe(96);
    const original = useInvoiceStore.getState().getInvoice(id)!;
    expect(original.lines[0]!.issuedUnitCost).toBe(10);

    const result = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, patch: { lines: [{ ...original.lines[0]!, quantity: 6 }] },
    }));
    expect(result.ok, result.error).toBe(true);

    /* 100 received, 6 issued by the amended invoice. */
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: 'item_goods' })).toBe(94);
    expect(getInventoryValue(inv().movements, { entityId: ENTITY, itemId: 'item_goods' })).toBeCloseTo(940, 6);

    /* COGS nets to 6 × 10, not 4 × 10 + 6 × 10. */
    const cogs = posted()
      .flatMap((e) => e.lines)
      .filter((l) => l.accountId === acc('5500'))
      .reduce((sum, l) => sum + l.debit - l.credit, 0);
    expect(cogs).toBeCloseTo(60, 6);

    /* The original stock document is reversed, not deleted. */
    const originalDoc = inv().documents.find((d) => d.reference === original.invoiceNumber && !d.reversalOfId)!;
    expect(originalDoc.status).toBe('reversed');
    expect(originalDoc.reversedById).toBeTruthy();
  });

  it('values the amendment from the stock ledger, never from the item’s catalogue purchase price', async () => {
    receiveStock(100, 10);
    /*
     * The item master's standard cost is deliberately different from what the
     * stock actually cost. Anything that valued the amendment from the
     * catalogue would produce 6 × 99; the valuation engine produces 6 × 10.
     */
    const item = inv().items.find((i) => i.id === 'item_goods')!;
    inv().saveItem({ ...item, standardCost: 99 });

    const id = await postedInvoice({ quantity: 4, unitPrice: 25, inventory: true });
    const original = useInvoiceStore.getState().getInvoice(id)!;
    const result = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, patch: { lines: [{ ...original.lines[0]!, quantity: 6 }] },
    }));
    expect(result.ok, result.error).toBe(true);

    const replacement = useInvoiceStore.getState().getInvoice(result.replacementId!)!;
    expect(replacement.lines[0]!.issuedUnitCost).toBe(10);
    const cogs = posted()
      .flatMap((e) => e.lines)
      .filter((l) => l.accountId === acc('5500'))
      .reduce((sum, l) => sum + l.debit - l.credit, 0);
    expect(cogs).toBeCloseTo(60, 6);
  });

  it('reconciles inventory valuation with the inventory control account', async () => {
    receiveStock(100, 10);
    const id = await postedInvoice({ quantity: 4, unitPrice: 25, inventory: true });
    const original = useInvoiceStore.getState().getInvoice(id)!;
    await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, patch: { lines: [{ ...original.lines[0]!, quantity: 6 }] },
    }));

    const subledger = getInventoryValue(inv().movements, { entityId: ENTITY, itemId: 'item_goods' });
    const control = posted()
      .flatMap((e) => e.lines)
      .filter((l) => l.accountId === acc('1213'))
      .reduce((sum, l) => sum + l.debit - l.credit, 0);
    expect(subledger).toBeCloseTo(control, 6);
  });

  it('blocks the amendment when the received stock has already been consumed', async () => {
    const billId = postedBill({ quantity: 10, unitPrice: 12, inventory: true });
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: 'item_goods' })).toBe(10);
    /* Sell all ten. Reversing the receipt would now drive stock negative. */
    await postedInvoice({ quantity: 10, unitPrice: 30, inventory: true });
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: 'item_goods' })).toBe(0);

    const assessment = assessAmendment('bill', billId)!;
    expect(assessment.eligible).toBe(false);
    expect(assessment.blockers.some((b) => b.kind === 'inventory_dependency')).toBe(true);
    expect(assessment.blockers[0]!.correctiveWorkflow).toMatch(/return|adjustment/i);

    const result = await amendPostedDocument(request({ documentType: 'bill', documentId: billId }));
    expect(result.ok).toBe(false);
    expect(useBillStore.getState().getBill(billId)!.status).toBe('posted');
    expect(getQuantityOnHand(inv().movements, { entityId: ENTITY, itemId: 'item_goods' })).toBe(0);
  });

  it('reports the inventory footprint in the impact summary', async () => {
    receiveStock(50, 10);
    const id = await postedInvoice({ quantity: 4, unitPrice: 25, inventory: true });
    const assessment = assessAmendment('invoice', id)!;
    expect(assessment.impact.inventory.movementCount).toBe(1);
    expect(assessment.impact.inventory.reversible).toBe(true);
    expect(assessment.confirmations.some((c) => c.kind === 'inventory_dependency')).toBe(true);
  });
});

/* ══ 8. Failure safety ════════════════════════════════════════════════════ */

describe('failure safety', () => {
  it('rolls every store back when the replacement cannot be posted', async () => {
    const id = await postedInvoice({ quantity: 4, unitPrice: 25 });
    const before = JSON.parse(JSON.stringify({
      invoices: useInvoiceStore.getState().invoices,
      entries: entries(),
      movements: inv().movements,
      documents: inv().documents,
      numbering: useInvoiceTemplateStore.getState().numbering,
    }));

    /* An empty line set cannot be issued, so the replacement fails to post. */
    const result = await amendPostedDocument(request({
      documentType: 'invoice', documentId: id, patch: { lines: [] },
    }));
    expect(result.ok).toBe(false);

    expect(useInvoiceStore.getState().invoices).toEqual(before.invoices);
    expect(entries()).toEqual(before.entries);
    expect(inv().movements).toEqual(before.movements);
    expect(inv().documents).toEqual(before.documents);
    /* Including the number sequence: a rolled-back amendment burns no number. */
    expect(useInvoiceTemplateStore.getState().numbering).toEqual(before.numbering);
  });

  it('does not leave a posted reversal behind when the amendment fails', async () => {
    const id = await postedInvoice();
    const postedBefore = posted().length;
    await amendPostedDocument(request({ documentType: 'invoice', documentId: id, patch: { lines: [] } }));
    expect(posted()).toHaveLength(postedBefore);
    expect(entries().filter((e) => e.reversalReference)).toHaveLength(0);
  });
});

/* ══ 9. Audit history ═════════════════════════════════════════════════════ */

describe('amendment audit trail', () => {
  it('records the actor, the reason and the before/after of every changed field', async () => {
    signInAs('owner', 'user_owner');
    const id = await postedInvoice({ quantity: 4, unitPrice: 25 });
    const original = useInvoiceStore.getState().getInvoice(id)!;
    const result = await amendPostedDocument(request({
      documentType: 'invoice',
      documentId: id,
      reason: 'Quantity delivered was six, not four',
      patch: { lines: [{ ...original.lines[0]!, quantity: 6 }] },
    }));
    expect(result.ok, result.error).toBe(true);

    const event = useAmendmentAuditStore.getState().events.find((e) => e.id === result.auditEventId)!;
    expect(event.outcome).toBe('succeeded');
    expect(event.actorUserId).toBe('user_owner');
    expect(event.actorRole).toBe('owner');
    expect(event.actedAsPlatformOperator).toBe(false);
    expect(event.reason).toBe('Quantity delivered was six, not four');
    expect(event.documentType).toBe('invoice');
    expect(event.documentNumber).toBe(original.invoiceNumber);
    expect(event.originalJournalEntryId).toBe(original.journalEntryId);
    expect(event.reversalJournalEntryId).toBe(result.reversalJournalEntryId);
    expect(event.replacementJournalEntryId).toBe(result.replacementJournalEntryId);
    expect(event.correlationId).toBeTruthy();

    const total = event.changes.find((c) => c.field === 'grandTotal')!;
    expect(total.before).toContain('100');
    expect(total.after).toContain('150');
    expect(event.changes.some((c) => c.field === 'lines.0.quantity')).toBe(true);
  });

  it('records refusals as well as successes', async () => {
    const id = await postedInvoice();
    signInAs('viewer', 'user_viewer');
    await amendPostedDocument(request({ documentType: 'invoice', documentId: id }));
    const events = useAmendmentAuditStore.getState().events;
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('rejected');
    expect(events[0]!.failureReason).toMatch(/permission/i);
    expect(events[0]!.actorRole).toBe('viewer');
  });

  it('chains events so an alteration is detectable', async () => {
    const id = await postedInvoice();
    await amendPostedDocument(request({ documentType: 'invoice', documentId: id, patch: { notes: 'a' } }));
    const second = await postedInvoice();
    await amendPostedDocument(request({ documentType: 'invoice', documentId: second, patch: { notes: 'b' } }));

    expect(useAmendmentAuditStore.getState().verify().ok).toBe(true);

    /* Edit a stored reason the way somebody with devtools would. */
    useAmendmentAuditStore.setState((s) => ({
      events: s.events.map((e, i) => (i === 0 ? { ...e, reason: 'a different reason entirely' } : e)),
    }));
    const verification = useAmendmentAuditStore.getState().verify();
    expect(verification.ok).toBe(false);
    expect(verification.brokenAt).toBe(1);
    expect(verification.message).toMatch(/altered/i);
  });

  it('detects a removed event', async () => {
    const id = await postedInvoice();
    await amendPostedDocument(request({ documentType: 'invoice', documentId: id, patch: { notes: 'a' } }));
    const second = await postedInvoice();
    await amendPostedDocument(request({ documentType: 'invoice', documentId: second, patch: { notes: 'b' } }));
    useAmendmentAuditStore.setState((s) => ({ events: s.events.slice(1) }));
    expect(useAmendmentAuditStore.getState().verify().ok).toBe(false);
  });

  it('exposes no way at all to edit, delete or replace an event', () => {
    const store = useAmendmentAuditStore.getState() as unknown as Record<string, unknown>;
    /*
     * Including `replaceAll`, which every other store carries for the
     * company-switch path. Nothing in that path touches this store, and an
     * unused way to overwrite the whole trail is exactly what an append-only
     * trail must not have.
     */
    for (const forbidden of ['update', 'remove', 'delete', 'replaceAll', 'amend', 'set']) {
      expect(store[forbidden], `${forbidden} must not exist on the audit trail`).toBeUndefined();
    }
    const mutators = Object.entries(store)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .filter((name) => !['forDocument', 'findByCorrelation', 'findCompleted', 'verify'].includes(name));
    expect(mutators.sort()).toEqual(['append', 'resetToDefault']);
  });
});

/* ══ 10. Subscription state ═══════════════════════════════════════════════ */

describe('subscription restrictions', () => {
  for (const status of ['suspended', 'cancelled', 'expired'] as const) {
    it(`refuses an amendment while the subscription is ${status}`, async () => {
      const id = await postedInvoice();
      useEntitlementStore.setState((s) => ({ subscription: { ...s.subscription, status } }));
      const assessment = assessAmendment('invoice', id)!;
      expect(assessment.eligible).toBe(false);
      expect(assessment.blockers.some((b) => b.kind === 'subscription')).toBe(true);

      const result = await amendPostedDocument(request({ documentType: 'invoice', documentId: id }));
      expect(result.ok).toBe(false);
      expect(useInvoiceStore.getState().getInvoice(id)!.status).toBe('issued');
      expect(entries().filter((e) => e.reversalReference)).toHaveLength(0);
    });
  }
});

/* ══ 11. Backward compatibility ═══════════════════════════════════════════ */

describe('documents written before this feature existed', () => {
  it('loads and amends a document carrying no amendment metadata at all', async () => {
    const id = await postedInvoice();
    /* Strip every amendment field, as a persisted v1 record would have none. */
    useInvoiceStore.setState((s) => ({
      invoices: s.invoices.map((i) => {
        if (i.id !== id) return i;
        const {
          amendmentVersion, amendmentChainId, amendsDocumentId, amendsDocumentNumber,
          supersededByDocumentId, supersededByDocumentNumber, supersededAt, amendmentReason,
          amendmentReversalJournalEntryId, amendmentInventoryReversalId, amendmentAuditEventId,
          ...rest
        } = i;
        return rest as typeof i;
      }),
    }));

    const legacy = useInvoiceStore.getState().getInvoice(id)!;
    expect(legacy.amendmentVersion).toBeUndefined();

    const assessment = assessAmendment('invoice', id)!;
    expect(assessment.eligible).toBe(true);
    expect(assessment.version).toBe(1);
    expect(amendmentChain('invoice', id).map((c) => c.version)).toEqual([1]);

    const result = await amendPostedDocument(request({ documentType: 'invoice', documentId: id, patch: { notes: 'v2' } }));
    expect(result.ok, result.error).toBe(true);
    expect(useInvoiceStore.getState().getInvoice(result.replacementId!)!.amendmentVersion).toBe(2);
  });

  it('does not amend, reverse or repost anything of its own accord', async () => {
    const id = await postedInvoice();
    const before = JSON.parse(JSON.stringify({ invoices: useInvoiceStore.getState().invoices, entries: entries() }));
    /* Merely reading the assessment must change nothing. */
    assessAmendment('invoice', id);
    amendmentChain('invoice', id);
    expect(useInvoiceStore.getState().invoices).toEqual(before.invoices);
    expect(entries()).toEqual(before.entries);
    expect(useAmendmentAuditStore.getState().events).toHaveLength(0);
  });
});
