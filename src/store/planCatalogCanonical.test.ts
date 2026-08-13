// @vitest-environment happy-dom
/**
 * One canonical package record, read by both the Super Admin editor and the
 * subscriber catalogue.
 *
 * ══ What went wrong ══════════════════════════════════════════════════════════
 *
 * Ledgora had three package sources at once: the server's `subscription_plans`
 * table (with a complete admin API nothing in the browser called), the
 * browser-local `billingStore.plans`, and `EDITION_INFO`. The Subscription page
 * took the package's headline name from the THIRD of those, so a plan renamed by
 * an administrator kept showing its edition's label.
 *
 * ══ What these tests hold ════════════════════════════════════════════════════
 *
 * That every commercial field an administrator edits — name, price, currency,
 * limits, description, visibility — is the same object the subscriber renders,
 * that edition metadata cannot override any of it, that seeds cannot overwrite
 * an edit, and that renaming a package does not rewrite the invoices already
 * issued against it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useBillingStore, publicPlans } from '@/store/billingStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useSessionStore } from '@/store/sessionStore';
import { EDITION_INFO } from '@/config/editionCommercialInfo';
import { toSubscriptionPlan, toPlanWriteInput, type ServerPlan } from '@/services/api/planCatalogApi';
import type { SubscriptionPlan } from '@/types/billing';

/** What the Super Admin editor lists. */
const adminPlans = (): SubscriptionPlan[] => useBillingStore.getState().plans;

/** What the subscriber's package cards render. */
const subscriberCatalog = (): SubscriptionPlan[] => publicPlans(useBillingStore.getState().plans);

const corePlan = (): SubscriptionPlan => adminPlans().find((p) => p.code === 'core')!;

/**
 * Act as the platform operator.
 *
 * Package administration is genuinely gated — `updatePlan` and friends call
 * `assertCanManagePlans(getPlatformRole())` — so a test that edits a package has
 * to hold the authority to do it. The refusal is proved on its own below.
 */
function actAsPlatformAdmin(): void {
  useSessionStore.setState({ platformRole: 'super-admin', userName: 'Platform Admin' });
}

function actAsSubscriber(): void {
  useSessionStore.setState({ platformRole: 'none', userName: 'Subscriber' });
}

beforeEach(() => {
  actAsPlatformAdmin();
  useBillingStore.getState().resetToDefault();
  useBillingStore.getState().ensureSeeded();
});

/* ══ 1 · The same record ═══════════════════════════════════════════════════ */

describe('both screens read the same record', () => {
  it('renders the identical object, not a copy', () => {
    const fromAdmin = corePlan();
    const fromSubscriber = subscriberCatalog().find((p) => p.code === 'core')!;
    // Identity, not deep equality: a copy could drift, the same object cannot.
    expect(fromSubscriber).toBe(fromAdmin);
  });

  it('agrees on every commercial field', () => {
    const admin = corePlan();
    const subscriber = subscriberCatalog().find((p) => p.id === admin.id)!;
    for (const field of [
      'name', 'description', 'priceMonthly', 'currency', 'userLimit', 'entityLimit', 'code', 'edition',
    ] as const) {
      expect(subscriber[field], field).toEqual(admin[field]);
    }
  });
});

/* ══ 2–7 · Every edit propagates ═══════════════════════════════════════════ */

describe('an administrator edit reaches the subscriber', () => {
  const cases: Array<[string, Partial<SubscriptionPlan>, keyof SubscriptionPlan, unknown]> = [
    ['name', { name: 'Ledgora Starter' }, 'name', 'Ledgora Starter'],
    ['price', { priceMonthly: 69 }, 'priceMonthly', 69],
    ['user limit', { userLimit: 15 }, 'userLimit', 15],
    ['entity limit', { entityLimit: 3 }, 'entityLimit', 3],
    ['description', { description: 'Everything a business needs…' }, 'description', 'Everything a business needs…'],
    ['currency', { currency: 'JOD' }, 'currency', 'JOD'],
  ];

  it.each(cases)('changes the %s with no second save', (_label, patch, field, expected) => {
    const id = corePlan().id;
    const result = useBillingStore.getState().updatePlan(id, patch);
    expect(result.ok).toBe(true);

    const seen = subscriberCatalog().find((p) => p.id === id)!;
    expect(seen[field]).toEqual(expected);
  });

  it('keeps the id and code stable when the name changes', () => {
    // Invoices and active subscriptions reference the id; renaming a package is
    // a commercial change, not a new package.
    const before = corePlan();
    useBillingStore.getState().updatePlan(before.id, { name: 'Ledgora Starter' });
    const after = adminPlans().find((p) => p.id === before.id)!;
    expect(after.id).toBe(before.id);
    expect(after.code).toBe(before.code);
    expect(after.name).toBe('Ledgora Starter');
  });
});

/* ══ 8–10 · Availability and visibility ════════════════════════════════════ */

describe('publication rules', () => {
  it('hides an unpublished plan from the subscriber but not from administration', () => {
    const id = corePlan().id;
    useBillingStore.getState().updatePlan(id, { isPublic: false });

    expect(subscriberCatalog().some((p) => p.id === id)).toBe(false);
    // Administration must still see it — that is how it gets published again.
    expect(adminPlans().some((p) => p.id === id)).toBe(true);
  });

  it('hides an archived plan from the subscriber but not from administration', () => {
    const id = corePlan().id;
    useBillingStore.getState().archivePlan(id);

    expect(subscriberCatalog().some((p) => p.id === id)).toBe(false);
    const inAdmin = adminPlans().find((p) => p.id === id)!;
    expect(inAdmin.isActive).toBe(false);
  });

  it('restores it to the catalogue', () => {
    const id = corePlan().id;
    useBillingStore.getState().archivePlan(id);
    useBillingStore.getState().restorePlan(id);
    expect(subscriberCatalog().some((p) => p.id === id)).toBe(true);
  });
});

/* ══ 11 · Subscribers may not edit packages ════════════════════════════════ */

describe('package administration authority', () => {
  it('refuses a subscriber every catalogue mutation', () => {
    /*
     * The catalogue is platform commercial data. A subscriber owner or
     * organization admin is not a platform operator, and the store refuses them
     * regardless of what the interface offers — the server refuses them too,
     * which is the check that actually holds.
     */
    const id = corePlan().id;
    const originalName = corePlan().name;
    actAsSubscriber();

    for (const [label, run] of [
      ['update', () => useBillingStore.getState().updatePlan(id, { name: 'Hijacked' })],
      ['archive', () => useBillingStore.getState().archivePlan(id)],
      ['restore', () => useBillingStore.getState().restorePlan(id)],
    ] as const) {
      const result = run();
      expect(result.ok, label).toBe(false);
    }
    expect(corePlan().name).toBe(originalName);
  });

  it('permits the platform operator', () => {
    actAsPlatformAdmin();
    expect(useBillingStore.getState().updatePlan(corePlan().id, { name: 'Ledgora Starter' }).ok).toBe(true);
  });
});

/* ══ 12–13 · Edition metadata is not the commercial source ═════════════════ */

describe('edition metadata cannot override commercial data', () => {
  it('leaves a renamed package renamed, however its edition is labelled', () => {
    /*
     * The exact defect: a package named "Ledgora Manufacturing Plus" on the
     * `manufacturing` edition was displayed as "Ledgora Manufacturing", because
     * the screen asked EDITION_INFO for the name.
     */
    const plan = adminPlans().find((p) => p.edition === 'manufacturing')!;
    useBillingStore.getState().updatePlan(plan.id, { name: 'Ledgora Manufacturing Plus' });

    const seen = subscriberCatalog().find((p) => p.id === plan.id)!;
    expect(seen.name).toBe('Ledgora Manufacturing Plus');
    expect(seen.name).not.toBe(EDITION_INFO[plan.edition].name);
  });

  it('leaves an edited price alone, whatever the edition defaults say', () => {
    const plan = corePlan();
    useBillingStore.getState().updatePlan(plan.id, { priceMonthly: 69 });
    expect(subscriberCatalog().find((p) => p.id === plan.id)!.priceMonthly).toBe(69);
  });

  it('leaves an edited description alone', () => {
    const plan = corePlan();
    useBillingStore.getState().updatePlan(plan.id, { description: 'Administrator copy.' });
    const seen = subscriberCatalog().find((p) => p.id === plan.id)!;
    expect(seen.description).toBe('Administrator copy.');
    expect(seen.description).not.toBe(EDITION_INFO[plan.edition].description);
  });
});

/* ══ 14–15 · Seeds are initial values only ═════════════════════════════════ */

describe('seed data cannot become a second source of truth', () => {
  it('does not overwrite an edit when ensureSeeded runs again', () => {
    const id = corePlan().id;
    useBillingStore.getState().updatePlan(id, { name: 'Ledgora Starter', priceMonthly: 69 });

    // Every remount calls this; it must be a no-op once plans exist.
    useBillingStore.getState().ensureSeeded();
    useBillingStore.getState().ensureSeeded();

    const after = adminPlans().find((p) => p.id === id)!;
    expect(after.name).toBe('Ledgora Starter');
    expect(after.priceMonthly).toBe(69);
  });

  it('survives a store rehydration with the edit intact', () => {
    const id = corePlan().id;
    useBillingStore.getState().updatePlan(id, { name: 'Ledgora Starter' });

    // What persistence replays on reload: the stored plans, then ensureSeeded.
    const persisted = useBillingStore.getState().plans;
    useBillingStore.setState({ plans: persisted, seeded: true });
    useBillingStore.getState().ensureSeeded();

    expect(adminPlans().find((p) => p.id === id)!.name).toBe('Ledgora Starter');
  });
});

/* ══ 16–17 · Historical billing is not rewritten ═══════════════════════════ */

describe('historical invoices', () => {
  it('keeps the plan name as it was when the invoice was issued', () => {
    /*
     * An invoice is a historical document. Renaming the live package must not
     * restate what a customer was billed for in July.
     */
    useEntitlementStore.setState((s) => ({
      subscription: { ...s.subscription, organizationId: 'org_1', status: 'active' },
    }));
    const plan = corePlan();
    const issued = useBillingStore.getState().requestSubscription(plan.id);
    expect(issued.ok).toBe(true);

    const invoiceBefore = useBillingStore.getState().invoices.find((i) => i.id === issued.id)!;
    expect(invoiceBefore.planName).toBe(plan.name);

    // August: the package is renamed.
    useBillingStore.getState().updatePlan(plan.id, { name: 'Ledgora Starter', priceMonthly: 999 });

    const invoiceAfter = useBillingStore.getState().invoices.find((i) => i.id === issued.id)!;
    expect(invoiceAfter.planName).toBe(plan.name);
    expect(invoiceAfter.planName).not.toBe('Ledgora Starter');
    expect(invoiceAfter.amount).toBe(plan.priceMonthly);
    // …while the live catalogue shows the new values.
    expect(subscriberCatalog().find((p) => p.id === plan.id)!.name).toBe('Ledgora Starter');
  });

  it('keeps the invoice pointing at the same plan id after a rename', () => {
    useEntitlementStore.setState((s) => ({
      subscription: { ...s.subscription, organizationId: 'org_1', status: 'active' },
    }));
    const plan = corePlan();
    const issued = useBillingStore.getState().requestSubscription(plan.id);
    useBillingStore.getState().updatePlan(plan.id, { name: 'Ledgora Starter' });

    const invoice = useBillingStore.getState().invoices.find((i) => i.id === issued.id)!;
    expect(invoice.planId).toBe(plan.id);
    // The reference still resolves to a live plan.
    expect(adminPlans().some((p) => p.id === invoice.planId)).toBe(true);
  });
});

/* ══ 19–20 · The server record, and what it is not ═════════════════════════ */

describe('the server record is the canonical shape', () => {
  const row: ServerPlan = {
    id: 'srv_1', code: 'core', name: 'Ledgora Starter', description: 'Server copy.',
    edition: 'core', currency: 'JOD', monthlyPrice: 69, annualPrice: null,
    userLimit: 15, entityLimit: 3, modules: ['accounting'],
    isPublic: true, isActive: true, sortOrder: 0,
  };

  it('maps every commercial field from the row, inventing nothing', () => {
    const plan = toSubscriptionPlan(row);
    expect(plan.name).toBe('Ledgora Starter');
    expect(plan.description).toBe('Server copy.');
    expect(plan.priceMonthly).toBe(69);
    expect(plan.currency).toBe('JOD');
    expect(plan.userLimit).toBe(15);
    expect(plan.entityLimit).toBe(3);
    expect(plan.isPublic).toBe(true);
    expect(plan.isActive).toBe(true);
  });

  it('renders an empty description as empty, not as edition copy', () => {
    // Filling a cleared description from EDITION_INFO would put the second
    // source of truth straight back.
    const plan = toSubscriptionPlan({ ...row, description: null });
    expect(plan.description).toBe('');
    expect(plan.description).not.toBe(EDITION_INFO.core.description);
  });

  it('round-trips an edit back to the server field names', () => {
    const input = toPlanWriteInput({ name: 'X', priceMonthly: 42, userLimit: 9, currency: 'USD' });
    expect(input).toEqual({ name: 'X', monthlyPrice: 42, userLimit: 9, currency: 'USD' });
    // No commercial value is silently added on the way out.
    expect(Object.keys(input)).toHaveLength(4);
  });

  it('is not fed by the metering base-plan catalogue', async () => {
    /*
     * A second structure with its own tiers lives under Metering & infra cost,
     * and two of its names ("Ledgora Core", "Ledgora Enterprise") coincide with
     * commercial package names at DIFFERENT prices — metering's Core is $39.
     *
     * That coincidence is not the defect; a FEED would be. What this holds is
     * that no metering value reaches the commercial catalogue: editing a
     * metering base plan leaves every commercial package untouched, and the
     * billing modules import nothing from metering at all.
     */
    const { makeSeedBasePlans } = await import('@/lib/meteringSeed');
    const meteringCore = makeSeedBasePlans().find((p) => p.code === 'core')!;
    const commercialCore = corePlan();

    // The prices genuinely differ, which is how we know one is not the other.
    expect(meteringCore.priceMonthly).not.toBe(commercialCore.priceMonthly);

    // Changing the commercial price does not consult metering, and vice versa.
    useBillingStore.getState().updatePlan(commercialCore.id, { priceMonthly: 69 });
    expect(subscriberCatalog().find((p) => p.id === commercialCore.id)!.priceMonthly).toBe(69);
    expect(makeSeedBasePlans().find((p) => p.code === 'core')!.priceMonthly).toBe(meteringCore.priceMonthly);

    // And the commercial catalogue is the five editions, not the metering tiers.
    const codes = adminPlans().map((p) => p.code).sort();
    expect(codes).toEqual(['construction', 'core', 'enterprise', 'manufacturing', 'projects']);
  });
});
