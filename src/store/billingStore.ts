/**
 * Organization subscription & package-management store.
 *
 * Owns the data-driven plans, editable bank details / billing settings,
 * subscription invoices and manual bank-remittance payment proofs. It drives
 * the entitlement store (the single source of truth for access) when a payment
 * is approved. Nothing here deletes historical data: downgrades and expiry only
 * change which modules are available for NEW activity.
 *
 * Persisted under `ledgora-billing`. Selector-safety: derived arrays are never
 * built inside selectors — components select stored arrays or primitives and
 * derive with useMemo.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  BankDetails,
  BillingAuditEntry,
  BillingAuditEvent,
  BillingSettings,
  PaymentProof,
  SubscriptionInvoice,
  SubscriptionPlan,
} from '@/types/billing';
import { useEntitlementStore } from './entitlementStore';
import { getCurrentRole, getCurrentUserName } from './sessionStore';
import {
  assertCanManagePlans,
  assertCanManageBillingSettings,
  assertCanVerifyPayments,
} from '@/lib/billingPermissions';
import {
  classifyChange,
  computeExpiryTransition,
  hasErrors,
  invoicePeriod,
  nextInvoiceNumber,
  resolvePlanSubscription,
  validatePlan,
  validateProof,
  type ProofInput,
} from '@/lib/billingCalculations';
import {
  makeSeedBillingSettings,
  makeSeedPlans,
} from '@/lib/billingSeed';
import { generateId, nowIso } from '@/lib/utils';

export interface BillingActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  fieldErrors?: Record<string, string>;
}

function audit(
  event: BillingAuditEvent,
  detail: string,
  extra?: { invoiceId?: string; planId?: string },
): BillingAuditEntry {
  return {
    id: generateId('bau'),
    event,
    at: nowIso(),
    actor: getCurrentUserName(),
    detail,
    ...extra,
  };
}

interface BillingState {
  plans: SubscriptionPlan[];
  settings: BillingSettings;
  invoices: SubscriptionInvoice[];
  auditTrail: BillingAuditEntry[];
  /** Plan the active subscription was last activated from (drives upgrade math). */
  activePlanId?: string;
  seeded: boolean;

  ensureSeeded: () => void;

  /* Plan administration (admin) */
  createPlan: (input: Omit<SubscriptionPlan, 'id' | 'createdAt' | 'updatedAt'>) => BillingActionResult;
  updatePlan: (id: string, patch: Partial<SubscriptionPlan>) => BillingActionResult;
  archivePlan: (id: string) => BillingActionResult;
  restorePlan: (id: string) => BillingActionResult;

  /* Bank details & settings (admin) */
  updateBankDetails: (patch: Partial<BankDetails>) => BillingActionResult;
  updateBillingSettings: (patch: Partial<Omit<BillingSettings, 'bank'>>) => BillingActionResult;

  /* Subscription request / payment flow */
  requestSubscription: (planId: string) => BillingActionResult;
  uploadPaymentProof: (invoiceId: string, input: ProofInput) => BillingActionResult;
  cancelInvoice: (invoiceId: string) => BillingActionResult;

  /* Administrator verification (admin) */
  approvePayment: (invoiceId: string) => BillingActionResult;
  rejectPayment: (invoiceId: string, reason: string) => BillingActionResult;

  /* Lifecycle */
  cancelSubscription: (reason?: string) => BillingActionResult;
  applyExpiryTransitions: () => void;

  /* Dev/testing */
  resetToDefault: () => void;
}

function seedState(): Pick<BillingState, 'plans' | 'settings' | 'invoices' | 'auditTrail' | 'seeded' | 'activePlanId'> {
  const now = nowIso();
  return {
    plans: makeSeedPlans(now),
    settings: makeSeedBillingSettings(now),
    invoices: [],
    auditTrail: [],
    seeded: true,
    activePlanId: undefined,
  };
}

export const useBillingStore = create<BillingState>()(
  persist(
    (set, get) => ({
      ...seedState(),
      seeded: false,

      ensureSeeded: () => {
        if (get().seeded && get().plans.length > 0) {
          get().applyExpiryTransitions();
          return;
        }
        set(seedState());
        get().applyExpiryTransitions();
      },

      /* ── Plan administration ─────────────────────────────────────────── */
      createPlan: (input) => {
        const perm = assertCanManagePlans(getCurrentRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        const errors = validatePlan(input);
        if (hasErrors(errors)) return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors: errors };
        const now = nowIso();
        const plan: SubscriptionPlan = { ...input, id: generateId('plan'), createdAt: now, updatedAt: now };
        set((s) => ({
          plans: [...s.plans, plan].sort((a, b) => a.sortOrder - b.sortOrder),
          auditTrail: [...s.auditTrail, audit('plan-created', `Package "${plan.name}" created.`, { planId: plan.id })],
        }));
        return { ok: true, id: plan.id };
      },

      updatePlan: (id, patch) => {
        const perm = assertCanManagePlans(getCurrentRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        const existing = get().plans.find((p) => p.id === id);
        if (!existing) return { ok: false, error: 'Package not found.' };
        const merged = { ...existing, ...patch };
        const errors = validatePlan(merged);
        if (hasErrors(errors)) return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors: errors };
        set((s) => ({
          plans: s.plans.map((p) => (p.id === id ? { ...merged, updatedAt: nowIso() } : p)),
          auditTrail: [...s.auditTrail, audit('plan-updated', `Package "${merged.name}" updated.`, { planId: id })],
        }));
        return { ok: true, id };
      },

      archivePlan: (id) => {
        const perm = assertCanManagePlans(getCurrentRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        const existing = get().plans.find((p) => p.id === id);
        if (!existing) return { ok: false, error: 'Package not found.' };
        set((s) => ({
          plans: s.plans.map((p) => (p.id === id ? { ...p, isActive: false, isPublic: false, updatedAt: nowIso() } : p)),
          auditTrail: [...s.auditTrail, audit('plan-archived', `Package "${existing.name}" archived.`, { planId: id })],
        }));
        return { ok: true, id };
      },

      restorePlan: (id) => {
        const perm = assertCanManagePlans(getCurrentRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        set((s) => ({
          plans: s.plans.map((p) => (p.id === id ? { ...p, isActive: true, isPublic: true, updatedAt: nowIso() } : p)),
        }));
        return { ok: true, id };
      },

      /* ── Bank details & settings ─────────────────────────────────────── */
      updateBankDetails: (patch) => {
        const perm = assertCanManageBillingSettings(getCurrentRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        set((s) => ({
          settings: { ...s.settings, bank: { ...s.settings.bank, ...patch }, updatedAt: nowIso() },
          auditTrail: [...s.auditTrail, audit('bank-details-updated', 'Bank remittance details updated.')],
        }));
        return { ok: true };
      },

      updateBillingSettings: (patch) => {
        const perm = assertCanManageBillingSettings(getCurrentRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        if (patch.graceDays !== undefined && patch.graceDays < 0) return { ok: false, error: 'Grace days cannot be negative.' };
        if (patch.termMonths !== undefined && patch.termMonths < 1) return { ok: false, error: 'Term must be at least 1 month.' };
        set((s) => ({
          settings: { ...s.settings, ...patch, updatedAt: nowIso() },
          auditTrail: [...s.auditTrail, audit('billing-settings-updated', 'Billing settings updated.')],
        }));
        return { ok: true };
      },

      /* ── Subscription request → invoice ──────────────────────────────── */
      requestSubscription: (planId) => {
        const plan = get().plans.find((p) => p.id === planId);
        if (!plan) return { ok: false, error: 'Package not found.' };
        if (!plan.isActive) return { ok: false, error: 'This package is not available for purchase.' };

        const current = useEntitlementStore.getState().subscription;
        const activePlan = get().plans.find((p) => p.id === get().activePlanId) ?? null;
        const changeType = classifyChange(activePlan, plan, current.status);
        const now = new Date();
        const { periodStart, periodEnd } = invoicePeriod(current, get().settings, now);
        const prefix = get().settings.invoicePrefix;
        const number = nextInvoiceNumber(get().invoices, prefix, now.getUTCFullYear());
        const dueAt = new Date(now.getTime() + get().settings.paymentDueDays * 86_400_000);

        // Supersede any still-open invoice for this organization.
        const superseded = get().invoices.map((inv) =>
          inv.status === 'issued' || inv.status === 'proof-submitted'
            ? { ...inv, status: 'cancelled' as const, updatedAt: nowIso() }
            : inv,
        );

        const invoice: SubscriptionInvoice = {
          id: generateId('subinv'),
          number,
          organizationId: current.organizationId,
          planId: plan.id,
          planCode: plan.code,
          planName: plan.name,
          edition: plan.edition,
          changeType,
          status: 'issued',
          currency: plan.currency,
          amount: plan.priceMonthly,
          periodStart,
          periodEnd,
          issuedAt: nowIso(),
          dueAt: dueAt.toISOString(),
          bankSnapshot: { ...get().settings.bank },
          proofs: [],
          notes: '',
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        set((s) => ({
          invoices: [...superseded, invoice],
          auditTrail: [
            ...s.auditTrail,
            audit('invoice-issued', `Invoice ${number} issued for "${plan.name}" (${changeType}).`, { invoiceId: invoice.id, planId: plan.id }),
          ],
        }));
        return { ok: true, id: invoice.id };
      },

      uploadPaymentProof: (invoiceId, input) => {
        const invoice = get().invoices.find((i) => i.id === invoiceId);
        if (!invoice) return { ok: false, error: 'Invoice not found.' };
        if (invoice.status === 'approved') return { ok: false, error: 'This invoice is already approved.' };
        if (invoice.status === 'cancelled') return { ok: false, error: 'This invoice has been cancelled.' };
        const errors = validateProof(input);
        if (hasErrors(errors)) return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors: errors };

        const proof: PaymentProof = {
          id: generateId('proof'),
          fileName: input.fileName,
          fileType: input.fileType,
          fileSize: input.fileSize,
          dataUrl: input.dataUrl,
          reference: input.reference.trim(),
          amount: input.amount,
          paidAt: input.paidAt,
          note: input.note?.trim() ?? '',
          uploadedAt: nowIso(),
          uploadedBy: getCurrentUserName(),
        };
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === invoiceId
              ? {
                  ...i,
                  proofs: [...i.proofs, proof],
                  currentProofId: proof.id,
                  status: 'proof-submitted',
                  rejectionReason: undefined,
                  updatedAt: nowIso(),
                }
              : i,
          ),
          auditTrail: [...s.auditTrail, audit('proof-uploaded', `Payment proof uploaded for ${invoice.number} (ref ${proof.reference}).`, { invoiceId })],
        }));
        return { ok: true, id: proof.id };
      },

      cancelInvoice: (invoiceId) => {
        const invoice = get().invoices.find((i) => i.id === invoiceId);
        if (!invoice) return { ok: false, error: 'Invoice not found.' };
        if (invoice.status === 'approved') return { ok: false, error: 'An approved invoice cannot be cancelled.' };
        set((s) => ({
          invoices: s.invoices.map((i) => (i.id === invoiceId ? { ...i, status: 'cancelled', updatedAt: nowIso() } : i)),
          auditTrail: [...s.auditTrail, audit('invoice-cancelled', `Invoice ${invoice.number} cancelled.`, { invoiceId })],
        }));
        return { ok: true };
      },

      /* ── Administrator verification ──────────────────────────────────── */
      approvePayment: (invoiceId) => {
        const perm = assertCanVerifyPayments(getCurrentRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        const invoice = get().invoices.find((i) => i.id === invoiceId);
        if (!invoice) return { ok: false, error: 'Invoice not found.' };
        if (invoice.status !== 'proof-submitted') {
          return { ok: false, error: 'Only invoices with a submitted proof can be approved.' };
        }
        const plan = get().plans.find((p) => p.id === invoice.planId);
        if (!plan) return { ok: false, error: 'The package for this invoice no longer exists.' };

        const entitlement = useEntitlementStore.getState();
        const proof = invoice.proofs.find((p) => p.id === invoice.currentProofId);
        const now = new Date();
        const nextSub = resolvePlanSubscription(entitlement.subscription, plan, get().settings, proof, now);
        entitlement.replaceSubscription(nextSub);

        const actor = getCurrentUserName();
        const lifecycleEvent: BillingAuditEvent =
          invoice.changeType === 'upgrade'
            ? 'subscription-upgraded'
            : invoice.changeType === 'downgrade'
              ? 'subscription-downgraded'
              : invoice.changeType === 'renewal'
                ? 'subscription-renewed'
                : 'subscription-activated';

        set((s) => ({
          activePlanId: plan.id,
          invoices: s.invoices.map((i) =>
            i.id === invoiceId ? { ...i, status: 'approved', verifiedBy: actor, verifiedAt: nowIso(), updatedAt: nowIso() } : i,
          ),
          auditTrail: [
            ...s.auditTrail,
            audit('payment-approved', `Payment for ${invoice.number} approved by ${actor}.`, { invoiceId, planId: plan.id }),
            audit(lifecycleEvent, `Subscription set to "${plan.name}" until ${nextSub.expiresAt}.`, { invoiceId, planId: plan.id }),
          ],
        }));
        return { ok: true, id: invoiceId };
      },

      rejectPayment: (invoiceId, reason) => {
        const perm = assertCanVerifyPayments(getCurrentRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        const invoice = get().invoices.find((i) => i.id === invoiceId);
        if (!invoice) return { ok: false, error: 'Invoice not found.' };
        if (invoice.status !== 'proof-submitted') return { ok: false, error: 'Only a submitted proof can be rejected.' };
        if (!reason.trim()) return { ok: false, error: 'A rejection reason is required.' };
        set((s) => ({
          invoices: s.invoices.map((i) =>
            i.id === invoiceId ? { ...i, status: 'rejected', rejectionReason: reason.trim(), updatedAt: nowIso() } : i,
          ),
          auditTrail: [...s.auditTrail, audit('payment-rejected', `Payment for ${invoice.number} rejected: ${reason.trim()}.`, { invoiceId })],
        }));
        return { ok: true };
      },

      /* ── Lifecycle ───────────────────────────────────────────────────── */
      cancelSubscription: (reason) => {
        const entitlement = useEntitlementStore.getState();
        entitlement.setSubscriptionStatus('cancelled');
        set((s) => ({
          auditTrail: [...s.auditTrail, audit('subscription-cancelled', reason ? `Subscription cancelled: ${reason}.` : 'Subscription cancelled. Historical data preserved.')],
        }));
        return { ok: true };
      },

      applyExpiryTransitions: () => {
        const entitlement = useEntitlementStore.getState();
        const sub = entitlement.subscription;
        const today = new Date().toISOString().slice(0, 10);
        const transition = computeExpiryTransition(sub, get().settings, today);
        if (transition === 'to-grace') {
          entitlement.setSubscriptionStatus('past-due');
          set((s) => ({ auditTrail: [...s.auditTrail, audit('grace-started', `Subscription entered its grace period after ${sub.expiresAt}.`)] }));
        } else if (transition === 'to-expired') {
          entitlement.setSubscriptionStatus('expired');
          set((s) => ({ auditTrail: [...s.auditTrail, audit('subscription-expired', `Subscription expired after grace period (expiry ${sub.expiresAt}).`)] }));
        }
      },

      resetToDefault: () => set({ ...seedState() }),
    }),
    {
      name: 'ledgora-billing',
      version: 1,
      partialize: (s) => ({
        plans: s.plans,
        settings: s.settings,
        invoices: s.invoices,
        auditTrail: s.auditTrail,
        activePlanId: s.activePlanId,
        seeded: s.seeded,
      }),
    },
  ),
);

/** Convenience: the plan the active subscription was last activated from. */
export function getActivePlan(): SubscriptionPlan | undefined {
  const { plans, activePlanId } = useBillingStore.getState();
  return plans.find((p) => p.id === activePlanId);
}

/** Public catalog helper (kept out of selectors — call from useMemo). */
export function publicPlans(plans: SubscriptionPlan[]): SubscriptionPlan[] {
  return [...plans].filter((p) => p.isPublic && p.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
}
