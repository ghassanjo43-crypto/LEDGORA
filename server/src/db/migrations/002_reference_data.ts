/**
 * Reference data: the public package catalogue, billing settings and the
 * placeholder bank details.
 *
 * These live in the database (not the browser) so a platform administrator is
 * the only party who can change what customers are offered and where they are
 * told to send money.
 *
 * `is_placeholder` starts true: the frontend shows a "do not transfer real
 * money" warning until an administrator saves genuine account details.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

/** Mirrors the editions the existing frontend entitlement engine understands. */
const PLANS = [
  {
    code: 'core',
    name: 'Core',
    description: 'Double-entry accounting, invoicing and IFRS statements for a single company.',
    edition: 'core',
    monthly: '49.00',
    annual: '490.00',
    users: 3,
    entities: 1,
    modules: ['accounting', 'invoicing', 'reports'],
    sort: 1,
  },
  {
    code: 'professional',
    name: 'Professional',
    description: 'Adds inventory, multi-currency and cost centres for a growing business.',
    edition: 'professional',
    monthly: '99.00',
    annual: '990.00',
    users: 10,
    entities: 2,
    modules: ['accounting', 'invoicing', 'reports', 'inventory_basic', 'cost_centers', 'multi_currency'],
    sort: 2,
  },
  {
    code: 'business',
    name: 'Business',
    description: 'Projects, advanced inventory and consolidation across multiple companies.',
    edition: 'business',
    monthly: '179.00',
    annual: '1790.00',
    users: 25,
    entities: 5,
    modules: [
      'accounting', 'invoicing', 'reports', 'inventory_basic', 'inventory_advanced',
      'cost_centers', 'multi_currency', 'projects', 'multi_entity',
    ],
    sort: 3,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    description: 'Manufacturing, construction and unlimited companies with full entitlements.',
    edition: 'enterprise',
    monthly: '349.00',
    annual: '3490.00',
    users: 100,
    entities: 25,
    modules: [
      'accounting', 'invoicing', 'reports', 'inventory_basic', 'inventory_advanced',
      'cost_centers', 'multi_currency', 'projects', 'multi_entity', 'manufacturing', 'construction',
    ],
    sort: 4,
  },
];

export async function up(db: AnyKysely): Promise<void> {
  for (const plan of PLANS) {
    await sql`
      INSERT INTO subscription_plans
        (code, name, description, edition, currency, monthly_price, annual_price,
         user_limit, entity_limit, module_entitlements, is_public, is_active, sort_order)
      VALUES
        (${plan.code}, ${plan.name}, ${plan.description}, ${plan.edition}, 'USD',
         ${plan.monthly}, ${plan.annual}, ${plan.users}, ${plan.entities},
         ${JSON.stringify(plan.modules)}::jsonb, true, true, ${plan.sort})
      ON CONFLICT (code) DO NOTHING
    `.execute(db);
  }

  // Single-row configuration tables; seeded only when empty.
  await sql`
    INSERT INTO billing_settings (currency, payment_due_days, grace_days, term_months)
    SELECT 'USD', 7, 7, 1
    WHERE NOT EXISTS (SELECT 1 FROM billing_settings)
  `.execute(db);

  await sql`
    INSERT INTO bank_details
      (bank_name, account_name, account_number, iban, swift, branch, instructions, is_placeholder)
    SELECT
      'Example Bank (placeholder)', 'LEDGORA Software', '0000000000',
      'XX00 0000 0000 0000 0000 00', 'EXAMPLEX', 'Head Office',
      'Transfer the invoice total to the account below and quote the LEDGORA payment reference exactly as shown. Upload the transfer receipt for verification.',
      true
    WHERE NOT EXISTS (SELECT 1 FROM bank_details)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DELETE FROM subscription_plans WHERE code IN ('core','professional','business','enterprise')`.execute(db);
  await sql`DELETE FROM billing_settings`.execute(db);
  await sql`DELETE FROM bank_details`.execute(db);
}
