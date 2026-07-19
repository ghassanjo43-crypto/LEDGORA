// @vitest-environment happy-dom
/**
 * Bank-remittance payment reference: generation, storage on the invoice and
 * subscription, consistent instructions, placeholder-bank warning, and the
 * proof → verification → administrator-approval workflow.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  devPaymentReferenceService,
  generateDevelopmentReference,
  isValidPaymentReference,
  normalizePaymentReference,
  paymentReferenceMatches,
  PAYMENT_REFERENCE_PATTERN,
  type PaymentReferenceService,
} from '@/services/paymentReferenceService';
import { isPlaceholderBankConfig, patchLeavesPlaceholder } from '@/lib/bankDetails';
import { DEFAULT_BANK_DETAILS } from '@/lib/billingSeed';
import { DEVELOPMENT_BANK_WARNING } from '@/components/billing/DevelopmentBankWarning';
import { useBillingStore } from '@/store/billingStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useAuthStore } from '@/store/authStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import { subscriptionService } from '@/services';
import type { BankDetails } from '@/types/billing';

const REAL_BANK: BankDetails = {
  bankName: 'Emirates NBD',
  accountName: 'Ledgora Software FZ-LLC',
  accountNumber: '9988776655',
  iban: 'AE07 0331 2345 6789 0123 456',
  swift: 'EBILAEAD',
  branch: 'Business Bay',
  instructions: 'Quote the LEDGORA payment reference exactly as shown.',
};

function proofFile() {
  return {
    fileName: 'receipt.png',
    fileType: 'image/png',
    fileSize: 1024,
    dataUrl: 'data:image/png;base64,AAAA',
  };
}

beforeEach(() => {
  localStorage.clear();
  useBillingStore.getState().resetToDefault();
  useOrganizationStore.getState().resetToDefault();
  useEntitlementStore.getState().resetToDefault();
  useAuthStore.getState().resetToDefault();
  useAccountSessionStore.getState().resetToDefault();
  useMeteringConfigStore.getState().ensureSeeded();
  useBillingStore.getState().ensureSeeded();
  useSessionStore.setState({ platformRole: 'super-admin', userName: 'Platform Admin' });
});

/* ── Generation ──────────────────────────────────────────────────────────── */

describe('payment reference generation', () => {
  it('produces a well-formed LG-XXXX-XXXX reference', () => {
    for (let i = 0; i < 50; i += 1) {
      const ref = generateDevelopmentReference();
      expect(ref).toMatch(PAYMENT_REFERENCE_PATTERN);
      expect(isValidPaymentReference(ref)).toBe(true);
    }
  });

  it('never emits characters that can be misread when typed into a bank form', () => {
    const refs = Array.from({ length: 200 }, () => generateDevelopmentReference());
    // I, L, O and U are excluded from the alphabet.
    expect(refs.some((r) => /[ILOU]/.test(r.replace(/^LG-/, '')))).toBe(false);
  });

  it('avoids references the caller already holds', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const ref = generateDevelopmentReference((candidate) => taken.has(candidate));
      expect(taken.has(ref)).toBe(false);
      taken.add(ref);
    }
    expect(taken.size).toBe(200);
  });

  it('matches references case- and whitespace-insensitively', () => {
    expect(paymentReferenceMatches('  lg-ab12-cd34 ', 'LG-AB12-CD34')).toBe(true);
    expect(paymentReferenceMatches('LG-AB12-CD35', 'LG-AB12-CD34')).toBe(false);
    expect(paymentReferenceMatches('LG-AB12-CD34', undefined)).toBe(false);
    expect(normalizePaymentReference(' lg-ab12-cd34 ')).toBe('LG-AB12-CD34');
  });

  it('exposes an async service contract a backend implementation can replace', async () => {
    const devRef = await devPaymentReferenceService.createReference('inv-1', 'org-1');
    expect(devRef).toMatch(PAYMENT_REFERENCE_PATTERN);

    // A backend adapter is a drop-in: same interface, server-issued value.
    const backendAdapter: PaymentReferenceService = {
      async createReference(invoiceId, organizationId) {
        return `LG-SRV1-${invoiceId === 'inv-9' && organizationId === 'org-9' ? 'AAAA' : 'ZZZZ'}`;
      },
    };
    await expect(backendAdapter.createReference('inv-9', 'org-9')).resolves.toBe('LG-SRV1-AAAA');
  });
});

/* ── Storage on invoice + subscription ───────────────────────────────────── */

describe('paid subscription confirmation', () => {
  function confirmPaidSubscription(): void {
    useAuthStore.getState().upsertUser({
      id: 'usr-1',
      fullName: 'Jane Owner',
      email: 'jane@acme.test',
      mobile: '',
      country: 'AE',
      passwordHash: 'hash',
      emailVerified: true,
      role: 'owner',
      createdAt: new Date().toISOString(),
    });
    useAuthStore.setState({ currentUserId: 'usr-1' });
    useOrganizationStore.getState().createOrganization({
      legalName: 'Acme Holdings Ltd.',
      tradingName: 'Acme',
      country: 'AE',
      registrationNumber: '',
      taxNumber: '',
      industry: 'general',
      baseCurrency: 'USD',
      fiscalYearStart: '01-01',
      booksStartDate: '2026-01-01',
    });
    const planCode = useMeteringConfigStore.getState().config.basePlans.find((p) => p.isActive)!.code;
    useOrganizationStore.getState().saveDraftSubscription({
      basePlanCode: planCode,
      addOnModuleCodes: [],
      extraUsers: 0,
      extraCompanies: 0,
    });
    useOrganizationStore.getState().confirmSubscription();
  }

  it('issues a payment reference and stores it on both the invoice and the subscription', () => {
    confirmPaidSubscription();
    const { subscription, invoices } = useOrganizationStore.getState();
    const invoice = invoices.find((i) => i.id === subscription!.invoiceId)!;

    expect(invoice.paymentReference).toMatch(PAYMENT_REFERENCE_PATTERN);
    expect(subscription!.paymentReference).toBe(invoice.paymentReference);
    expect(subscription!.status).toBe('pending_payment');
  });

  it('issues a distinct reference for each invoice', () => {
    const references = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      useBillingStore.getState().requestSubscription(useBillingStore.getState().plans[0]!.id);
      const invoices = useBillingStore.getState().invoices;
      references.add(invoices[invoices.length - 1]!.paymentReference);
    }
    expect(references.size).toBe(5);
    for (const ref of references) expect(ref).toMatch(PAYMENT_REFERENCE_PATTERN);
  });

  it('records the reference on the in-app billing invoice too', () => {
    const plan = useBillingStore.getState().plans[0]!;
    const res = useBillingStore.getState().requestSubscription(plan.id);
    const invoice = useBillingStore.getState().invoices.find((i) => i.id === res.id)!;
    expect(invoice.paymentReference).toMatch(PAYMENT_REFERENCE_PATTERN);
    // The invoice number is a separate, human-facing document identifier.
    expect(invoice.paymentReference).not.toBe(invoice.number);
  });

  it('creates no invoice, reference or payment requirement for the Free Demo', async () => {
    await subscriptionService.startFreeDemo();
    expect(useOrganizationStore.getState().subscription).toBeNull();
    expect(useOrganizationStore.getState().invoices).toHaveLength(0);
    expect(useBillingStore.getState().invoices).toHaveLength(0);
    expect(useAccountSessionStore.getState().demoActive).toBe(true);
  });
});

/* ── Instructions consistency ────────────────────────────────────────────── */

describe('payment instructions', () => {
  it('tells the customer to quote the LEDGORA payment reference, not the invoice number', () => {
    const instructions = DEFAULT_BANK_DETAILS.instructions;
    expect(instructions).toContain('LEDGORA payment reference');
    expect(instructions).not.toMatch(/quote the invoice number/i);
    expect(useBillingStore.getState().settings.bank.instructions).toBe(instructions);
  });

  it('freezes the instructions onto the issued invoice', () => {
    const plan = useBillingStore.getState().plans[0]!;
    const res = useBillingStore.getState().requestSubscription(plan.id);
    const invoice = useBillingStore.getState().invoices.find((i) => i.id === res.id)!;
    expect(invoice.bankSnapshot.instructions).toContain('LEDGORA payment reference');
  });
});

/* ── Placeholder bank detection ──────────────────────────────────────────── */

describe('development bank warning', () => {
  it('treats the shipped defaults as placeholders', () => {
    expect(DEFAULT_BANK_DETAILS.isPlaceholder).toBe(true);
    expect(isPlaceholderBankConfig(DEFAULT_BANK_DETAILS)).toBe(true);
    expect(isPlaceholderBankConfig(useBillingStore.getState().settings.bank)).toBe(true);
    expect(DEVELOPMENT_BANK_WARNING).toContain('Do not transfer real money');
  });

  it('stops warning once real bank details are configured', () => {
    useBillingStore.getState().updateBankDetails(REAL_BANK);
    const bank = useBillingStore.getState().settings.bank;
    expect(bank.isPlaceholder).toBe(false);
    expect(isPlaceholderBankConfig(bank)).toBe(false);
  });

  it('keeps warning when only a cosmetic field is edited', () => {
    useBillingStore.getState().updateBankDetails({ branch: 'Marina Branch' });
    expect(isPlaceholderBankConfig(useBillingStore.getState().settings.bank)).toBe(true);
  });

  it('classifies legacy settings that predate the flag by their content', () => {
    const legacyPlaceholder = { ...DEFAULT_BANK_DETAILS, isPlaceholder: undefined };
    expect(isPlaceholderBankConfig(legacyPlaceholder)).toBe(true);
    expect(isPlaceholderBankConfig({ ...REAL_BANK, isPlaceholder: undefined })).toBe(false);
    expect(isPlaceholderBankConfig(null)).toBe(true);
    expect(patchLeavesPlaceholder(DEFAULT_BANK_DETAILS, REAL_BANK)).toBe(false);
  });
});

/* ── Proof → verification → approval ─────────────────────────────────────── */

describe('payment proof workflow', () => {
  function issueInvoice(): string {
    const plan = useBillingStore.getState().plans[0]!;
    return useBillingStore.getState().requestSubscription(plan.id).id!;
  }

  it('moves the invoice to pending verification without activating anything', () => {
    const invoiceId = issueInvoice();
    const invoice = useBillingStore.getState().invoices.find((i) => i.id === invoiceId)!;
    const statusBefore = useEntitlementStore.getState().subscription.status;

    const res = useBillingStore.getState().uploadPaymentProof(invoiceId, {
      ...proofFile(),
      reference: invoice.paymentReference,
      amount: invoice.amount,
      paidAt: '2026-07-19',
    });
    expect(res.ok).toBe(true);

    const after = useBillingStore.getState().invoices.find((i) => i.id === invoiceId)!;
    expect(after.status).toBe('proof-submitted');
    // Uploading a proof must never activate the subscription or entitlements.
    expect(after.verifiedAt).toBeUndefined();
    expect(useEntitlementStore.getState().subscription.status).toBe(statusBefore);
  });

  it('records whether the quoted reference matched, and keeps both references', () => {
    const invoiceId = issueInvoice();
    const invoice = useBillingStore.getState().invoices.find((i) => i.id === invoiceId)!;

    useBillingStore.getState().uploadPaymentProof(invoiceId, {
      ...proofFile(),
      reference: invoice.paymentReference.toLowerCase(),
      bankTransactionReference: 'TT-2026-00184',
      amount: invoice.amount,
      paidAt: '2026-07-19',
    });
    const matched = useBillingStore.getState().invoices.find((i) => i.id === invoiceId)!.proofs.at(-1)!;
    expect(matched.matchesInvoiceReference).toBe(true);
    expect(matched.bankTransactionReference).toBe('TT-2026-00184');

    const second = issueInvoice();
    useBillingStore.getState().uploadPaymentProof(second, {
      ...proofFile(),
      reference: 'LG-XXXX-YYYY',
      amount: 10,
      paidAt: '2026-07-19',
    });
    const mismatched = useBillingStore.getState().invoices.find((i) => i.id === second)!.proofs.at(-1)!;
    // A mismatch is flagged for the reviewer but never blocks the upload.
    expect(mismatched.matchesInvoiceReference).toBe(false);
  });

  it('lets only an authorized administrator approve the payment', () => {
    const invoiceId = issueInvoice();
    const invoice = useBillingStore.getState().invoices.find((i) => i.id === invoiceId)!;
    useBillingStore.getState().uploadPaymentProof(invoiceId, {
      ...proofFile(),
      reference: invoice.paymentReference,
      amount: invoice.amount,
      paidAt: '2026-07-19',
    });

    useSessionStore.setState({ platformRole: 'none' });
    const denied = useBillingStore.getState().approvePayment(invoiceId);
    expect(denied.ok).toBe(false);
    expect(useBillingStore.getState().invoices.find((i) => i.id === invoiceId)!.status).toBe('proof-submitted');

    useSessionStore.setState({ platformRole: 'super-admin' });
    const approved = useBillingStore.getState().approvePayment(invoiceId);
    expect(approved.ok).toBe(true);
    expect(useBillingStore.getState().invoices.find((i) => i.id === invoiceId)!.status).toBe('approved');
    // Approval — and only approval — activates the subscription.
    expect(useEntitlementStore.getState().subscription.status).toBe('active');
  });
});
