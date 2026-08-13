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
