/**
 * Align the canonical package catalogue with Ledgora's COMMERCIAL packages.
 *
 * ══ The problem this fixes ═══════════════════════════════════════════════════
 *
 * `subscription_plans` was seeded by migration 002 with a four-tier list —
 * Core / Professional / Business / Enterprise — whose editions are
 * `core, professional, business, enterprise`. Ledgora's commercial catalogue is
 * five packages on five editions:
 *
 *   Ledgora Core · Projects · Construction · Manufacturing · Enterprise
 *
 * So the platform's own database disagreed with the product. The Super Admin
 * editor (reading the server) and the subscriber catalogue (falling back to the
 * browser seed) were therefore not merely out of step — they were showing two
 * DIFFERENT CATALOGUES, which is why renaming a package in the console never
 * appeared to the subscriber.
 *
 * ══ Why nothing is deleted ═══════════════════════════════════════════════════
 *
 * `subscriptions.plan_id` references this table with ON DELETE RESTRICT, and an
 * organization may already be subscribed to `professional` or `business`.
 * Deleting them would either fail or orphan a paying customer's subscription, so
 * they are UNPUBLISHED instead: they leave the catalogue, keep their identity,
 * and any subscription pointing at them keeps resolving. That is the same
 * archive semantics the console's own "archive" action uses.
 *
 * ══ Why edits are preserved ══════════════════════════════════════════════════
 *
 * `core` and `enterprise` already exist and an administrator may have edited
 * them. The update below therefore touches a row ONLY while it still holds the
 * exact seeded values from 002 — an operator's rename, reprice or limit change
 * is never overwritten by a migration. A fresh database gets the commercial
 * catalogue; an edited one keeps its edits.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

/** The commercial catalogue, matching `config/editionCommercialInfo` in the app. */
const COMMERCIAL_PLANS = [
  {
    code: 'core',
    name: 'Ledgora Core',
    description:
      'Everything a business needs to keep clean, IFRS-aligned books: accounting, sales, purchases, statements and standard tax and currency support.',
    edition: 'core',
    monthly: '29.00',
    annual: '290.00',
    users: 3,
    entities: 1,
    modules: ['accounting', 'invoicing', 'reports'],
    sort: 0,
  },
  {
    code: 'projects',
    name: 'Ledgora Projects',
    description:
      'Everything in Core plus cost centers and full project accounting — budgets, time and expenses, billing, profitability and project cash flow.',
    edition: 'projects',
    monthly: '59.00',
    annual: '590.00',
    users: 10,
    entities: 2,
    modules: ['accounting', 'invoicing', 'reports', 'cost_centers', 'projects'],
    sort: 1,
  },
  {
    code: 'construction',
    name: 'Ledgora Construction',
    description:
      'Everything in Projects plus construction financial control — WBS, cost codes, BOQ, progress billing, retention, subcontracts, WIP and revenue recognition.',
    edition: 'construction',
    monthly: '99.00',
    annual: '990.00',
    users: 25,
    entities: 5,
    modules: ['accounting', 'invoicing', 'reports', 'cost_centers', 'projects', 'construction'],
    sort: 2,
  },
  {
    code: 'manufacturing',
    name: 'Ledgora Manufacturing',
    description:
      'Manufacturing accounting, production control, inventory costing and plant performance from one reliable ledger — Core plus inventory, warehouses, BOM, routings, work orders and product costing.',
    edition: 'manufacturing',
    monthly: '119.00',
    annual: '1190.00',
    users: 25,
    entities: 3,
    modules: ['accounting', 'invoicing', 'reports', 'inventory_basic', 'inventory_advanced', 'manufacturing'],
    sort: 3,
  },
  {
    code: 'enterprise',
    name: 'Ledgora Enterprise',
    description:
      'All stable modules plus multi-entity consolidation, advanced approvals, permissions and custom reporting.',
    edition: 'enterprise',
    monthly: '249.00',
    annual: '2490.00',
    users: 999,
    entities: 999,
    modules: [
      'accounting', 'invoicing', 'reports', 'inventory_basic', 'inventory_advanced',
      'cost_centers', 'multi_currency', 'projects', 'construction', 'manufacturing', 'multi_entity',
    ],
    sort: 4,
  },
] as const;

/** The codes migration 002 seeded that are NOT commercial packages. */
const SUPERSEDED_CODES = ['professional', 'business'] as const;

export async function up(db: AnyKysely): Promise<void> {
  for (const plan of COMMERCIAL_PLANS) {
    /*
     * Insert when absent. On conflict, update ONLY a row that still carries the
     * 002 seed values — `updated_at = created_at` is the marker that nobody has
     * touched it through the console, whose update path always stamps
     * `updated_at`. An administrator's edit therefore survives this migration.
     */
    await sql`
      INSERT INTO subscription_plans
        (code, name, description, edition, currency, monthly_price, annual_price,
         user_limit, entity_limit, module_entitlements, is_public, is_active, sort_order)
      VALUES
        (${plan.code}, ${plan.name}, ${plan.description}, ${plan.edition}, 'USD',
         ${plan.monthly}, ${plan.annual}, ${plan.users}, ${plan.entities},
         ${JSON.stringify(plan.modules)}::jsonb, true, true, ${plan.sort})
      ON CONFLICT (code) DO UPDATE SET
        name                = EXCLUDED.name,
        description         = EXCLUDED.description,
        edition             = EXCLUDED.edition,
        monthly_price       = EXCLUDED.monthly_price,
        annual_price        = EXCLUDED.annual_price,
        user_limit          = EXCLUDED.user_limit,
        entity_limit        = EXCLUDED.entity_limit,
        module_entitlements = EXCLUDED.module_entitlements,
        sort_order          = EXCLUDED.sort_order,
        updated_at          = now()
      WHERE subscription_plans.updated_at = subscription_plans.created_at
    `.execute(db);
  }

  /*
   * The superseded tiers leave the catalogue but keep existing. A subscription
   * already pointing at one still resolves; it simply cannot be chosen again.
   */
  await sql`
    UPDATE subscription_plans
       SET is_public = false, updated_at = now()
     WHERE code = ANY(${sql.raw(`ARRAY[${SUPERSEDED_CODES.map((c) => `'${c}'`).join(',')}]`)})
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  // Republish the superseded tiers; the commercial rows are left in place
  // because removing them could orphan a subscription created since.
  await sql`
    UPDATE subscription_plans
       SET is_public = true, updated_at = now()
     WHERE code = ANY(${sql.raw(`ARRAY[${SUPERSEDED_CODES.map((c) => `'${c}'`).join(',')}]`)})
  `.execute(db);
}
