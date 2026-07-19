import { describe, it, expect, beforeEach } from 'vitest';
import { useOrganizationStore, getActiveInvoice } from './organizationStore';
import { useAuthStore } from './authStore';
import { useBillingStore } from './billingStore';
import { useMeteringConfigStore } from './meteringConfigStore';
import { useEntitlementStore } from './entitlementStore';
import { useSessionStore } from './sessionStore';

const org = () => useOrganizationStore.getState();

function registerVerifiedOwner(): void {
  const reg = useAuthStore.getState().register({
    fullName: 'Jane Owner',
    email: 'owner@acme.test',
    mobile: '+971500000000',
    country: 'AE',
    password: 'Secret123',
    acceptedTerms: true,
  });
  useAuthStore.getState().verifyEmail(reg.verificationToken!);
}

const orgInput = {
  legalName: 'Acme Holdings Ltd.',
  tradingName: 'Acme',
  country: 'AE',
  registrationNumber: 'CR-1',
  taxNumber: 'TRN-9',
  industry: 'general',
  baseCurrency: 'USD',
  fiscalYearStart: '01-01',
  booksStartDate: '2026-01-01',
};

beforeEach(() => {
  useAuthStore.getState().resetToDefault();
  useOrganizationStore.getState().resetToDefault();
  useBillingStore.getState().ensureSeeded();
  useMeteringConfigStore.getState().resetToDefault();
  useEntitlementStore.getState().resetToDefault();
  useSessionStore.setState({ platformRole: 'super-admin', userName: 'Platform Admin' });
});

describe('organization creation', () => {
  it('requires a signed-in verified owner and validates input', () => {
    // no user yet
    expect(org().createOrganization(orgInput).ok).toBe(false);
    registerVerifiedOwner();
    expect(org().createOrganization({ ...orgInput, legalName: '' }).ok).toBe(false);
    const res = org().createOrganization(orgInput);
    expect(res.ok).toBe(true);
    expect(org().organization?.legalName).toBe('Acme Holdings Ltd.');
    // owner is linked to the org
    const user = useAuthStore.getState().users[0]!;
    expect(user.organizationId).toBe(org().organization!.id);
    expect(user.role).toBe('owner');
  });
});

describe('subscription lifecycle', () => {
  beforeEach(() => {
    registerVerifiedOwner();
    org().createOrganization(orgInput);
  });

  it('drafts, confirms (invoice + unique payment reference), then pending_verification on proof', () => {
    const draft = org().saveDraftSubscription({ basePlanCode: 'professional', addOnModuleCodes: ['projects'], extraUsers: 1, extraCompanies: 0 });
    expect(draft.ok).toBe(true);
    expect(org().subscription?.status).toBe('draft');
    // professional 89 + projects 29 + 1 user * 6
    expect(org().subscription?.monthlyTotal).toBe(89 + 29 + 6);

    const conf = org().confirmSubscription();
    expect(conf.ok).toBe(true);
    expect(org().subscription?.status).toBe('pending_payment');
    const invoice = getActiveInvoice()!;
    expect(invoice.paymentReference).toMatch(/^LG-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(org().subscription?.paymentReference).toBe(invoice.paymentReference);
    expect(invoice.bank.bankName).toBeTruthy(); // bank snapshot frozen from billing settings

    const proof = org().uploadPaymentProof({
      fileName: 'transfer.pdf',
      fileType: 'application/pdf',
      fileSize: 1000,
      dataUrl: 'data:application/pdf;base64,AAAA',
      reference: invoice.paymentReference,
      amount: invoice.total,
      paidAt: '2026-07-14',
    });
    expect(proof.ok).toBe(true);
    expect(org().subscription?.status).toBe('pending_verification');
    expect(getActiveInvoice()!.status).toBe('proof-submitted');
  });

  it('approval verifies payment, marks the invoice paid, activates the subscription with dates + entitlements, and audits it', () => {
    org().saveDraftSubscription({ basePlanCode: 'business', addOnModuleCodes: ['construction'], extraUsers: 5, extraCompanies: 2 });
    org().confirmSubscription();
    const invoiceId = org().subscription!.invoiceId!;
    org().uploadPaymentProof({ fileName: 'p.pdf', fileType: 'application/pdf', fileSize: 10, dataUrl: 'data:,x', reference: 'X', amount: 1, paidAt: '2026-07-14' });

    const res = org().approvePayment(invoiceId);
    expect(res.ok).toBe(true);

    const sub = org().subscription!;
    expect(sub.status).toBe('active');
    expect(sub.startsAt).toBeTruthy();
    expect(sub.expiresAt).toBeTruthy();
    expect(new Date(sub.expiresAt!).getTime()).toBeGreaterThan(new Date(sub.startsAt!).getTime());

    const invoice = useOrganizationStore.getState().invoices.find((i) => i.id === invoiceId)!;
    expect(invoice.status).toBe('paid');
    expect(invoice.verifiedBy).toBe('Platform Admin');

    // entitlements enabled: construction add-on + limits from business allowance + extras
    const ent = useEntitlementStore.getState();
    expect(ent.subscription.status).toBe('active');
    expect(ent.hasModule('construction_projects')).toBe(true);
    expect(ent.subscription.userLimit).toBe(25 + 5); // business users + extra
    expect(ent.subscription.entityLimit).toBe(10 + 2);

    // audit trail records approval, activation and the activation email seam
    const events = useOrganizationStore.getState().auditTrail.map((a) => a.event);
    expect(events).toContain('payment-approved');
    expect(events).toContain('subscription-activated');
    expect(events).toContain('activation-email-sent');
  });

  it('lets an administrator reject a proof, moving the subscription to rejected', () => {
    org().saveDraftSubscription({ basePlanCode: 'core', addOnModuleCodes: [], extraUsers: 0, extraCompanies: 0 });
    org().confirmSubscription();
    const invoiceId = org().subscription!.invoiceId!;
    org().uploadPaymentProof({ fileName: 'p.pdf', fileType: 'application/pdf', fileSize: 10, dataUrl: 'data:,x', reference: 'X', amount: 1, paidAt: '2026-07-14' });
    const res = org().rejectPayment(invoiceId, 'Amount does not match');
    expect(res.ok).toBe(true);
    expect(org().subscription?.status).toBe('rejected');
  });

  it('blocks a non-admin from approving payments', () => {
    org().saveDraftSubscription({ basePlanCode: 'core', addOnModuleCodes: [], extraUsers: 0, extraCompanies: 0 });
    org().confirmSubscription();
    const invoiceId = org().subscription!.invoiceId!;
    org().uploadPaymentProof({ fileName: 'p.pdf', fileType: 'application/pdf', fileSize: 10, dataUrl: 'data:,x', reference: 'X', amount: 1, paidAt: '2026-07-14' });
    useSessionStore.setState({ platformRole: 'none' });
    expect(org().approvePayment(invoiceId).ok).toBe(false);
    expect(org().subscription?.status).toBe('pending_verification');
  });
});
