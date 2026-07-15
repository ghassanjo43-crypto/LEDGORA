/**
 * Pure billing helpers — periods, invoice numbering, plan→subscription
 * resolution, renewal reminders and validation. No React, no store.
 */
import type { LedgoraEdition } from '@/types/entitlements';
import type { OrganizationSubscription } from '@/types/subscription';
import type {
  BillingSettings,
  PaymentProof,
  RenewalReminder,
  SubscriptionChangeType,
  SubscriptionInvoice,
  SubscriptionPlan,
} from '@/types/billing';

/** yyyy-mm-dd for a Date. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add whole months to an ISO date, clamping day-of-month overflow. */
export function addMonths(isoDay: string, months: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  const targetMonth = d.getUTCMonth() + months;
  const result = new Date(Date.UTC(d.getUTCFullYear(), targetMonth, 1));
  // clamp day to the last valid day of the target month
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return isoDate(result);
}

/** Inclusive day difference b - a (in whole days). */
export function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(`${aIso}T00:00:00Z`).getTime();
  const b = new Date(`${bIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** Next sequential invoice number, e.g. SUB-2026-0007. */
export function nextInvoiceNumber(
  invoices: SubscriptionInvoice[],
  prefix: string,
  year: number,
): string {
  const re = new RegExp(`^${prefix}-${year}-(\\d+)$`, 'u');
  let max = 0;
  for (const inv of invoices) {
    const m = re.exec(inv.number.trim());
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${year}-${String(max + 1).padStart(4, '0')}`;
}

/**
 * Classify a plan change relative to the currently active plan. Uses price to
 * decide upgrade vs downgrade; a null current plan is a brand-new subscription.
 */
export function classifyChange(
  currentPlan: SubscriptionPlan | null,
  targetPlan: SubscriptionPlan,
  currentStatus: OrganizationSubscription['status'],
): SubscriptionChangeType {
  if (!currentPlan) return 'new';
  if (currentStatus === 'expired' || currentStatus === 'cancelled') {
    return 'reactivation';
  }
  if (currentPlan.id === targetPlan.id) return 'renewal';
  if (targetPlan.priceMonthly > currentPlan.priceMonthly) return 'upgrade';
  if (targetPlan.priceMonthly < currentPlan.priceMonthly) return 'downgrade';
  return 'renewal';
}

/**
 * Build the OrganizationSubscription that results from activating a plan. The
 * new period extends from `periodStart` for `termMonths`. Renewals from a still
 * active, not-yet-expired subscription extend from the current expiry so paid
 * time is never lost.
 */
export function resolvePlanSubscription(
  current: OrganizationSubscription,
  plan: SubscriptionPlan,
  settings: BillingSettings,
  proof: Pick<PaymentProof, 'reference'> | undefined,
  now: Date,
): OrganizationSubscription {
  const today = isoDate(now);
  const extendFrom =
    current.expiresAt && current.expiresAt > today && current.status === 'active'
      ? current.expiresAt
      : today;
  const periodEnd = addMonths(extendFrom, settings.termMonths);
  return {
    ...current,
    edition: plan.edition,
    status: 'active',
    enabledModules: [...plan.addOnModules],
    disabledModules: [...plan.removedModules],
    userLimit: plan.userLimit,
    entityLimit: plan.entityLimit,
    startsAt: current.activatedAt ? current.startsAt : now.toISOString(),
    expiresAt: periodEnd,
    activationMethod: 'bank-remittance',
    bankRemittanceReference: proof?.reference ?? current.bankRemittanceReference,
    activatedAt: now.toISOString(),
    suspendedAt: undefined,
    updatedAt: now.toISOString(),
  };
}

export interface InvoicePeriod {
  periodStart: string;
  periodEnd: string;
}

/** The period an invoice will cover, mirroring resolvePlanSubscription. */
export function invoicePeriod(
  current: OrganizationSubscription,
  settings: BillingSettings,
  now: Date,
): InvoicePeriod {
  const today = isoDate(now);
  const start =
    current.expiresAt && current.expiresAt > today && current.status === 'active'
      ? current.expiresAt
      : today;
  return { periodStart: start, periodEnd: addMonths(start, settings.termMonths) };
}

/* ── Reminders (spec: 7 days, 3 days, on expiry, grace end) ───────────────── */

/**
 * The single most-urgent active renewal reminder, or null when nothing applies
 * (no expiry set, or comfortably far from expiry). Pure — `today` is injected.
 */
export function computeRenewalReminder(
  subscription: OrganizationSubscription,
  settings: BillingSettings,
  today: string,
): RenewalReminder | null {
  const { expiresAt } = subscription;
  if (!expiresAt) return null;
  if (subscription.status === 'cancelled') return null;

  const graceEnd = addDays(expiresAt, settings.graceDays);
  const daysUntilExpiry = daysBetween(today, expiresAt);

  const base = { expiresAt, graceEndsAt: graceEnd, daysUntilExpiry };

  if (today > graceEnd) {
    return {
      ...base,
      kind: 'grace-ended',
      title: 'Subscription expired',
      message:
        'Your subscription and its grace period have ended. New posting is blocked until you renew. Your data is preserved.',
      severity: 'error',
    };
  }
  if (daysUntilExpiry < 0) {
    return {
      ...base,
      kind: 'in-grace',
      title: 'Subscription in grace period',
      message: `Your subscription expired on ${expiresAt}. You have until ${graceEnd} (grace period) to renew before access is blocked.`,
      severity: 'error',
    };
  }
  if (daysUntilExpiry === 0) {
    return {
      ...base,
      kind: 'on-expiry',
      title: 'Subscription expires today',
      message: 'Your subscription expires today. Renew now to avoid interruption.',
      severity: 'warning',
    };
  }
  const offsets = [...settings.reminderOffsets].sort((a, b) => a - b);
  const threshold = offsets.filter((o) => o > 0);
  const largest = threshold.length ? Math.max(...threshold) : 7;
  if (daysUntilExpiry <= largest) {
    return {
      ...base,
      kind: 'before-expiry',
      title: `Subscription renews in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}`,
      message: `Your subscription expires on ${expiresAt}. Renew to keep uninterrupted access.`,
      severity: 'warning',
    };
  }
  return null;
}

/** Add whole days to an ISO date. */
export function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/* ── Expiry / grace transition ────────────────────────────────────────────── */

export type ExpiryTransition = 'none' | 'to-grace' | 'to-expired';

/**
 * Decide whether an active subscription should move into grace (past-due) or
 * expired based on dates. Never deletes data — only reflects status.
 */
export function computeExpiryTransition(
  subscription: OrganizationSubscription,
  settings: BillingSettings,
  today: string,
): ExpiryTransition {
  const { expiresAt, status } = subscription;
  if (!expiresAt) return 'none';
  const graceEnd = addDays(expiresAt, settings.graceDays);
  if (today > graceEnd) {
    return status === 'expired' ? 'none' : 'to-expired';
  }
  if (today > expiresAt) {
    // in grace window
    return status === 'active' ? 'to-grace' : 'none';
  }
  return 'none';
}

/* ── Validation ───────────────────────────────────────────────────────────── */

export interface FieldErrors {
  [field: string]: string;
}

export function validatePlan(input: Partial<SubscriptionPlan>): FieldErrors {
  const errors: FieldErrors = {};
  if (!input.name || !input.name.trim()) errors.name = 'Package name is required.';
  if (input.priceMonthly === undefined || Number.isNaN(input.priceMonthly) || input.priceMonthly < 0) {
    errors.priceMonthly = 'Price must be zero or a positive number.';
  }
  if (input.userLimit === undefined || input.userLimit < 1) errors.userLimit = 'User limit must be at least 1.';
  if (input.entityLimit === undefined || input.entityLimit < 1) errors.entityLimit = 'Entity limit must be at least 1.';
  if (!input.currency || !input.currency.trim()) errors.currency = 'Currency is required.';
  return errors;
}

export const MAX_PROOF_BYTES = 4 * 1024 * 1024; // 4 MB
export const ALLOWED_PROOF_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

export interface ProofInput {
  fileName: string;
  fileType: string;
  fileSize: number;
  dataUrl: string;
  reference: string;
  amount: number;
  paidAt: string;
  note?: string;
}

export function validateProof(input: Partial<ProofInput>): FieldErrors {
  const errors: FieldErrors = {};
  if (!input.dataUrl || !input.fileName) errors.file = 'Attach the payment receipt.';
  if (input.fileSize !== undefined && input.fileSize > MAX_PROOF_BYTES) {
    errors.file = 'File is larger than 4 MB.';
  }
  if (input.fileType && !ALLOWED_PROOF_TYPES.includes(input.fileType)) {
    errors.file = 'Only PNG, JPEG, WEBP or PDF receipts are accepted.';
  }
  if (!input.reference || !input.reference.trim()) errors.reference = 'Bank reference is required.';
  if (input.amount === undefined || Number.isNaN(input.amount) || input.amount <= 0) {
    errors.amount = 'Enter the amount paid.';
  }
  if (!input.paidAt) errors.paidAt = 'Enter the payment date.';
  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Edition ordering used for upgrade/downgrade display only. */
export const EDITION_RANK: Record<LedgoraEdition, number> = {
  core: 0,
  projects: 1,
  construction: 2,
  manufacturing: 3,
  enterprise: 4,
};
