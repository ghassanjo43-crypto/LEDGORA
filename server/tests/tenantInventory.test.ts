/**
 * The inventory must describe the database that actually exists.
 *
 * This is the test that makes the inventory more than documentation: it reads
 * the live catalogue and fails when a table gains a foreign key to
 * `organizations` without anybody deciding what a deletion should do with it.
 * The failure arrives when the migration is written, not months later when a
 * destroyed tenant's rows are found still sitting in a table nobody remembered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import {
  TENANT_DEPENDENCIES,
  DELETION_SEQUENCE,
  organizationReferencingTables,
} from '../src/services/tenantInventory.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

describe('the tenant dependency inventory', () => {
  it('records a decision for every table that references organizations', async () => {
    const referencing = await organizationReferencingTables(ctx.db);
    const decided = new Set(TENANT_DEPENDENCIES.map((d) => d.table as string));

    const undecided = referencing.filter((table) => !decided.has(table));

    expect(
      undecided,
      `These tables reference organizations(id) but have no entry in TENANT_DEPENDENCIES. ` +
        `Add one recording ownership, disposition and order before a cleanup can be trusted: ${undecided.join(', ')}`,
    ).toEqual([]);
  });

  it('names only tables that exist', async () => {
    const referencing = new Set(await organizationReferencingTables(ctx.db));
    const platformOwned = new Set([
      // Referenced by nothing org-keyed, but reviewed and recorded as retained.
      'users',
      'auth_sessions',
      'password_reset_tokens',
      'platform_user_roles',
      'subscription_plans',
      'billing_settings',
      'bank_details',
      'payment_proofs',
      'organizations',
    ]);

    for (const dependency of TENANT_DEPENDENCIES) {
      if (dependency.table.startsWith('external:')) continue;
      expect(
        referencing.has(dependency.table as string) || platformOwned.has(dependency.table as string),
        `${dependency.table} is in the inventory but is neither organization-referencing nor a reviewed platform table.`,
      ).toBe(true);
    }
  });

  it('orders children strictly before the organization itself', () => {
    const organizations = DELETION_SEQUENCE.find((d) => d.table === 'organizations');
    expect(organizations).toBeDefined();

    for (const dependency of DELETION_SEQUENCE) {
      if (dependency.table === 'organizations') continue;
      expect(
        dependency.order,
        `${dependency.table} must be deleted before organizations.`,
      ).toBeLessThan(organizations!.order);
    }
  });

  it('deletes payment proofs before the invoices they hang from', () => {
    const proofs = TENANT_DEPENDENCIES.find((d) => d.table === 'payment_proofs')!;
    const invoices = TENANT_DEPENDENCIES.find((d) => d.table === 'subscription_invoices')!;
    expect(proofs.order).toBeLessThan(invoices.order);
  });

  it('never marks a cross-tenant-reachable table for deletion', () => {
    /*
     * The rule that prevents collateral damage: if another organization or the
     * platform can reach a row, a tenant deletion may not destroy it.
     */
    for (const dependency of TENANT_DEPENDENCIES) {
      if (!dependency.crossTenantReachable) continue;
      expect(
        dependency.disposition,
        `${dependency.table} is reachable from outside this tenant and must not be deleted.`,
      ).not.toBe('delete');
    }
  });

  it('gives every dependency a rationale', () => {
    for (const dependency of TENANT_DEPENDENCIES) {
      expect(dependency.rationale.length, `${dependency.table} has no rationale.`).toBeGreaterThan(20);
    }
  });
});
