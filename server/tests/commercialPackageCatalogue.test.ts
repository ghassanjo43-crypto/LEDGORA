/**
 * The database holds Ledgora's COMMERCIAL package catalogue.
 *
 * ══ What was wrong ═══════════════════════════════════════════════════════════
 *
 * `subscription_plans` was seeded with a four-tier list — Core, Professional,
 * Business, Enterprise — on editions that are not Ledgora's. The product sells
 * five packages on five editions. So the platform's own database disagreed with
 * the product, and the Super Admin console (reading the server) and the
 * subscriber catalogue (falling back to the browser seed) were showing two
 * different catalogues entirely.
 *
 * Migration 014 brings the database into line without deleting anything a
 * subscription might point at, and without overwriting an operator's edits.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import { PERMISSION_SUBJECTS, findSubject } from '../src/config/permissionCatalog.js';
import { PACKAGE_CODES, allSoldModules, modulesForPackage, type PackageCode } from '../src/config/packageCatalogue.js';

let ctx: TestContext;

interface PlanRow {
  code: string;
  name: string;
  edition: string;
  monthly_price: string;
  user_limit: number;
  entity_limit: number;
  is_public: boolean;
  is_active: boolean;
  sort_order: number;
}

async function plans(): Promise<PlanRow[]> {
  const { rows } = await sql<PlanRow>`
    SELECT code, name, edition, monthly_price, user_limit, entity_limit,
           is_public, is_active, sort_order
      FROM subscription_plans ORDER BY sort_order, code
  `.execute(ctx.db);
  return rows;
}

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

describe('the seeded catalogue', () => {
  it('contains the five commercial packages', async () => {
    const published = (await plans()).filter((p) => p.is_public && p.is_active);
    expect(published.map((p) => p.code)).toEqual([
      'core', 'projects', 'construction', 'manufacturing', 'enterprise',
    ]);
    expect(published.map((p) => p.name)).toEqual([
      'Ledgora Core',
      'Ledgora Projects',
      'Ledgora Construction',
      'Ledgora Manufacturing',
      'Ledgora Enterprise',
    ]);
  });

  it('maps each package to a Ledgora edition, not a pricing tier', async () => {
    const published = (await plans()).filter((p) => p.is_public);
    expect(published.map((p) => p.edition)).toEqual([
      'core', 'projects', 'construction', 'manufacturing', 'enterprise',
    ]);
    // The tier editions are not commercial editions and must not be on offer.
    expect(published.some((p) => p.edition === 'professional')).toBe(false);
    expect(published.some((p) => p.edition === 'business')).toBe(false);
  });

  it('keeps the superseded tiers as records but out of the catalogue', async () => {
    /*
     * `subscriptions.plan_id` references this table with ON DELETE RESTRICT, so
     * an organization already on `professional` must keep resolving. They are
     * unpublished, not deleted.
     */
    const all = await plans();
    for (const code of ['professional', 'business']) {
      const row = all.find((p) => p.code === code);
      expect(row, code).toBeDefined();
      expect(row!.is_public, code).toBe(false);
    }
  });

  it('carries the commercial prices and limits', async () => {
    const all = await plans();
    const core = all.find((p) => p.code === 'core')!;
    expect(Number(core.monthly_price)).toBe(29);
    expect(core.user_limit).toBe(3);
    expect(core.entity_limit).toBe(1);

    const enterprise = all.find((p) => p.code === 'enterprise')!;
    expect(Number(enterprise.monthly_price)).toBe(249);
  });

  it('keeps every code unique', async () => {
    const codes = (await plans()).map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('never gates a permission subject on a module no package sells', async () => {
    /*
     * The invariant `fixed_assets` broke. It had a module, a navigation group
     * and its own edition tier, but appeared in no package's module list — so
     * every Fixed Assets permission resolved "not in package" for every
     * subscriber, Enterprise included. Stated generally: a subject gated on a
     * module nobody can buy is a feature that is visible everywhere and
     * permitted nowhere.
     */
    const sold = new Set(allSoldModules());
    const unreachable = PERMISSION_SUBJECTS
      .filter((subject) => subject.requiredModule !== null && !sold.has(subject.requiredModule))
      .map((subject) => `${subject.id} (needs ${subject.requiredModule})`);
    expect(unreachable, 'no package sells the module these subjects require').toEqual([]);
  });

  it('sells every module the canonical catalogue says each package includes', async () => {
    const { rows } = await sql<{ code: string; modules: string[] }>`
      SELECT code, module_entitlements AS modules FROM subscription_plans
       WHERE code = ANY(${sql.raw(`ARRAY[${PACKAGE_CODES.map((c) => `'${c}'`).join(',')}]`)})
    `.execute(ctx.db);
    expect(rows).toHaveLength(PACKAGE_CODES.length);

    for (const row of rows) {
      const missing = modulesForPackage(row.code as PackageCode)
        .filter((module) => !row.modules.includes(module));
      expect(missing, `${row.code} is missing entitlements it is sold with`).toEqual([]);
    }
  });

  it('includes the asset register and currency master data in every package', async () => {
    /*
     * Both ship in the Core edition of the frontend registry, so both must be
     * sellable from Core upwards. `multi_currency` is the coarse id behind
     * currency MASTER DATA; advanced FX is `currency_advanced`, a different
     * module this says nothing about.
     */
    const { rows } = await sql<{ code: string; modules: string[] }>`
      SELECT code, module_entitlements AS modules
        FROM subscription_plans WHERE is_public AND is_active
    `.execute(ctx.db);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.modules, `${row.code} must sell the asset register`).toContain('fixed_assets');
      expect(row.modules, `${row.code} must sell currency master data`).toContain('multi_currency');
    }
  });

  it('does not leave an entitlement cache that still hides a restored module', async () => {
    /*
     * `organization_entitlements` is a derived cache and `getEntitlements`
     * prefers it to recomputation, so repairing the plans alone would fix
     * nothing for an existing subscriber. Any cached row that no longer covers
     * its own plan's modules must be gone, so the next read rebuilds it.
     */
    const { rows } = await sql<{ organization_id: string; plan_code: string }>`
      SELECT e.organization_id, e.plan_code
        FROM organization_entitlements e
        JOIN subscription_plans p ON p.id = e.plan_id
       WHERE NOT (e.modules @> p.module_entitlements)
    `.execute(ctx.db);
    expect(rows, 'cached entitlements narrower than the plan they name').toEqual([]);
  });

  it('sells cost centers with manufacturing, which structurally depends on them', async () => {
    // `manufacturing_core` and `manufacturing_work_centers` both declare a
    // dependency on cost centers; a work center has nowhere to post without one.
    const { rows } = await sql<{ modules: string[] }>`
      SELECT module_entitlements AS modules FROM subscription_plans WHERE code = 'manufacturing'
    `.execute(ctx.db);
    expect(rows[0]!.modules).toContain('cost_centers');
  });

  it('entitles opening balances in every paid package', async () => {
    /*
     * Opening balances are how a customer's existing books arrive in Ledgora.
     * A package that sells bookkeeping but withholds the migration is not a
     * sellable package, so this is asserted against the module the
     * `opening_balances` subject is actually gated on rather than against a
     * hand-copied list that could drift from the catalogue.
     */
    const required = findSubject('opening_balances')?.requiredModule;
    expect(required).toBe('accounting');

    const { rows } = await sql<{ code: string; modules: string[] }>`
      SELECT code, module_entitlements AS modules
        FROM subscription_plans WHERE is_public AND is_active ORDER BY sort_order
    `.execute(ctx.db);
    expect(rows.length).toBeGreaterThan(0);
    for (const plan of rows) {
      expect(plan.modules, `${plan.code} must entitle opening balances`).toContain(required);
    }
  });

  it('never records a negative price or an impossible limit', async () => {
    for (const plan of await plans()) {
      expect(Number(plan.monthly_price), plan.code).toBeGreaterThanOrEqual(0);
      expect(plan.user_limit, plan.code).toBeGreaterThanOrEqual(1);
      expect(plan.entity_limit, plan.code).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('an operator’s edits', () => {
  it('are not overwritten when the migration runs again', async () => {
    /*
     * The migration updates a row only while it still holds the seeded values —
     * `updated_at = created_at`. Once the console has touched a package, the
     * migration leaves it alone, so re-running deployment never restores a name
     * an administrator deliberately changed.
     */
    await sql`
      UPDATE subscription_plans
         SET name = 'Ledgora Essential', monthly_price = 35, updated_at = now() + interval '1 second'
       WHERE code = 'core'
    `.execute(ctx.db);

    const { up } = await import('../src/db/migrations/014_commercial_package_catalogue.js');
    await up(ctx.db);

    const core = (await plans()).find((p) => p.code === 'core')!;
    expect(core.name).toBe('Ledgora Essential');
    expect(Number(core.monthly_price)).toBe(35);
  });

  it('leaves the package identity stable across a rename', async () => {
    const { rows: before } = await sql<{ id: string; code: string }>`
      SELECT id, code FROM subscription_plans WHERE code = 'core'
    `.execute(ctx.db);

    await sql`UPDATE subscription_plans SET name = 'Renamed', updated_at = now() WHERE code = 'core'`
      .execute(ctx.db);

    const { rows: after } = await sql<{ id: string; code: string }>`
      SELECT id, code FROM subscription_plans WHERE code = 'core'
    `.execute(ctx.db);

    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.code).toBe('core');
  });
});
