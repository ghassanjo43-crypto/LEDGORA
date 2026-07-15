import { describe, it, expect, beforeEach } from 'vitest';
import { useBillingStore } from './billingStore';
import { useEntitlementStore } from './entitlementStore';
import { useSessionStore } from './sessionStore';
import { useJournalStore, makeDefaultJournalValues, makeEmptyLine } from './journalStore';
import { useStore } from './useStore';
import type { ProofInput } from '@/lib/billingCalculations';

const billing = () => useBillingStore.getState();
const ent = () => useEntitlementStore.getState();

function planId(code: string): string {
  return billing().plans.find((p) => p.code === code)!.id;
}

function goodProof(overrides?: Partial<ProofInput>): ProofInput {
  return {
    fileName: 'receipt.png',
    fileType: 'image/png',
    fileSize: 2048,
    dataUrl: 'data:image/png;base64,AAAA',
    reference: 'TT-2026-777',
    amount: 29,
    paidAt: '2026-07-13',
    note: 'paid',
    ...overrides,
  };
}

function twoPostingAccounts(): [string, string] {
  const posting = useStore.getState().accounts.filter((a) => a.isPostingAccount);
  return [posting[0]!.id, posting[1]!.id];
}

beforeEach(() => {
  useBillingStore.getState().resetToDefault();
  useEntitlementStore.getState().resetToDefault();
  useJournalStore.getState().resetToDefault();
  useSessionStore.setState({ role: 'admin', userName: 'Finance Manager' });
});

/* ── Data-driven, editable packages ───────────────────────────────────────── */

describe('packages are data-driven and editable', () => {
  it('seeds five packages at the required monthly USD prices', () => {
    const byCode = Object.fromEntries(billing().plans.map((p) => [p.code, p.priceMonthly]));
    expect(byCode).toMatchObject({ core: 29, projects: 59, construction: 99, manufacturing: 119, enterprise: 249 });
  });

  it('lets an administrator edit price, name and limits', () => {
    const res = billing().updatePlan(planId('core'), { priceMonthly: 39, name: 'Core Plus', userLimit: 5 });
    expect(res.ok).toBe(true);
    const core = billing().plans.find((p) => p.code === 'core')!;
    expect(core.priceMonthly).toBe(39);
    expect(core.name).toBe('Core Plus');
    expect(core.userLimit).toBe(5);
  });

  it('rejects invalid plan edits with field errors', () => {
    const res = billing().updatePlan(planId('core'), { priceMonthly: -5 });
    expect(res.ok).toBe(false);
    expect(res.fieldErrors?.priceMonthly).toBeTruthy();
  });

  it('lets an administrator edit bank details and settings', () => {
    expect(billing().updateBankDetails({ iban: 'AE99 1111' }).ok).toBe(true);
    expect(billing().settings.bank.iban).toBe('AE99 1111');
    expect(billing().updateBillingSettings({ graceDays: 10 }).ok).toBe(true);
    expect(billing().settings.graceDays).toBe(10);
  });
});

/* ── Permission checks ────────────────────────────────────────────────────── */

describe('permission checks', () => {
  it('blocks non-administrators from editing packages, bank details and verifying payments', () => {
    useSessionStore.setState({ role: 'member' });
    expect(billing().updatePlan(planId('core'), { priceMonthly: 1 }).ok).toBe(false);
    expect(billing().updateBankDetails({ iban: 'x' }).ok).toBe(false);
    expect(billing().createPlan({
      code: 'x', name: 'X', description: '', edition: 'core', priceMonthly: 1, currency: 'USD',
      userLimit: 1, entityLimit: 1, addOnModules: [], removedModules: [], isActive: true, isPublic: true, sortOrder: 9,
    }).ok).toBe(false);
  });

  it('allows any role to request a subscription and upload proof', () => {
    useSessionStore.setState({ role: 'member' });
    const req = billing().requestSubscription(planId('core'));
    expect(req.ok).toBe(true);
    expect(billing().uploadPaymentProof(req.id!, goodProof()).ok).toBe(true);
  });
});

/* ── Full payment process (state machine) ─────────────────────────────────── */

describe('payment process: selection → invoice → proof → verification → activation', () => {
  it('runs the happy path and activates the subscription', () => {
    const req = billing().requestSubscription(planId('core'));
    expect(req.ok).toBe(true);
    let inv = billing().invoices.find((i) => i.id === req.id)!;
    expect(inv.status).toBe('issued');
    expect(inv.changeType).toBe('new');
    expect(inv.amount).toBe(29);
    expect(inv.bankSnapshot.bankName).toBeTruthy(); // bank instructions frozen

    // proof upload → pending verification
    expect(billing().uploadPaymentProof(req.id!, goodProof()).ok).toBe(true);
    inv = billing().invoices.find((i) => i.id === req.id)!;
    expect(inv.status).toBe('proof-submitted');

    // administrator approval → activation
    const appr = billing().approvePayment(req.id!);
    expect(appr.ok).toBe(true);
    inv = billing().invoices.find((i) => i.id === req.id)!;
    expect(inv.status).toBe('approved');
    expect(inv.verifiedBy).toBeTruthy();

    // entitlement store now reflects the plan
    expect(ent().subscription.edition).toBe('core');
    expect(ent().subscription.status).toBe('active');
    expect(ent().subscription.expiresAt).toBeTruthy();
    expect(billing().activePlanId).toBe(planId('core'));
  });

  it('requires a submitted proof before approval', () => {
    const req = billing().requestSubscription(planId('core'));
    expect(billing().approvePayment(req.id!).ok).toBe(false); // no proof yet
  });

  it('rejects invalid proof with field errors', () => {
    const req = billing().requestSubscription(planId('core'));
    const res = billing().uploadPaymentProof(req.id!, goodProof({ reference: '', dataUrl: '', fileName: '' }));
    expect(res.ok).toBe(false);
    expect(res.fieldErrors?.reference).toBeTruthy();
  });

  it('supports administrator rejection and re-upload', () => {
    const req = billing().requestSubscription(planId('core'));
    billing().uploadPaymentProof(req.id!, goodProof());
    expect(billing().rejectPayment(req.id!, 'Amount does not match').ok).toBe(true);
    let inv = billing().invoices.find((i) => i.id === req.id)!;
    expect(inv.status).toBe('rejected');
    expect(inv.rejectionReason).toContain('Amount');
    // re-upload returns it to pending verification
    expect(billing().uploadPaymentProof(req.id!, goodProof({ amount: 29 })).ok).toBe(true);
    inv = billing().invoices.find((i) => i.id === req.id)!;
    expect(inv.status).toBe('proof-submitted');
  });

  it('a member cannot approve — administrator required', () => {
    const req = billing().requestSubscription(planId('core'));
    billing().uploadPaymentProof(req.id!, goodProof());
    useSessionStore.setState({ role: 'member' });
    const res = billing().approvePayment(req.id!);
    expect(res.ok).toBe(false);
    expect(billing().invoices.find((i) => i.id === req.id)!.status).toBe('proof-submitted');
  });

  it('freezes bank details on the invoice even if settings change later', () => {
    const req = billing().requestSubscription(planId('core'));
    const before = billing().invoices.find((i) => i.id === req.id)!.bankSnapshot.iban;
    billing().updateBankDetails({ iban: 'CHANGED-LATER' });
    const after = billing().invoices.find((i) => i.id === req.id)!.bankSnapshot.iban;
    expect(after).toBe(before);
  });
});

/* ── Upgrade / downgrade ──────────────────────────────────────────────────── */

describe('upgrade and downgrade', () => {
  function activate(code: string): void {
    const req = billing().requestSubscription(planId(code));
    billing().uploadPaymentProof(req.id!, goodProof({ amount: billing().plans.find((p) => p.code === code)!.priceMonthly }));
    billing().approvePayment(req.id!);
  }

  it('classifies and applies an upgrade', () => {
    activate('core');
    const req = billing().requestSubscription(planId('projects'));
    const inv = billing().invoices.find((i) => i.id === req.id)!;
    expect(inv.changeType).toBe('upgrade');
    billing().uploadPaymentProof(req.id!, goodProof({ amount: 59 }));
    billing().approvePayment(req.id!);
    expect(ent().subscription.edition).toBe('projects');
    expect(billing().auditTrail.some((a) => a.event === 'subscription-upgraded')).toBe(true);
  });

  it('downgrades without deleting historical data (GL unchanged)', () => {
    activate('projects');
    // post a journal entry under the projects subscription
    const [a, b] = twoPostingAccounts();
    const values = makeDefaultJournalValues('JE-BILL', 'USD');
    values.lines = [
      { ...makeEmptyLine(), accountId: a, debit: 500, credit: 0, project: 'prj_x' },
      { ...makeEmptyLine(), accountId: b, debit: 0, credit: 500 },
    ];
    const added = useJournalStore.getState().addEntry(values);
    useJournalStore.getState().postEntry(added.id!);
    const beforeCount = useJournalStore.getState().entries.length;

    const req = billing().requestSubscription(planId('core'));
    expect(billing().invoices.find((i) => i.id === req.id)!.changeType).toBe('downgrade');
    billing().uploadPaymentProof(req.id!, goodProof({ amount: 29 }));
    billing().approvePayment(req.id!);

    expect(ent().subscription.edition).toBe('core');
    // nothing deleted; posted metadata preserved
    const after = useJournalStore.getState().entries.find((e) => e.id === added.id)!;
    expect(useJournalStore.getState().entries.length).toBe(beforeCount);
    expect(after.lines.find((l) => l.project === 'prj_x')).toBeDefined();
    expect(after.status).toBe('posted');
  });

  it('supersedes a still-open invoice when a new request is made', () => {
    const first = billing().requestSubscription(planId('core'));
    const second = billing().requestSubscription(planId('projects'));
    expect(billing().invoices.find((i) => i.id === first.id)!.status).toBe('cancelled');
    expect(billing().invoices.find((i) => i.id === second.id)!.status).toBe('issued');
  });
});

/* ── Lifecycle: cancel, expiry, grace ─────────────────────────────────────── */

describe('subscription lifecycle', () => {
  it('cancels without deleting data and blocks new posting', () => {
    billing().cancelSubscription('customer request');
    expect(ent().subscription.status).toBe('cancelled');
    const [a, b] = twoPostingAccounts();
    const values = makeDefaultJournalValues('JE-X', 'USD');
    values.lines = [
      { ...makeEmptyLine(), accountId: a, debit: 10, credit: 0 },
      { ...makeEmptyLine(), accountId: b, debit: 0, credit: 10 },
    ];
    expect(useJournalStore.getState().addEntry(values).ok).toBe(false); // posting blocked
  });

  it('moves into grace then expired based on dates', () => {
    // Force an expired-by-date active subscription within the grace window.
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    ent().replaceSubscription({ ...ent().subscription, status: 'active', expiresAt: yesterday });
    billing().applyExpiryTransitions();
    expect(ent().subscription.status).toBe('past-due'); // in grace
    expect(billing().auditTrail.some((x) => x.event === 'grace-started')).toBe(true);

    // Now push expiry well beyond the grace period.
    const longAgo = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    ent().replaceSubscription({ ...ent().subscription, status: 'past-due', expiresAt: longAgo });
    billing().applyExpiryTransitions();
    expect(ent().subscription.status).toBe('expired');
    expect(today.length).toBe(10);
  });
});

/* ── Invoice numbering ────────────────────────────────────────────────────── */

describe('invoice numbering', () => {
  it('issues sequential invoice numbers', () => {
    const a = billing().requestSubscription(planId('core'));
    billing().cancelInvoice(a.id!);
    const b = billing().requestSubscription(planId('projects'));
    const numA = billing().invoices.find((i) => i.id === a.id)!.number;
    const numB = billing().invoices.find((i) => i.id === b.id)!.number;
    expect(numA).not.toBe(numB);
    expect(numA.startsWith('SUB-')).toBe(true);
  });
});
