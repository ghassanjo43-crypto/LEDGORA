// @vitest-environment happy-dom
/**
 * The platform-administration production lock.
 *
 * These tests are the executable statement of the security policy: in a
 * production build there is NO path — stored role, hand-edited localStorage, or
 * a direct store call from the browser console — that reaches an administrator
 * action. Development tooling requires BOTH `import.meta.env.DEV` and an
 * explicit `VITE_LEDGORA_DEV_TOOLS=true`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  effectivePlatformRole,
  hasPlatformCapability,
  platformAdminToolsAllowed,
} from '@/lib/platformAccess';
import { platformRoleHasCapability } from '@/types/roles';
import { useSessionStore, getPlatformRole, getStoredPlatformRole } from '@/store/sessionStore';
import { useBillingStore } from '@/store/billingStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import { useUsageStore } from '@/store/usageStore';
import { useAuthStore } from '@/store/authStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { subscriptionService, authService } from '@/services';

/** Simulate a deployed Render bundle: DEV is false. */
function simulateProductionBuild(): void {
  vi.stubEnv('DEV', false);
  vi.stubEnv('PROD', true);
  vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', 'true'); // even with the flag set
}

/** Simulate a local dev server WITHOUT the explicit opt-in. */
function simulateDevWithoutOptIn(): void {
  vi.stubEnv('DEV', true);
  vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', '');
}

function seedInvoiceWithProof(): string {
  useBillingStore.getState().ensureSeeded();
  const plan = useBillingStore.getState().plans[0]!;
  const invoiceId = useBillingStore.getState().requestSubscription(plan.id).id!;
  const invoice = useBillingStore.getState().invoices.find((i) => i.id === invoiceId)!;
  useBillingStore.getState().uploadPaymentProof(invoiceId, {
    fileName: 'receipt.png',
    fileType: 'image/png',
    fileSize: 512,
    dataUrl: 'data:image/png;base64,AAAA',
    reference: invoice.paymentReference,
    amount: invoice.amount,
    paidAt: '2026-07-19',
  });
  return invoiceId;
}

beforeEach(() => {
  localStorage.clear();
  useBillingStore.getState().resetToDefault();
  useOrganizationStore.getState().resetToDefault();
  useEntitlementStore.getState().resetToDefault();
  useAuthStore.getState().resetToDefault();
  useAccountSessionStore.getState().resetToDefault();
  useMeteringConfigStore.getState().ensureSeeded();
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
});

afterEach(() => vi.unstubAllEnvs());

/* ── 1. Defaults ─────────────────────────────────────────────────────────── */

describe('default role', () => {
  it('is not an administrator', () => {
    useSessionStore.getState().resetToDefault();
    expect(useSessionStore.getState().platformRole).toBe('none');
    expect(getPlatformRole()).toBe('none');
    expect(hasPlatformCapability(getStoredPlatformRole(), 'verify-payments')).toBe(false);
  });

  it('gives the "none" role no capability at all', () => {
    const capabilities = [
      'verify-payments',
      'manage-plans',
      'manage-billing-settings',
      'activate-subscription',
      'manage-metering',
      'close-usage-periods',
      'view-infra-cost',
      'manage-any-organization',
    ] as const;
    for (const capability of capabilities) {
      expect(platformRoleHasCapability('none', capability)).toBe(false);
    }
  });
});

/* ── 2–4. Customers can never administer ─────────────────────────────────── */

describe('customers cannot reach administrator actions', () => {
  it('refuses an anonymous visitor', () => {
    expect(useBillingStore.getState().updateBankDetails({ bankName: 'Hacked' }).ok).toBe(false);
    expect(useBillingStore.getState().settings.bank.bankName).not.toBe('Hacked');
  });

  it('refuses a registered customer', async () => {
    await authService.register({
      fullName: 'Jane Owner',
      email: 'jane@acme.test',
      password: 'Secret123',
      confirmPassword: 'Secret123',
      country: 'AE',
      acceptedTerms: true,
    });
    expect(getPlatformRole()).toBe('none');
    const invoiceId = seedInvoiceWithProof();
    expect(useBillingStore.getState().approvePayment(invoiceId).ok).toBe(false);
  });

  it('refuses a Free Demo visitor', async () => {
    await subscriptionService.startFreeDemo();
    expect(getPlatformRole()).toBe('none');
    const invoiceId = seedInvoiceWithProof();
    expect(useBillingStore.getState().approvePayment(invoiceId).ok).toBe(false);
    expect(useBillingStore.getState().createPlan({} as never).ok).toBe(false);
  });

  it('refuses a subscriber approving their own payment', () => {
    const invoiceId = seedInvoiceWithProof();
    const before = useEntitlementStore.getState().subscription.status;

    const result = useBillingStore.getState().approvePayment(invoiceId);

    expect(result.ok).toBe(false);
    expect(useBillingStore.getState().invoices.find((i) => i.id === invoiceId)!.status).toBe('proof-submitted');
    expect(useEntitlementStore.getState().subscription.status).toBe(before);
  });
});

/* ── 6 + 9. The production lock ──────────────────────────────────────────── */

describe('production build lock', () => {
  it('disables platform administration tooling entirely', () => {
    simulateProductionBuild();
    expect(platformAdminToolsAllowed()).toBe(false);
    expect(effectivePlatformRole('super-admin')).toBe('none');
    expect(hasPlatformCapability('super-admin', 'verify-payments')).toBe(false);
  });

  it('ignores a hand-edited localStorage administrator value', () => {
    // Exactly what an attacker would write into browser storage.
    localStorage.setItem(
      'ledgora-session',
      JSON.stringify({ state: { userName: 'x', platformRole: 'super-admin' }, version: 2 }),
    );
    localStorage.setItem('ledgora-dev-tools', '1'); // the removed opt-in
    useSessionStore.setState({ platformRole: 'super-admin' });
    simulateProductionBuild();

    expect(getPlatformRole()).toBe('none');
    expect(useBillingStore.getState().approvePayment('anything').ok).toBe(false);
  });

  it('fails every sensitive store action closed, even called directly', () => {
    const invoiceId = seedInvoiceWithProof();
    // Grant the strongest stored role, then "deploy".
    useSessionStore.setState({ platformRole: 'super-admin' });
    simulateProductionBuild();

    const results = [
      useBillingStore.getState().approvePayment(invoiceId),
      useBillingStore.getState().rejectPayment(invoiceId, 'no'),
      useBillingStore.getState().updateBankDetails({ iban: 'AE99' }),
      useBillingStore.getState().updateBillingSettings({ graceDays: 99 }),
      useBillingStore.getState().createPlan({} as never),
      useBillingStore.getState().updatePlan('any', { priceMonthly: 0 }),
      useBillingStore.getState().archivePlan('any'),
      useOrganizationStore.getState().approvePayment('any'),
      useOrganizationStore.getState().rejectPayment('any', 'no'),
      useOrganizationStore.getState().requestMoreInfo('any', 'info'),
      useOrganizationStore.getState().suspendSubscription('because'),
      useMeteringConfigStore.getState().updateBasePlan('any', { priceMonthly: 0 }),
      useUsageStore.getState().closePeriod('2026-07'),
    ];

    for (const result of results) expect(result.ok).toBe(false);

    // Nothing was activated and nothing was mutated.
    expect(useBillingStore.getState().invoices.find((i) => i.id === invoiceId)!.status).toBe('proof-submitted');
    expect(useBillingStore.getState().settings.bank.iban).not.toBe('AE99');
    expect(useBillingStore.getState().settings.graceDays).not.toBe(99);
  });

  it('refuses to persist a privileged role in production', () => {
    simulateProductionBuild();
    useSessionStore.getState().setPlatformRole('super-admin');
    expect(useSessionStore.getState().platformRole).toBe('none');
  });
});

/* ── 7. Development tooling requires BOTH conditions ─────────────────────── */

describe('development tooling gate', () => {
  it('requires DEV mode and the explicit environment flag together', () => {
    simulateDevWithoutOptIn();
    expect(platformAdminToolsAllowed()).toBe(false);

    simulateProductionBuild(); // flag set, but not DEV
    expect(platformAdminToolsAllowed()).toBe(false);

    vi.stubEnv('DEV', true);
    vi.stubEnv('PROD', false);
    vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', 'true');
    expect(platformAdminToolsAllowed()).toBe(true);
  });

  it('permits an approved local developer to act as an operator', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', 'true');
    const invoiceId = seedInvoiceWithProof();
    useSessionStore.getState().setPlatformRole('super-admin');

    expect(getPlatformRole()).toBe('super-admin');
    expect(useBillingStore.getState().approvePayment(invoiceId).ok).toBe(true);
    expect(useEntitlementStore.getState().subscription.status).toBe('active');
  });

  it('never treats the removed localStorage key as authorization', () => {
    simulateDevWithoutOptIn();
    localStorage.setItem('ledgora-dev-tools', '1');
    expect(platformAdminToolsAllowed()).toBe(false);
  });
});

/* ── 5. Migration invalidates the old admin default ──────────────────────── */

describe('legacy session migration', () => {
  it('discards a persisted v1 role: "admin" instead of honouring it', () => {
    // A browser that used the old build carries this exact payload.
    const legacy = { state: { userName: 'Finance Manager', role: 'admin' }, version: 1 };
    localStorage.setItem('ledgora-session', JSON.stringify(legacy));

    useSessionStore.persist.rehydrate();

    expect(useSessionStore.getState().platformRole).toBe('none');
    expect(getPlatformRole()).toBe('none');
  });
});
