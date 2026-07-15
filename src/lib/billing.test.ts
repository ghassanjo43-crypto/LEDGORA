import { describe, it, expect } from 'vitest';
import type { OrganizationSubscription } from '@/types/subscription';
import type { BillingSettings, SubscriptionPlan } from '@/types/billing';
import {
  addDays,
  addMonths,
  classifyChange,
  computeExpiryTransition,
  computeRenewalReminder,
  daysBetween,
  nextInvoiceNumber,
  resolvePlanSubscription,
  validatePlan,
  validateProof,
} from '@/lib/billingCalculations';
import { makeSeedBillingSettings, makeSeedPlans, DEFAULT_PLAN_PRICES } from '@/lib/billingSeed';

const NOW = '2026-07-13T10:00:00.000Z';
const settings: BillingSettings = makeSeedBillingSettings(NOW);

function sub(patch: Partial<OrganizationSubscription>): OrganizationSubscription {
  return {
    id: 'sub1',
    organizationId: 'primary',
    edition: 'core',
    status: 'active',
    enabledModules: [],
    disabledModules: [],
    userLimit: 3,
    entityLimit: 1,
    startsAt: NOW,
    activationMethod: 'bank-remittance',
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function plan(patch: Partial<SubscriptionPlan>): SubscriptionPlan {
  return {
    id: 'plan_x',
    code: 'core',
    name: 'Ledgora Core',
    description: '',
    edition: 'core',
    priceMonthly: 29,
    currency: 'USD',
    userLimit: 3,
    entityLimit: 1,
    addOnModules: [],
    removedModules: [],
    isActive: true,
    isPublic: true,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

/* ── Date math ────────────────────────────────────────────────────────────── */

describe('billing date helpers', () => {
  it('adds months with day clamping', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-07-13', 1)).toBe('2026-08-13');
    expect(addDays('2026-07-13', 7)).toBe('2026-07-20');
  });
  it('computes day differences', () => {
    expect(daysBetween('2026-07-13', '2026-07-20')).toBe(7);
    expect(daysBetween('2026-07-20', '2026-07-13')).toBe(-7);
  });
});

/* ── Seed packages ────────────────────────────────────────────────────────── */

describe('seed packages', () => {
  it('creates the five monthly USD packages at the required prices', () => {
    const plans = makeSeedPlans(NOW);
    const price = (code: string): number => plans.find((p) => p.code === code)!.priceMonthly;
    expect(price('core')).toBe(29);
    expect(price('projects')).toBe(59);
    expect(price('construction')).toBe(99);
    expect(price('manufacturing')).toBe(119);
    expect(price('enterprise')).toBe(249);
    for (const p of plans) expect(p.currency).toBe('USD');
    expect(DEFAULT_PLAN_PRICES.enterprise).toBe(249);
  });
});

/* ── Invoice numbering ────────────────────────────────────────────────────── */

describe('nextInvoiceNumber', () => {
  it('increments per prefix and year', () => {
    expect(nextInvoiceNumber([], 'SUB', 2026)).toBe('SUB-2026-0001');
    const one = [{ number: 'SUB-2026-0001' }] as any;
    expect(nextInvoiceNumber(one, 'SUB', 2026)).toBe('SUB-2026-0002');
  });
});

/* ── Change classification ────────────────────────────────────────────────── */

describe('classifyChange', () => {
  it('classifies new / renewal / upgrade / downgrade / reactivation', () => {
    expect(classifyChange(null, plan({ id: 'a' }), 'active')).toBe('new');
    expect(classifyChange(plan({ id: 'a', priceMonthly: 29 }), plan({ id: 'a', priceMonthly: 29 }), 'active')).toBe('renewal');
    expect(classifyChange(plan({ id: 'a', priceMonthly: 29 }), plan({ id: 'b', priceMonthly: 59 }), 'active')).toBe('upgrade');
    expect(classifyChange(plan({ id: 'a', priceMonthly: 59 }), plan({ id: 'b', priceMonthly: 29 }), 'active')).toBe('downgrade');
    expect(classifyChange(plan({ id: 'a' }), plan({ id: 'b' }), 'expired')).toBe('reactivation');
  });
});

/* ── Plan → subscription resolution ───────────────────────────────────────── */

describe('resolvePlanSubscription', () => {
  it('activates a fresh plan for one term from today', () => {
    const now = new Date(NOW);
    const current = sub({ status: 'cancelled', expiresAt: undefined, activatedAt: undefined });
    const next = resolvePlanSubscription(current, plan({ edition: 'projects', userLimit: 10, entityLimit: 2 }), settings, { reference: 'TT-1' }, now);
    expect(next.edition).toBe('projects');
    expect(next.status).toBe('active');
    expect(next.userLimit).toBe(10);
    expect(next.expiresAt).toBe(addMonths('2026-07-13', 1));
    expect(next.bankRemittanceReference).toBe('TT-1');
  });

  it('extends a renewal from the current expiry so paid time is not lost', () => {
    const now = new Date(NOW);
    const current = sub({ status: 'active', expiresAt: '2026-08-13', activatedAt: NOW });
    const next = resolvePlanSubscription(current, plan({}), settings, { reference: 'TT-2' }, now);
    expect(next.expiresAt).toBe(addMonths('2026-08-13', 1)); // 2026-09-13
  });
});

/* ── Reminders (7 / 3 / 0 / grace) ────────────────────────────────────────── */

describe('computeRenewalReminder', () => {
  const s = sub({ expiresAt: '2026-07-20' }); // 7 days from NOW date 2026-07-13
  it('is silent well before the first threshold', () => {
    expect(computeRenewalReminder(sub({ expiresAt: '2026-08-20' }), settings, '2026-07-13')).toBeNull();
  });
  it('warns 7 days before expiry', () => {
    const r = computeRenewalReminder(s, settings, '2026-07-13');
    expect(r?.kind).toBe('before-expiry');
    expect(r?.daysUntilExpiry).toBe(7);
  });
  it('warns 3 days before expiry', () => {
    const r = computeRenewalReminder(s, settings, '2026-07-17');
    expect(r?.kind).toBe('before-expiry');
    expect(r?.daysUntilExpiry).toBe(3);
  });
  it('warns on the expiry date', () => {
    const r = computeRenewalReminder(s, settings, '2026-07-20');
    expect(r?.kind).toBe('on-expiry');
  });
  it('shows a grace-period reminder after expiry', () => {
    const r = computeRenewalReminder(s, settings, '2026-07-23'); // within 7-day grace
    expect(r?.kind).toBe('in-grace');
    expect(r?.severity).toBe('error');
  });
  it('shows grace-ended once the grace period lapses', () => {
    const r = computeRenewalReminder(s, settings, '2026-07-30'); // > expiry + 7
    expect(r?.kind).toBe('grace-ended');
  });
  it('is silent when there is no expiry', () => {
    expect(computeRenewalReminder(sub({ expiresAt: undefined }), settings, '2026-07-13')).toBeNull();
  });
});

/* ── Expiry / grace transitions ───────────────────────────────────────────── */

describe('computeExpiryTransition', () => {
  const s = sub({ expiresAt: '2026-07-20', status: 'active' });
  it('does nothing before expiry', () => {
    expect(computeExpiryTransition(s, settings, '2026-07-19')).toBe('none');
  });
  it('moves an active subscription into grace after expiry', () => {
    expect(computeExpiryTransition(s, settings, '2026-07-23')).toBe('to-grace');
  });
  it('expires after the grace period ends', () => {
    expect(computeExpiryTransition(sub({ expiresAt: '2026-07-20', status: 'past-due' }), settings, '2026-07-30')).toBe('to-expired');
  });
});

/* ── Validation ───────────────────────────────────────────────────────────── */

describe('validation', () => {
  it('validates plans', () => {
    expect(Object.keys(validatePlan(plan({}))).length).toBe(0);
    expect(validatePlan(plan({ name: '' })).name).toBeTruthy();
    expect(validatePlan(plan({ priceMonthly: -1 })).priceMonthly).toBeTruthy();
    expect(validatePlan(plan({ userLimit: 0 })).userLimit).toBeTruthy();
  });
  it('validates payment proofs', () => {
    const ok = validateProof({ fileName: 'r.png', fileType: 'image/png', fileSize: 1000, dataUrl: 'data:...', reference: 'TT', amount: 29, paidAt: '2026-07-13' });
    expect(Object.keys(ok).length).toBe(0);
    expect(validateProof({}).file).toBeTruthy();
    expect(validateProof({ fileName: 'r.png', fileType: 'image/png', fileSize: 1000, dataUrl: 'd', reference: '', amount: 29, paidAt: '2026-07-13' }).reference).toBeTruthy();
    expect(validateProof({ fileName: 'r.exe', fileType: 'application/x-msdownload', fileSize: 10, dataUrl: 'd', reference: 'TT', amount: 1, paidAt: 'x' }).file).toBeTruthy();
  });
});
