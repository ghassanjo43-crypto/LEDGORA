/**
 * DEVELOPMENT-ONLY reset of local subscriber data.
 *
 * ══ What this is, and what it must never become ═══════════════════════════════
 *
 * This empties a LOCAL development database of every customer/subscriber row so
 * a developer can start from subscriber #1 again. It is the single most
 * destructive operation in the codebase: it deletes tenants outright, with no
 * classification gate, no eligibility assessment, no cooling-off window and no
 * tombstone. Every safeguard the real deletion path spent `cleanupService` and
 * `deletionService` building is deliberately absent here.
 *
 * That is defensible for exactly one reason: it can only ever run against a
 * database that is provably local and provably not production. So the guards
 * below are not ceremony — they are the ONLY thing standing between this
 * function and a customer's data, and they are checked in the service (not the
 * CLI) so no future caller can reach the destruction without passing them.
 *
 * It is deliberately NOT exported through any route module. `devReset.test.ts`
 * asserts that no file under `src/routes` or `src/app.ts` imports it, so
 * "somebody wires it to an admin endpoint" is a failing test rather than a
 * discovery made in production.
 *
 * ══ How the delete set is decided ════════════════════════════════════════════
 *
 * Two sets, both computed from the database and never supplied by a caller:
 *
 *   doomed organizations — ALL of them. In a local reset there is no such thing
 *     as a platform-owned organization: every tenant is development data.
 *
 *   doomed users — every user with NO row in `platform_user_roles`. Platform
 *     authority is the preserve signal, because it is the one thing that cannot
 *     be recreated by signing up again: lose the last super admin and the
 *     console is unreachable. Ordinary members are recreated in seconds.
 *
 * Preserving a user does NOT preserve their memberships: an admin who happened
 * to join a development tenant loses that membership along with the tenant, and
 * the identity survives. Nothing here ever inserts a membership, so a preserved
 * admin cannot be planted inside a subscriber organization by this operation.
 *
 * ══ Why the plan is a value, and why the catalogue is consulted ══════════════
 *
 * `RESET_PLAN` records an explicit disposition for every table, and
 * `assertPlanCoversCatalogue` reads the live foreign-key catalogue and REFUSES
 * to run when a table references `organizations` or `users` without a decision
 * recorded here. This is the same argument `tenantInventory` makes: a
 * hand-written delete list is correct on the day it is written, and the next
 * migration silently invalidates it. Forgetting becomes a refusal instead of
 * orphaned rows or a foreign-key abort halfway through the destruction.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/schema.js';
import { organizationReferencingTables } from './tenantInventory.js';

/** The phrase, exactly. Nothing else is accepted. */
export const RESET_CONFIRMATION = 'RESET LOCAL LEDGORA SUBSCRIBER DATA';

/** Thrown by every guard. Carries a code so the CLI can report it plainly. */
export class DevResetRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DevResetRefused';
  }
}

/* ══ Guard 1: where are we pointed? ════════════════════════════════════════ */

export interface DatabaseTarget {
  host: string;
  port: number;
  database: string;
}

/**
 * Hostnames that are unambiguously this machine.
 *
 * An ALLOWLIST, not a blocklist. A blocklist of known providers can only refuse
 * the hosts somebody thought of; anything unrecognised — a new provider, a
 * colleague's machine, an SSH tunnel to staging — would be waved through. The
 * question that actually matters is "is this my own machine?", and only a
 * closed list can answer it.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal']);

/**
 * Managed-provider fingerprints.
 *
 * Redundant with the allowlist above — a Render host is not `localhost`, so it
 * is already refused. Kept because the refusal MESSAGE matters: "this looks like
 * Render" tells the operator what nearly happened, where "not a local host"
 * invites them to wonder whether the check is over-strict and reach for a flag
 * to disable it.
 */
const REMOTE_PROVIDER_PATTERNS: ReadonlyArray<{ pattern: RegExp; provider: string }> = [
  { pattern: /render\.com$|\.render\.internal$|dpg-[a-z0-9]+/i, provider: 'Render' },
  { pattern: /supabase\.(co|com|net)$|pooler\.supabase/i, provider: 'Supabase' },
  { pattern: /neon\.(tech|build)$|\.aws\.neon/i, provider: 'Neon' },
  { pattern: /railway\.(app|internal)$|rlwy\.net$/i, provider: 'Railway' },
  { pattern: /rds\.amazonaws\.com$/i, provider: 'AWS RDS' },
  { pattern: /postgres\.database\.azure\.com$/i, provider: 'Azure' },
  { pattern: /db\.ondigitalocean\.com$/i, provider: 'DigitalOcean' },
  { pattern: /planetscale|psdb\.cloud$/i, provider: 'PlanetScale' },
  { pattern: /cockroachlabs\.cloud$/i, provider: 'Cockroach Cloud' },
  { pattern: /heroku|amazonaws\.com$|\.gcp\.|cloudsql/i, provider: 'a managed cloud host' },
];

/**
 * Read the target out of the connection string WITHOUT ever surfacing
 * credentials.
 *
 * The URL is parsed and only host/port/database are returned, so nothing that
 * flows onward to a console, a log or an error message can carry the password.
 */
export function describeTarget(databaseUrl: string): DatabaseTarget {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new DevResetRefused('unparseable_database_url', 'DATABASE_URL is not a valid connection URL.');
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    // Leading slash removed; an empty path means the driver's default.
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || '(default)',
  };
}

export interface GuardInput {
  nodeEnv: string;
  isProduction: boolean;
  databaseUrl: string;
  /** The database the operator states they are resetting. Must match. */
  expectedDatabase?: string;
}

/**
 * Every environment check, in one place, before a single row is read.
 *
 * Ordered cheapest-and-most-fundamental first, so the message an operator sees
 * names the most serious problem rather than an incidental one.
 */
export function assertLocalDevelopmentTarget(input: GuardInput): DatabaseTarget {
  if (input.isProduction || input.nodeEnv === 'production') {
    throw new DevResetRefused(
      'production_environment',
      `Refusing to run: NODE_ENV is "${input.nodeEnv}". This tool deletes subscriber data outright and has no place in production.`,
    );
  }

  if (!input.databaseUrl) {
    /*
     * Without a URL the app falls back to an ephemeral in-process PGlite
     * database. Resetting that would "succeed" against a store the developer
     * has never seen and leave the real local database untouched — a false
     * success is worse than a refusal.
     */
    throw new DevResetRefused(
      'no_database_url',
      'Refusing to run: DATABASE_URL is not set, so this would target a throwaway in-process database instead of your local PostgreSQL.',
    );
  }

  const target = describeTarget(input.databaseUrl);

  for (const { pattern, provider } of REMOTE_PROVIDER_PATTERNS) {
    if (pattern.test(target.host)) {
      throw new DevResetRefused(
        'remote_provider_host',
        `Refusing to run: the database host "${target.host}" looks like ${provider}. This tool only ever runs against a local development database.`,
      );
    }
  }

  if (!LOCAL_HOSTS.has(target.host.toLowerCase())) {
    throw new DevResetRefused(
      'non_local_host',
      `Refusing to run: "${target.host}" is not a local host. Only ${[...LOCAL_HOSTS].join(', ')} are accepted.`,
    );
  }

  if (/prod/i.test(target.database)) {
    // Cheap, and catches a local database restored from a production dump.
    throw new DevResetRefused(
      'production_database_name',
      `Refusing to run: the database name "${target.database}" contains "prod".`,
    );
  }

  if (input.expectedDatabase && input.expectedDatabase !== target.database) {
    throw new DevResetRefused(
      'database_name_mismatch',
      `Refusing to run: expected database "${input.expectedDatabase}" but DATABASE_URL points at "${target.database}".`,
    );
  }

  return target;
}

/* ══ The plan ══════════════════════════════════════════════════════════════ */

type PlanAction =
  /** Every row goes. */
  | 'truncate'
  /** Rows belonging to a doomed organization or user go. */
  | 'scoped_delete'
  /** Never touched. */
  | 'preserve';

interface PlanEntry {
  table: string;
  action: PlanAction;
  /** Ascending; children strictly before parents. */
  order: number;
  label: string;
  why: string;
}

/**
 * The deliberate order. Every constraint below is a real foreign key in the
 * live catalogue, not a guess:
 *
 *   · `payment_proofs.uploaded_by_user_id` is ON DELETE **RESTRICT**, so proofs
 *     must go before the users who uploaded them or the user delete aborts.
 *   · `payment_proofs.invoice_id` → invoices, so proofs go before invoices.
 *   · `audit_logs` is deleted BEFORE organizations and users. Both its links are
 *     ON DELETE SET NULL, so deleting the parents first would erase the very
 *     columns the audit scoping rule reads — the rows would become
 *     unclassifiable and survive as anonymous noise.
 *   · everything organization-scoped precedes `organizations`.
 *   · everything user-scoped precedes `users`.
 */
const RESET_PLAN: readonly PlanEntry[] = [
  {
    table: 'file_cleanup_queue',
    action: 'truncate',
    order: 10,
    label: 'File cleanup ledger',
    why: 'A retry ledger for development deletions. Nothing outlives the reset that created it.',
  },
  {
    table: 'cleanup_operations',
    action: 'truncate',
    order: 20,
    label: 'Cleanup operations',
    why: 'Idempotency records for past development purges; meaningless once their tenants are gone.',
  },
  {
    table: 'subscriber_deletion_tombstones',
    action: 'truncate',
    order: 30,
    label: 'Deletion tombstones',
    why: 'Evidence about development fixtures. Cleared by explicit local-reset policy — the production path never does this.',
  },
  /* ── Accounting books (Phase A) ────────────────────────────────────────
   * Children first: audit and versions, then lines, then entries, then the
   * accounts and periods they reference. A local reset clears them outright —
   * every organization is development data by definition here.
   */
  {
    table: 'accounting_audit_events',
    action: 'scoped_delete',
    order: 31,
    label: 'Accounting audit events',
    why: 'Evidence about development books; nothing outlives the reset that created it.',
  },
  {
    table: 'journal_entry_versions',
    action: 'scoped_delete',
    order: 32,
    label: 'Journal version history',
    why: 'Superseded snapshots of entries that are about to stop existing.',
  },
  {
    table: 'journal_lines',
    action: 'scoped_delete',
    order: 33,
    label: 'Journal lines',
    why: 'Deleted before their entries and before the accounts they point at.',
  },
  {
    table: 'journal_entries',
    action: 'scoped_delete',
    order: 34,
    label: 'Journal entries',
    why: 'The development ledger itself.',
  },
  {
    table: 'accounts',
    action: 'scoped_delete',
    order: 35,
    label: 'Chart of accounts',
    why: 'Removed after the journal lines that reference it.',
  },
  {
    table: 'accounting_periods',
    action: 'scoped_delete',
    order: 36,
    label: 'Accounting periods',
    why: 'The tenant open/closed calendar.',
  },
  {
    table: 'payment_proofs',
    action: 'scoped_delete',
    order: 40,
    label: 'Payment proofs',
    why: 'ON DELETE RESTRICT from its uploader, so it must precede the user delete. Its stored files are removed separately.',
  },
  {
    table: 'subscription_invoices',
    action: 'scoped_delete',
    order: 50,
    label: 'Subscription invoices',
    why: 'Billing rows of a doomed tenant.',
  },
  {
    table: 'subscriber_data_exports',
    action: 'scoped_delete',
    order: 60,
    label: 'Data exports',
    why: 'Holds a full JSON copy of the tenant; leaving it would preserve what the reset removes.',
  },
  {
    table: 'user_permission_overrides',
    action: 'scoped_delete',
    order: 70,
    label: 'Permission overrides',
    why: 'Per-organization grants, meaningless without the organization.',
  },
  {
    table: 'subscription_package_changes',
    action: 'scoped_delete',
    order: 80,
    label: 'Package change history',
    why: 'One tenant’s own plan history.',
  },
  {
    table: 'organization_entitlements',
    action: 'scoped_delete',
    order: 90,
    label: 'Entitlements',
    why: 'A derived cache of the subscription.',
  },
  {
    table: 'subscription_applications',
    action: 'scoped_delete',
    order: 100,
    label: 'Applicants / onboarding applications',
    why: 'ON DELETE SET NULL from organizations, so a cascade would strand the applicant. Scoped by organization OR user.',
  },
  {
    table: 'organization_memberships',
    action: 'scoped_delete',
    order: 110,
    label: 'Memberships',
    why: 'The link, never the person. A preserved admin loses the membership and keeps the account.',
  },
  {
    table: 'subscriptions',
    action: 'scoped_delete',
    order: 120,
    label: 'Subscriptions',
    why: 'One tenant’s billing relationship. Plans are RESTRICT-referenced and survive untouched.',
  },
  {
    table: 'audit_logs',
    action: 'scoped_delete',
    order: 130,
    label: 'Subscriber audit events',
    why: 'Tenant-scoped and customer-authored rows only. Platform/security history of preserved admins survives.',
  },
  {
    table: 'organizations',
    action: 'scoped_delete',
    order: 140,
    label: 'Organizations',
    why: 'The tenants themselves, after everything keyed to them.',
  },
  {
    table: 'password_reset_tokens',
    action: 'scoped_delete',
    order: 150,
    label: 'Invitations and reset tokens',
    why: 'Bearer credentials for identities that are about to stop existing.',
  },
  {
    table: 'auth_sessions',
    action: 'scoped_delete',
    order: 160,
    label: 'Sessions',
    why: 'No live session may outlast the identity behind it.',
  },
  {
    table: 'users',
    action: 'scoped_delete',
    order: 170,
    label: 'Ordinary users',
    why: 'Every identity holding no platform role. Platform operators are preserved by construction.',
  },
  /* ── Preserved. Listed explicitly so the catalogue guard can see a decision ── */
  {
    table: 'platform_user_roles',
    action: 'preserve',
    order: 900,
    label: 'Platform roles',
    why: 'The authority that makes the console reachable. Losing the last one is unrecoverable.',
  },
  {
    table: 'subscription_plans',
    action: 'preserve',
    order: 910,
    label: 'Subscription plan catalogue',
    why: 'Platform catalogue, not tenant data.',
  },
  {
    table: 'billing_settings',
    action: 'preserve',
    order: 920,
    label: 'Billing settings',
    why: 'A platform-wide singleton. Its `updated_by` is ON DELETE SET NULL and may be nulled.',
  },
  {
    table: 'bank_details',
    action: 'preserve',
    order: 930,
    label: 'Bank details',
    why: 'A platform-wide singleton. Its `updated_by` is ON DELETE SET NULL and may be nulled.',
  },
];

export const RESET_SEQUENCE = RESET_PLAN.filter((p) => p.action !== 'preserve').sort((a, b) => a.order - b.order);

/**
 * Refuse to run against a schema this plan has not been taught about.
 *
 * Reads the live catalogue for every table with a foreign key to
 * `organizations` or `users`. A table missing from the plan means a migration
 * added tenant-owned data since this was written, and the honest response is to
 * stop — not to delete what it happens to know about and leave the rest.
 */
export async function assertPlanCoversCatalogue(db: Kysely<Database>): Promise<void> {
  const known = new Set(RESET_PLAN.map((p) => p.table));

  const organizationTables = await organizationReferencingTables(db);
  const userTables = await sql<{ table_name: string }>`
    SELECT DISTINCT tc.table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND ccu.table_name = 'users'
       AND tc.table_schema = 'public'
     ORDER BY tc.table_name
  `.execute(db);

  const referencing = new Set([...organizationTables, ...userTables.rows.map((r) => r.table_name)]);
  const unknown = [...referencing].filter((t) => !known.has(t)).sort();

  if (unknown.length > 0) {
    throw new DevResetRefused(
      'plan_incomplete',
      `Refusing to run: ${unknown.join(', ')} reference organizations or users but have no disposition in RESET_PLAN. ` +
        'A migration has added tenant-owned data since this tool was written. Record a decision for each table first.',
    );
  }
}

/* ══ Preview ═══════════════════════════════════════════════════════════════ */

export interface PreservedAdmin {
  userId: string;
  email: string;
  fullName: string;
  roles: string[];
}

export interface TableCount {
  table: string;
  label: string;
  action: PlanAction;
  /** Rows this reset would remove. */
  willDelete: number;
  /** Rows that would remain afterwards. */
  willRemain: number;
}

export interface ResetPreview {
  target: DatabaseTarget;
  preservedAdmins: PreservedAdmin[];
  preservedPlans: number;
  preservedReferenceRows: Array<{ table: string; rows: number }>;
  doomedOrganizationIds: string[];
  doomedUserIds: string[];
  counts: TableCount[];
  /** Storage keys of proof files owned by doomed tenants. */
  storageKeys: string[];
  /** Memberships held by PRESERVED admins that still go, with the tenant. */
  preservedAdminMembershipsRemoved: number;
}

async function countRows(db: Kysely<Database>, table: string, where = ''): Promise<number> {
  const query = where
    ? sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)} WHERE ${sql.raw(where)}`
    : sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`;
  const { rows } = await query.execute(db);
  return rows[0]?.n ?? 0;
}

/**
 * The SQL predicate selecting doomed rows in one table.
 *
 * Written once and used by BOTH the preview and the execution, so the numbers
 * the operator approves are produced by the same rule that does the deleting.
 * A preview computed by a separate query is a preview that can disagree.
 */
function doomedPredicate(table: string): string {
  switch (table) {
    case 'payment_proofs':
      // Reached through the invoice; also caught by its uploader being doomed.
      return `invoice_id IN (SELECT id FROM subscription_invoices WHERE organization_id IN (SELECT id FROM organizations))
              OR uploaded_by_user_id IN (SELECT id FROM doomed_users)`;
    case 'subscription_applications':
      return `organization_id IN (SELECT id FROM organizations) OR user_id IN (SELECT id FROM doomed_users)`;
    case 'audit_logs':
      /*
       * Three ways a row is about this reset's subject matter: it is scoped to a
       * doomed tenant, it was written by a doomed identity, or it names one as
       * its target. Anything else — a preserved admin's login, a platform role
       * assignment — is left alone.
       */
      return `organization_id IN (SELECT id FROM organizations)
              OR actor_user_id IN (SELECT id FROM doomed_users)
              OR target_id::text IN (SELECT id::text FROM doomed_users)
              OR target_id::text IN (SELECT id::text FROM organizations)`;
    case 'organizations':
      return 'TRUE';
    case 'password_reset_tokens':
    case 'auth_sessions':
      return `user_id IN (SELECT id FROM doomed_users)`;
    case 'users':
      return `id IN (SELECT id FROM doomed_users)`;
    default:
      // Every remaining scoped table is keyed directly by organization_id.
      return `organization_id IN (SELECT id FROM organizations)`;
  }
}

/**
 * `doomed_users` as an inlineable subquery.
 *
 * Defined as a fragment rather than a temporary table so the preview (read-only,
 * no transaction) and the execution (inside the transaction) share one
 * definition of who is preserved.
 */
const DOOMED_USERS_CTE = `doomed_users AS (
  SELECT u.id FROM users u
   WHERE NOT EXISTS (SELECT 1 FROM platform_user_roles p WHERE p.user_id = u.id)
)`;

function scopedCount(table: string): string {
  return `WITH ${DOOMED_USERS_CTE} SELECT count(*)::int AS n FROM ${table} WHERE ${doomedPredicate(table)}`;
}

export async function previewReset(db: Kysely<Database>, target: DatabaseTarget): Promise<ResetPreview> {
  await assertPlanCoversCatalogue(db);

  const admins = await db
    .selectFrom('users')
    .innerJoin('platform_user_roles', 'platform_user_roles.user_id', 'users.id')
    .select(['users.id as id', 'users.email as email', 'users.full_name as full_name', 'platform_user_roles.role as role'])
    .orderBy('users.email')
    .execute();

  const byUser = new Map<string, PreservedAdmin>();
  for (const row of admins) {
    const existing = byUser.get(row.id);
    if (existing) existing.roles.push(row.role);
    else byUser.set(row.id, { userId: row.id, email: row.email, fullName: row.full_name, roles: [row.role] });
  }

  const doomedUsers = await sql<{ id: string }>`
    SELECT u.id FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM platform_user_roles p WHERE p.user_id = u.id)
     ORDER BY u.email
  `.execute(db);

  const organizations = await db.selectFrom('organizations').select('id').execute();

  const counts: TableCount[] = [];
  for (const entry of RESET_PLAN) {
    const total = await countRows(db, entry.table);
    if (entry.action === 'preserve') {
      counts.push({ table: entry.table, label: entry.label, action: entry.action, willDelete: 0, willRemain: total });
      continue;
    }
    if (entry.action === 'truncate') {
      counts.push({ table: entry.table, label: entry.label, action: entry.action, willDelete: total, willRemain: 0 });
      continue;
    }
    const { rows } = await sql<{ n: number }>`${sql.raw(scopedCount(entry.table))}`.execute(db);
    const willDelete = rows[0]?.n ?? 0;
    counts.push({
      table: entry.table,
      label: entry.label,
      action: entry.action,
      willDelete,
      willRemain: total - willDelete,
    });
  }

  /* Proof files to remove from disk, read BEFORE the rows naming them go. */
  const proofs = await db.selectFrom('payment_proofs').select('storage_key').execute();

  const adminMemberships = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM organization_memberships m
     WHERE EXISTS (SELECT 1 FROM platform_user_roles p WHERE p.user_id = m.user_id)
  `.execute(db);

  const referenceRows: Array<{ table: string; rows: number }> = [];
  for (const table of ['subscription_plans', 'billing_settings', 'bank_details', 'kysely_migration']) {
    referenceRows.push({ table, rows: await countRows(db, table) });
  }

  return {
    target,
    preservedAdmins: [...byUser.values()],
    preservedPlans: await countRows(db, 'subscription_plans'),
    preservedReferenceRows: referenceRows,
    doomedOrganizationIds: organizations.map((o) => o.id),
    doomedUserIds: doomedUsers.rows.map((r) => r.id),
    counts,
    storageKeys: proofs.map((p) => p.storage_key),
    preservedAdminMembershipsRemoved: adminMemberships.rows[0]?.n ?? 0,
  };
}

/* ══ Execution ═════════════════════════════════════════════════════════════ */

export interface ResetResult {
  target: DatabaseTarget;
  deleted: Record<string, number>;
  preservedAdmins: PreservedAdmin[];
  /** Storage keys whose files the caller should now remove. */
  storageKeys: string[];
  remaining: Record<string, number>;
}

export interface ExecuteResetInput {
  confirmation: string;
  guard: GuardInput;
}

/**
 * Delete everything the preview described, in ONE transaction.
 *
 * All-or-nothing is not a nicety here. A partial reset leaves a database with,
 * say, organizations deleted and their users still present — a state no code
 * path expects and which is harder to reason about than either extreme. If any
 * statement fails, the developer keeps the database they had.
 */
export async function executeReset(
  db: Kysely<Database>,
  input: ExecuteResetInput,
): Promise<ResetResult> {
  const target = assertLocalDevelopmentTarget(input.guard);

  if (input.confirmation !== RESET_CONFIRMATION) {
    /*
     * Deliberately does not echo what was typed: the point of an exact phrase is
     * that it is typed deliberately, and quoting a near-miss back invites
     * copy-pasting the correction without re-reading it.
     */
    throw new DevResetRefused(
      'confirmation_mismatch',
      `Refusing to run: the confirmation phrase does not match. Pass --confirm "${RESET_CONFIRMATION}" exactly.`,
    );
  }

  await assertPlanCoversCatalogue(db);

  const preview = await previewReset(db, target);

  const deleted = await db.transaction().execute(async (trx: Transaction<Database>) => {
    const counts: Record<string, number> = {};

    for (const entry of RESET_SEQUENCE) {
      if (entry.action === 'truncate') {
        const { rows } = await sql<{ n: number }>`
          WITH removed AS (DELETE FROM ${sql.table(entry.table)} RETURNING 1)
          SELECT count(*)::int AS n FROM removed
        `.execute(trx);
        counts[entry.table] = rows[0]?.n ?? 0;
        continue;
      }

      /*
       * `doomed_users` is recomputed for every statement rather than captured
       * once. Inside the transaction the set is stable — nothing here grants or
       * revokes a platform role — and recomputing keeps the rule in one place
       * instead of splitting it between a snapshot and a predicate.
       */
      const { rows } = await sql<{ n: number }>`${sql.raw(
        `WITH ${DOOMED_USERS_CTE}, removed AS (
           DELETE FROM ${entry.table} WHERE ${doomedPredicate(entry.table)} RETURNING 1
         )
         SELECT count(*)::int AS n FROM removed`,
      )}`.execute(trx);
      counts[entry.table] = rows[0]?.n ?? 0;
    }

    return counts;
  });

  /* Read back from the committed state, not from what we believe we did. */
  const remaining: Record<string, number> = {};
  for (const entry of RESET_PLAN) {
    remaining[entry.table] = await countRows(db, entry.table);
  }

  return {
    target,
    deleted,
    preservedAdmins: preview.preservedAdmins,
    storageKeys: preview.storageKeys,
    remaining,
  };
}
