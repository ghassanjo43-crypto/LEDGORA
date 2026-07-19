/**
 * Organization onboarding + subscription lifecycle store.
 *
 * Owns the subscriber organization, its single subscription (draft →
 * pending_payment → pending_verification → active/expired/suspended/rejected),
 * the subscription invoice with a unique payment reference, uploaded payment
 * proofs and the administrator review flow. Approval drives the entitlement
 * store (the runtime access source of truth) and the metering config (active
 * plan + modules). Nothing here deletes accounting data — lifecycle only gates
 * access for NEW activity.
 *
 * Persisted under a NEW key `ledgora-organization`.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  BankInstructions,
  Organization,
  OnboardingAuditEntry,
  OnboardingAuditEvent,
  OnboardingInvoice,
  OnboardingPaymentProof,
  OnboardingSubscription,
} from '@/types/onboarding';
import type { OrganizationSubscription } from '@/types/subscription';
import { priceSubscription, type SubscriptionCart } from '@/lib/onboardingPricing';
import { resolveEntitlementActivation } from '@/lib/accessControl';
import { mockHashPassword } from '@/lib/onboardingData';
import {
  generateDevelopmentReference,
  paymentReferenceMatches,
} from '@/services/paymentReferenceService';
import { useMeteringConfigStore } from './meteringConfigStore';
import { useEntitlementStore } from './entitlementStore';
import { useBillingStore } from './billingStore';
import { useAuthStore, getCurrentUser } from './authStore';
import { getPlatformRole, getCurrentUserName } from './sessionStore';
import { assertCanVerifyPayments } from '@/lib/billingPermissions';
import { isPlaceholderBankConfig } from '@/lib/bankDetails';
import { useStore } from './useStore';
import { generateId, nowIso } from '@/lib/utils';

export interface OrgActionResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  id?: string;
}

export interface CreateOrganizationInput {
  legalName: string;
  tradingName: string;
  country: string;
  registrationNumber: string;
  taxNumber: string;
  industry: string;
  baseCurrency: string;
  fiscalYearStart: string;
  booksStartDate: string;
}

interface OrganizationState {
  organization: Organization | null;
  subscription: OnboardingSubscription | null;
  invoices: OnboardingInvoice[];
  auditTrail: OnboardingAuditEntry[];

  createOrganization: (input: CreateOrganizationInput) => OrgActionResult;
  saveDraftSubscription: (cart: SubscriptionCart) => OrgActionResult;
  confirmSubscription: () => OrgActionResult;
  uploadPaymentProof: (input: ProofInput) => OrgActionResult;

  /* Administrator review (platform super-admin) */
  approvePayment: (invoiceId: string) => OrgActionResult;
  rejectPayment: (invoiceId: string, reason: string) => OrgActionResult;
  requestMoreInfo: (invoiceId: string, note: string) => OrgActionResult;

  /* Lifecycle */
  applyLifecycleTransitions: () => void;
  suspendSubscription: (reason: string) => OrgActionResult;

  /** Dev-only: provision a verified owner + org + active subscription so an
   * existing install boots straight into the app. No-op once any user exists. */
  ensureBootstrapped: () => void;
  resetToDefault: () => void;
}

export interface ProofInput {
  fileName: string;
  fileType: string;
  fileSize: number;
  dataUrl: string;
  /** The LEDGORA payment reference (`LG-XXXX-XXXX`) quoted on the transfer. */
  reference: string;
  /** The bank's own transaction/reference number, when the customer has one. */
  bankTransactionReference?: string;
  amount: number;
  paidAt: string;
  note?: string;
}

function actorName(): string {
  return getCurrentUser()?.fullName ?? getCurrentUserName();
}

function audit(
  event: OnboardingAuditEvent,
  detail: string,
  extra?: { organizationId?: string; invoiceId?: string },
): OnboardingAuditEntry {
  return { id: generateId('oau'), event, at: nowIso(), actor: actorName(), detail, ...extra };
}

function bankFromBilling(): BankInstructions {
  const bank = useBillingStore.getState().settings.bank;
  return {
    bankName: bank.bankName,
    accountName: bank.accountName,
    accountNumber: bank.accountNumber,
    iban: bank.iban,
    swift: bank.swift,
    branch: bank.branch,
    instructions: bank.instructions,
    // Carry the placeholder flag onto the frozen snapshot so the development
    // warning stays accurate for invoices issued before real details existed.
    isPlaceholder: isPlaceholderBankConfig(bank),
  };
}

/**
 * Unique payment reference across all issued invoices.
 *
 * BACKEND SEAM: production references are generated server-side inside the
 * invoice-creation transaction, with a UNIQUE database constraint as the real
 * guarantee — this local scan only covers invoices this browser knows about.
 * @see services/paymentReferenceService
 */
function uniquePaymentReference(existing: OnboardingInvoice[]): string {
  const used = new Set(existing.map((i) => i.paymentReference));
  return generateDevelopmentReference((ref) => used.has(ref));
}

function nextInvoiceNumber(existing: OnboardingInvoice[]): string {
  const year = new Date().getUTCFullYear();
  const seq = existing.length + 1;
  return `LG-${year}-${String(seq).padStart(5, '0')}`;
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

export const useOrganizationStore = create<OrganizationState>()(
  persist(
    (set, get) => ({
      organization: null,
      subscription: null,
      invoices: [],
      auditTrail: [],

      /* ── Organization creation (owner) ─────────────────────────────────── */
      createOrganization: (input) => {
        const fieldErrors: Record<string, string> = {};
        const legalName = input.legalName.trim();
        if (!legalName) fieldErrors.legalName = 'Legal name is required.';
        if (!input.country) fieldErrors.country = 'Select a country.';
        if (!input.industry) fieldErrors.industry = 'Select an industry.';
        if (!input.baseCurrency) fieldErrors.baseCurrency = 'Select a base currency.';
        if (!input.fiscalYearStart) fieldErrors.fiscalYearStart = 'Select a financial-year start.';
        if (Object.keys(fieldErrors).length > 0) {
          return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors };
        }
        const user = getCurrentUser();
        if (!user) return { ok: false, error: 'You must be signed in to create an organization.' };
        if (!user.emailVerified) return { ok: false, error: 'Verify your email before onboarding.' };

        const org: Organization = {
          id: generateId('org'),
          ownerUserId: user.id,
          legalName,
          tradingName: input.tradingName.trim(),
          country: input.country,
          registrationNumber: input.registrationNumber.trim(),
          taxNumber: input.taxNumber.trim(),
          industry: input.industry,
          baseCurrency: input.baseCurrency,
          fiscalYearStart: input.fiscalYearStart,
          booksStartDate: input.booksStartDate,
          createdAt: nowIso(),
        };
        useAuthStore.getState().attachOrganization(org.id, 'owner');
        // Seed the primary company profile for the accounting engine.
        useStore.getState().updateSettings({
          companyName: org.legalName,
          tradingName: org.tradingName,
          industryType: org.industry,
          registrationNumber: org.registrationNumber,
          taxRegistrationNumber: org.taxNumber,
          taxRegistered: Boolean(org.taxNumber),
          country: org.country,
          baseCurrency: org.baseCurrency,
          fiscalYearStart: org.fiscalYearStart,
          booksStartDate: org.booksStartDate,
        });
        set((s) => ({
          organization: org,
          auditTrail: [...s.auditTrail, audit('organization-created', `Organization "${org.legalName}" created; ${user.fullName} set as owner.`, { organizationId: org.id })],
        }));
        return { ok: true, id: org.id };
      },

      /* ── Draft subscription (cart) ─────────────────────────────────────── */
      saveDraftSubscription: (cart) => {
        const org = get().organization;
        if (!org) return { ok: false, error: 'Create your organization first.' };
        const config = useMeteringConfigStore.getState().config;
        const pricing = priceSubscription(config, cart);
        if (!config.basePlans.some((p) => p.code === cart.basePlanCode && p.isActive)) {
          return { ok: false, error: 'Select a valid base plan.' };
        }
        const existing = get().subscription;
        const now = nowIso();
        const sub: OnboardingSubscription = {
          id: existing?.id ?? generateId('sub'),
          organizationId: org.id,
          status: 'draft',
          basePlanCode: cart.basePlanCode,
          addOnModuleCodes: [...new Set(cart.addOnModuleCodes)],
          extraUsers: Math.max(0, Math.floor(cart.extraUsers)),
          extraCompanies: Math.max(0, Math.floor(cart.extraCompanies)),
          currency: pricing.currency,
          monthlyTotal: pricing.monthlyTotal,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        set((s) => ({
          subscription: sub,
          auditTrail: [...s.auditTrail, audit('subscription-drafted', `Draft subscription: ${cart.basePlanCode} at ${pricing.currency} ${pricing.monthlyTotal}/mo.`, { organizationId: org.id })],
        }));
        return { ok: true, id: sub.id };
      },

      /* ── Confirm → invoice + payment reference + bank instructions ─────── */
      confirmSubscription: () => {
        const org = get().organization;
        const sub = get().subscription;
        if (!org || !sub) return { ok: false, error: 'Nothing to confirm yet.' };
        const config = useMeteringConfigStore.getState().config;
        const pricing = priceSubscription(config, sub);

        const paymentReference = uniquePaymentReference(get().invoices);
        const now = new Date();
        const settings = useBillingStore.getState().settings;
        const dueAt = new Date(now.getTime() + settings.paymentDueDays * 86_400_000);
        const invoice: OnboardingInvoice = {
          id: generateId('oinv'),
          number: nextInvoiceNumber(get().invoices),
          organizationId: org.id,
          subscriptionId: sub.id,
          status: 'issued',
          currency: pricing.currency,
          lines: pricing.lines,
          total: pricing.monthlyTotal,
          paymentReference,
          bank: bankFromBilling(),
          issuedAt: nowIso(),
          dueAt: dueAt.toISOString(),
          proofs: [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        set((s) => ({
          invoices: [...s.invoices, invoice],
          subscription: {
            ...sub,
            status: 'pending_payment',
            monthlyTotal: pricing.monthlyTotal,
            invoiceId: invoice.id,
            paymentReference,
            updatedAt: nowIso(),
          },
          auditTrail: [
            ...s.auditTrail,
            audit('subscription-confirmed', `Subscription confirmed; awaiting payment (ref ${paymentReference}).`, { organizationId: org.id, invoiceId: invoice.id }),
            audit('invoice-issued', `Invoice ${invoice.number} issued for ${pricing.currency} ${pricing.monthlyTotal}.`, { organizationId: org.id, invoiceId: invoice.id }),
          ],
        }));
        return { ok: true, id: invoice.id };
      },

      /* ── Payment proof upload → pending_verification ───────────────────── */
      uploadPaymentProof: (input) => {
        const sub = get().subscription;
        if (!sub?.invoiceId) return { ok: false, error: 'No invoice to pay yet.' };
        const invoice = get().invoices.find((i) => i.id === sub.invoiceId);
        if (!invoice) return { ok: false, error: 'Invoice not found.' };
        if (invoice.status === 'paid') return { ok: false, error: 'This invoice is already paid.' };
        const fieldErrors: Record<string, string> = {};
        if (!input.fileName) fieldErrors.file = 'Attach a proof of payment.';
        if (!input.reference.trim()) fieldErrors.reference = 'Enter the LEDGORA payment reference you quoted.';
        if (!(input.amount > 0)) fieldErrors.amount = 'Enter the amount paid.';
        if (!input.paidAt) fieldErrors.paidAt = 'Enter the payment date.';
        if (Object.keys(fieldErrors).length > 0) {
          return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors };
        }

        const proof: OnboardingPaymentProof = {
          id: generateId('prf'),
          fileName: input.fileName,
          fileType: input.fileType,
          fileSize: input.fileSize,
          dataUrl: input.dataUrl,
          reference: input.reference.trim(),
          bankTransactionReference: input.bankTransactionReference?.trim() || undefined,
          // Recorded for the reviewing administrator. A mismatch is surfaced as
          // a warning; it neither blocks the upload nor decides the outcome.
          matchesInvoiceReference: paymentReferenceMatches(input.reference, invoice.paymentReference),
          amount: input.amount,
          paidAt: input.paidAt,
          note: input.note?.trim(),
          uploadedAt: nowIso(),
          uploadedBy: actorName(),
        };
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === invoice.id
              ? { ...i, proofs: [...i.proofs, proof], currentProofId: proof.id, status: 'proof-submitted', rejectionReason: undefined, infoRequest: undefined, updatedAt: nowIso() }
              : i,
          ),
          subscription: { ...sub, status: 'pending_verification', updatedAt: nowIso() },
          auditTrail: [...s.auditTrail, audit('proof-uploaded', `Payment proof uploaded for ${invoice.number} (ref ${proof.reference}).`, { organizationId: sub.organizationId, invoiceId: invoice.id })],
        }));
        return { ok: true, id: proof.id };
      },

      /* ── Administrator approval → activation ───────────────────────────── */
      approvePayment: (invoiceId) => {
        const perm = assertCanVerifyPayments(getPlatformRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        const invoice = get().invoices.find((i) => i.id === invoiceId);
        if (!invoice) return { ok: false, error: 'Invoice not found.' };
        if (invoice.status !== 'proof-submitted') {
          return { ok: false, error: 'Only an invoice with a submitted proof can be approved.' };
        }
        const sub = get().subscription;
        if (!sub || sub.id !== invoice.subscriptionId) return { ok: false, error: 'Subscription mismatch.' };

        const config = useMeteringConfigStore.getState().config;
        const plan = config.basePlans.find((p) => p.code === sub.basePlanCode);
        const settings = useBillingStore.getState().settings;

        const start = new Date();
        const expiry = addMonths(start, settings.termMonths);
        const startsAt = start.toISOString();
        const expiresAt = expiry.toISOString();
        // Renewal notice date = expiry minus the grace window.
        const renewsAt = new Date(expiry.getTime() - settings.graceDays * 86_400_000).toISOString();

        // 1) Enable entitlements (runtime access source of truth).
        const activation = resolveEntitlementActivation({
          baseUsers: plan?.allowances.users ?? 1,
          baseCompanies: plan?.allowances.companies ?? 1,
          addOnModuleCodes: sub.addOnModuleCodes,
          extraUsers: sub.extraUsers,
          extraCompanies: sub.extraCompanies,
        });
        const entitlement = useEntitlementStore.getState();
        const nextEnt: OrganizationSubscription = {
          ...entitlement.subscription,
          organizationId: sub.organizationId,
          edition: activation.edition,
          status: 'active',
          enabledModules: activation.enabledModules,
          disabledModules: [],
          userLimit: activation.userLimit,
          entityLimit: activation.entityLimit,
          // Entitlement dates use the yyyy-mm-dd convention the billing lifecycle
          // helpers expect (grace/expiry math parses them as plain days).
          startsAt: startsAt.slice(0, 10),
          expiresAt: expiresAt.slice(0, 10),
          activationMethod: 'bank-remittance',
          bankRemittanceReference: invoice.paymentReference,
          activatedAt: startsAt,
          suspendedAt: undefined,
          updatedAt: nowIso(),
        };
        entitlement.replaceSubscription(nextEnt);

        // 2) Point metering at the purchased plan + modules.
        if (plan) useMeteringConfigStore.getState().setActiveBasePlan(plan.id);
        useMeteringConfigStore.getState().setActiveModules(sub.addOnModuleCodes);

        const admin = getCurrentUserName();
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === invoiceId ? { ...i, status: 'paid', paidAt: nowIso(), verifiedBy: admin, verifiedAt: nowIso(), updatedAt: nowIso() } : i,
          ),
          subscription: { ...sub, status: 'active', startsAt, expiresAt, renewsAt, updatedAt: nowIso() },
          auditTrail: [
            ...s.auditTrail,
            audit('payment-approved', `Payment for ${invoice.number} verified by ${admin}.`, { organizationId: sub.organizationId, invoiceId }),
            audit('subscription-activated', `Subscription activated ${startsAt.slice(0, 10)} → ${expiresAt.slice(0, 10)}.`, { organizationId: sub.organizationId, invoiceId }),
            // Activation email is a seam — a real backend sends the mail here.
            audit('activation-email-sent', `Activation email sent to the organization owner.`, { organizationId: sub.organizationId, invoiceId }),
          ],
        }));
        return { ok: true, id: invoiceId };
      },

      rejectPayment: (invoiceId, reason) => {
        const perm = assertCanVerifyPayments(getPlatformRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        const invoice = get().invoices.find((i) => i.id === invoiceId);
        if (!invoice) return { ok: false, error: 'Invoice not found.' };
        if (invoice.status !== 'proof-submitted') return { ok: false, error: 'Only a submitted proof can be rejected.' };
        if (!reason.trim()) return { ok: false, error: 'A rejection reason is required.' };
        const sub = get().subscription;
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === invoiceId ? { ...i, status: 'rejected', rejectionReason: reason.trim(), updatedAt: nowIso() } : i,
          ),
          subscription: sub && sub.id === invoice.subscriptionId ? { ...sub, status: 'rejected', updatedAt: nowIso() } : sub,
          auditTrail: [...s.auditTrail, audit('payment-rejected', `Payment for ${invoice.number} rejected: ${reason.trim()}.`, { organizationId: invoice.organizationId, invoiceId })],
        }));
        return { ok: true };
      },

      requestMoreInfo: (invoiceId, note) => {
        const perm = assertCanVerifyPayments(getPlatformRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        const invoice = get().invoices.find((i) => i.id === invoiceId);
        if (!invoice) return { ok: false, error: 'Invoice not found.' };
        if (!note.trim()) return { ok: false, error: 'Enter the information you need from the customer.' };
        set((s) => ({
          invoices: s.invoices.map((i) => (i.id === invoiceId ? { ...i, infoRequest: note.trim(), updatedAt: nowIso() } : i)),
          auditTrail: [...s.auditTrail, audit('info-requested', `Additional information requested for ${invoice.number}: ${note.trim()}.`, { organizationId: invoice.organizationId, invoiceId })],
        }));
        return { ok: true };
      },

      /* ── Lifecycle ─────────────────────────────────────────────────────── */
      applyLifecycleTransitions: () => {
        const sub = get().subscription;
        if (!sub || sub.status !== 'active' || !sub.expiresAt) return;
        if (new Date(sub.expiresAt).getTime() < Date.now()) {
          useEntitlementStore.getState().setSubscriptionStatus('expired');
          set((s) => ({
            subscription: s.subscription ? { ...s.subscription, status: 'expired', updatedAt: nowIso() } : s.subscription,
            auditTrail: [...s.auditTrail, audit('subscription-expired', `Subscription expired after ${sub.expiresAt?.slice(0, 10)}.`, { organizationId: sub.organizationId })],
          }));
        }
      },

      suspendSubscription: (reason) => {
        const perm = assertCanVerifyPayments(getPlatformRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        const sub = get().subscription;
        if (!sub) return { ok: false, error: 'No subscription to suspend.' };
        useEntitlementStore.getState().suspendSubscription(reason);
        set((s) => ({
          subscription: s.subscription ? { ...s.subscription, status: 'suspended', updatedAt: nowIso() } : s.subscription,
          auditTrail: [...s.auditTrail, audit('subscription-suspended', reason ? `Suspended: ${reason}.` : 'Subscription suspended.', { organizationId: sub.organizationId })],
        }));
        return { ok: true };
      },

      /* ── Dev bootstrap ─────────────────────────────────────────────────── */
      ensureBootstrapped: () => {
        // Repair a previously-seeded demo owner that had a placeholder hash, so
        // the published demo credentials (Demo1234) always work.
        const authState = useAuthStore.getState();
        const demo = authState.users.find((u) => u.email === 'owner@demo.ledgora.app' && u.passwordHash === 'mh1$dev');
        if (demo) authState.upsertUser({ ...demo, passwordHash: mockHashPassword('Demo1234') });

        if (get().organization) {
          get().applyLifecycleTransitions();
          return;
        }
        const auth = useAuthStore.getState();
        if (auth.users.length > 0) return; // real accounts exist — never fabricate

        const now = nowIso();
        const userId = generateId('usr');
        const settings = useStore.getState().settings;
        auth.upsertUser({
          id: userId,
          fullName: getCurrentUserName(),
          email: 'owner@demo.ledgora.app',
          mobile: '+10000000000',
          country: settings.country || 'AE',
          // Known demo credentials so you can sign back in after logging out.
          passwordHash: mockHashPassword('Demo1234'),
          emailVerified: true,
          role: 'owner',
          createdAt: now,
        });
        useAuthStore.setState({ currentUserId: userId });

        const orgId = generateId('org');
        const org: Organization = {
          id: orgId,
          ownerUserId: userId,
          legalName: settings.companyName || 'Demo Organization',
          tradingName: settings.tradingName || '',
          country: settings.country || 'AE',
          registrationNumber: settings.registrationNumber || '',
          taxNumber: settings.taxRegistrationNumber || '',
          industry: settings.industryType || 'general',
          baseCurrency: settings.baseCurrency || 'USD',
          fiscalYearStart: settings.fiscalYearStart || '01-01',
          booksStartDate: settings.booksStartDate || `${new Date().getFullYear()}-01-01`,
          createdAt: now,
        };
        useAuthStore.getState().attachOrganization(orgId, 'owner');
        // Leave the existing (dev Enterprise) entitlement untouched so no module
        // disappears; just record an active subscription for the funnel.
        const sub: OnboardingSubscription = {
          id: generateId('sub'),
          organizationId: orgId,
          status: 'active',
          basePlanCode: 'business',
          addOnModuleCodes: [],
          extraUsers: 0,
          extraCompanies: 0,
          currency: 'USD',
          monthlyTotal: 179,
          startsAt: now,
          expiresAt: addMonths(new Date(), 12).toISOString(),
          createdAt: now,
          updatedAt: now,
        };
        set({ organization: org, subscription: sub, invoices: [], auditTrail: [] });
      },

      resetToDefault: () => set({ organization: null, subscription: null, invoices: [], auditTrail: [] }),
    }),
    {
      name: 'ledgora-organization',
      version: 1,
      partialize: (s) => ({
        organization: s.organization,
        subscription: s.subscription,
        invoices: s.invoices,
        auditTrail: s.auditTrail,
      }),
    },
  ),
);

/** The current org's active invoice (referenced by the subscription). */
export function getActiveInvoice(): OnboardingInvoice | null {
  const { subscription, invoices } = useOrganizationStore.getState();
  if (!subscription?.invoiceId) return null;
  return invoices.find((i) => i.id === subscription.invoiceId) ?? null;
}
