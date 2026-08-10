/**
 * Subscriber data export.
 *
 * ── The one rule this module is built around ─────────────────────────────────
 * Every projection below is an EXPLICIT allow-list, built field by field. Not
 * one query is `selectAll()`. A deny-list would leak whatever column is added
 * next, and the columns that must never leave — `users.password_hash`,
 * `auth_sessions.token_hash`, `password_reset_tokens.token_hash`,
 * `subscriber_data_exports.token_hash` — sit in tables this export legitimately
 * reads from. They are not fetched and then stripped; they are never selected,
 * so no future refactor can serialise them by accident.
 *
 * ── Tenant scoping ───────────────────────────────────────────────────────────
 * Every query is filtered by the organization id resolved from the database, and
 * the few that reach `users` do so only through that organization's own
 * memberships. One subscriber's export therefore cannot contain another's — not
 * because a filter was remembered each time, but because there is no query here
 * that is not organization-scoped.
 *
 * ── What the download token is ───────────────────────────────────────────────
 * 256 bits of `randomBytes`, returned exactly once, stored only as its SHA-256
 * digest — the same rule `auth_sessions` and `password_reset_tokens` follow. It
 * expires, it can be revoked, and every download is recorded.
 *
 * ── What this export can and cannot contain ──────────────────────────────────
 * Ledgora's accounting records still live in the customer's browser workspace,
 * not in this service. So the ledger, business documents, projects, fixed assets
 * and inventory CANNOT be exported from here, and the payload says so explicitly
 * in `unavailableSections` rather than quietly omitting them — an export that
 * looked complete but was not would be worse than no export at all.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { generateSessionToken, hashToken } from '../lib/tokens.js';

export interface ExportAdminContext extends AuditContext {
  actorUserId: string;
  actorPlatformRole: string;
}

/** Minutes a download link stays valid. Short: it is a copy of a tenant's data. */
export const EXPORT_TTL_MINUTES = 60 * 24;

export interface CreatedExport {
  exportId: string;
  organizationId: string;
  status: string;
  expiresAt: string;
  sectionCounts: Record<string, number>;
  byteSize: number;
  /** Returned exactly once. Only its hash is stored. */
  downloadToken: string;
  unavailableSections: string[];
}

const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

/**
 * Build the export payload.
 *
 * Read-only, and organization-scoped throughout. Runs before the row is marked
 * `ready`, so a failure leaves a `failed` export rather than an empty download.
 */
async function buildPayload(
  db: Kysely<Database>,
  organizationId: string,
): Promise<{ payload: Record<string, unknown>; counts: Record<string, number>; unavailableSections: string[] }> {
  const organization = await db
    .selectFrom('organizations')
    .select([
      'id',
      'legal_name',
      'trading_name',
      'country',
      'registration_number',
      'tax_number',
      'industry',
      'base_currency',
      'fiscal_year_start',
      'books_start_date',
      'status',
      'created_at',
      'archived_at',
      'archive_reason',
    ])
    .where('id', '=', organizationId)
    .executeTakeFirst();
  if (!organization) throw errors.notFound('Subscriber');

  /* ── Members. Personal fields only; never a credential. ─────────────────── */
  const members = await db
    .selectFrom('organization_memberships')
    .innerJoin('users', 'users.id', 'organization_memberships.user_id')
    .select([
      'users.id as user_id',
      'users.email',
      'users.full_name',
      'users.status as account_status',
      'users.last_login_at',
      'users.email_verified_at',
      'organization_memberships.role',
      'organization_memberships.status as membership_status',
      'organization_memberships.created_at as joined_at',
    ])
    .where('organization_memberships.organization_id', '=', organizationId)
    .execute();

  /* ── Per-user permission overrides, scoped to THIS organization. ────────── */
  const permissions = await db
    .selectFrom('user_permission_overrides')
    .select(['user_id', 'subject', 'action', 'effect', 'reason', 'created_at'])
    .where('organization_id', '=', organizationId)
    .execute();

  /* ── Subscription and billing history. ─────────────────────────────────── */
  const subscriptions = await db
    .selectFrom('subscriptions')
    .leftJoin('subscription_plans', 'subscription_plans.id', 'subscriptions.plan_id')
    .select([
      'subscriptions.id',
      'subscriptions.status',
      'subscriptions.billing_cycle',
      'subscriptions.starts_at',
      'subscriptions.expires_at',
      'subscriptions.user_limit',
      'subscriptions.entity_limit',
      'subscriptions.created_at',
      'subscription_plans.code as plan_code',
      'subscription_plans.name as plan_name',
      'subscription_plans.edition',
    ])
    .where('subscriptions.organization_id', '=', organizationId)
    .execute();

  const invoices = await db
    .selectFrom('subscription_invoices')
    .select([
      'id',
      'invoice_number',
      'currency',
      'subtotal',
      'tax',
      'total',
      'status',
      'issued_at',
      'due_at',
      'paid_at',
    ])
    .where('organization_id', '=', organizationId)
    .execute();

  /*
   * Payment proofs: metadata only. `storage_key` is deliberately excluded — it
   * addresses a file in the storage adapter, and an export is not a capability
   * to fetch attachments.
   */
  const proofs = await db
    .selectFrom('payment_proofs')
    .innerJoin('subscription_invoices', 'subscription_invoices.id', 'payment_proofs.invoice_id')
    .select([
      'payment_proofs.id',
      'payment_proofs.file_name',
      'payment_proofs.mime_type',
      'payment_proofs.file_size',
      'payment_proofs.amount',
      'payment_proofs.paid_at',
      'payment_proofs.status',
      'payment_proofs.bank_transaction_reference',
      'payment_proofs.created_at',
      'subscription_invoices.invoice_number',
    ])
    .where('subscription_invoices.organization_id', '=', organizationId)
    .execute();

  const packageChanges = await db
    .selectFrom('subscription_package_changes')
    .select([
      'id',
      'previous_plan_code',
      'new_plan_code',
      'previous_status',
      'new_status',
      'direction',
      'effective_at',
      'reason',
      'created_at',
    ])
    .where('organization_id', '=', organizationId)
    .execute();

  const entitlement = await db
    .selectFrom('organization_entitlements')
    .select(['plan_code', 'edition', 'modules', 'user_limit', 'entity_limit', 'status', 'active', 'computed_at'])
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();

  /*
   * Audit log. `ip_address` and `user_agent` are excluded: they are forensic
   * fields about individuals, and an export handed to a customer is not the
   * right place for them.
   */
  const auditLogs = await db
    .selectFrom('audit_logs')
    .select(['id', 'action', 'actor_user_id', 'target_type', 'target_id', 'metadata', 'created_at'])
    .where('organization_id', '=', organizationId)
    .orderBy('created_at', 'asc')
    .execute();

  /** Sections this service genuinely cannot produce. Stated, never omitted. */
  const unavailableSections: string[] = [
    'chart_of_accounts',
    'journals_and_ledger',
    'financial_reports',
    'customers_and_suppliers',
    'invoices_bills_payments_receipts',
    'projects_cost_centres',
    'fixed_assets_inventory_manufacturing',
    'documents_and_attachments',
  ];

  const payload = {
    exportFormatVersion: 1,
    generatedAt: new Date().toISOString(),
    organization: {
      ...organization,
      created_at: iso(organization.created_at),
      archived_at: iso(organization.archived_at),
    },
    members: members.map((m) => ({
      ...m,
      last_login_at: iso(m.last_login_at),
      email_verified_at: iso(m.email_verified_at),
      joined_at: iso(m.joined_at),
    })),
    permissions,
    subscriptions,
    invoices,
    paymentProofs: proofs,
    packageHistory: packageChanges,
    entitlement: entitlement ?? null,
    auditLogs: auditLogs.map((entry) => ({
      ...entry,
      metadata: typeof entry.metadata === 'string' ? JSON.parse(entry.metadata) : entry.metadata,
      created_at: iso(entry.created_at),
    })),
    /**
     * The honest part of the contract. These sections are held in the customer's
     * browser workspace, not in this service, so they are NOT in this file and
     * their absence must not be read as "there were none".
     */
    unavailableSections,
    unavailableSectionsNote:
      'Ledgora accounting records are held in the customer workspace in the browser, not in the account service. They are not included in this export and their absence is not evidence that none exist. Export them from the application before closing the workspace.',
  };

  const counts: Record<string, number> = {
    members: members.length,
    permissions: permissions.length,
    subscriptions: subscriptions.length,
    invoices: invoices.length,
    paymentProofs: proofs.length,
    packageHistory: packageChanges.length,
    auditLogs: auditLogs.length,
  };

  return { payload, counts, unavailableSections };
}

/**
 * Create an export for one subscriber.
 *
 * The row is written first as `pending`, so a failure part-way through is a
 * recorded `failed` export rather than a silent nothing.
 */
export async function createSubscriberExport(
  db: Kysely<Database>,
  input: { organizationId: string; ttlMinutes?: number },
  context: ExportAdminContext,
): Promise<CreatedExport> {
  const organization = await db
    .selectFrom('organizations')
    .select(['id', 'legal_name'])
    .where('id', '=', input.organizationId)
    .executeTakeFirst();
  if (!organization) throw errors.notFound('Subscriber');

  const token = generateSessionToken();
  const ttl = Math.max(input.ttlMinutes ?? EXPORT_TTL_MINUTES, 5);
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  const row = await db
    .insertInto('subscriber_data_exports')
    .values({
      organization_id: input.organizationId,
      requested_by: context.actorUserId,
      status: 'pending',
      token_hash: hashToken(token),
      expires_at: expiresAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  try {
    const { payload, counts, unavailableSections } = await buildPayload(db, input.organizationId);
    const serialised = JSON.stringify(payload);

    await db
      .updateTable('subscriber_data_exports')
      .set({
        status: 'ready',
        payload: serialised,
        byte_size: Buffer.byteLength(serialised, 'utf8'),
        section_counts: JSON.stringify(counts),
        updated_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();

    await writeAuditLog(db, {
      ...context,
      organizationId: input.organizationId,
      action: 'subscriber.export_created',
      targetType: 'organization',
      targetId: input.organizationId,
      // No token, no hash. The fact, the scope and the expiry.
      metadata: {
        exportId: row.id,
        legalName: organization.legal_name,
        sectionCounts: counts,
        byteSize: Buffer.byteLength(serialised, 'utf8'),
        expiresAt: expiresAt.toISOString(),
        ttlMinutes: ttl,
      },
    });

    return {
      exportId: row.id,
      organizationId: input.organizationId,
      status: 'ready',
      expiresAt: expiresAt.toISOString(),
      sectionCounts: counts,
      byteSize: Buffer.byteLength(serialised, 'utf8'),
      downloadToken: token,
      unavailableSections,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await db
      .updateTable('subscriber_data_exports')
      .set({ status: 'failed', error_message: message, updated_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    await writeAuditLog(db, {
      ...context,
      organizationId: input.organizationId,
      action: 'subscriber.export_failed',
      targetType: 'organization',
      targetId: input.organizationId,
      metadata: { exportId: row.id, error: message },
    });
    throw cause;
  }
}

export interface ExportSummary {
  exportId: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  byteSize: number | null;
  sectionCounts: Record<string, number>;
  downloadCount: number;
  firstDownloadedAt: string | null;
  requestedBy: string | null;
}

/** Exports for one subscriber. Never returns a token or a payload. */
export async function listSubscriberExports(
  db: Kysely<Database>,
  organizationId: string,
): Promise<ExportSummary[]> {
  const rows = await db
    .selectFrom('subscriber_data_exports')
    // `token_hash` and `payload` are absent by construction, not by removal.
    .select([
      'id',
      'status',
      'created_at',
      'expires_at',
      'byte_size',
      'section_counts',
      'download_count',
      'first_downloaded_at',
      'requested_by',
    ])
    .where('organization_id', '=', organizationId)
    .orderBy('created_at', 'desc')
    .execute();

  const now = Date.now();
  return rows.map((row) => ({
    exportId: row.id,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    expired: new Date(row.expires_at).getTime() <= now,
    byteSize: row.byte_size,
    sectionCounts:
      typeof row.section_counts === 'string' ? JSON.parse(row.section_counts) : (row.section_counts ?? {}),
    downloadCount: row.download_count,
    firstDownloadedAt: iso(row.first_downloaded_at),
    requestedBy: row.requested_by,
  }));
}

/**
 * Redeem a download token.
 *
 * Looked up by HASH, so the stored value is not replayable. Expired, revoked and
 * unknown tokens all produce the same refusal — distinguishing them would tell
 * the holder of a guessed token that they guessed correctly.
 */
export async function downloadSubscriberExport(
  db: Kysely<Database>,
  input: { exportId: string; token: string },
  context: ExportAdminContext,
): Promise<{ payload: unknown; organizationId: string; byteSize: number | null }> {
  const refusal = () =>
    errors.validation('This download link is no longer valid. Generate a new export.');

  const row = await db
    .selectFrom('subscriber_data_exports')
    .select([
      'id',
      'organization_id',
      'status',
      'token_hash',
      'expires_at',
      'revoked_at',
      'payload',
      'byte_size',
      'download_count',
      'first_downloaded_at',
    ])
    .where('id', '=', input.exportId)
    .executeTakeFirst();

  if (!row) throw refusal();
  if (row.revoked_at || row.status === 'revoked' || row.status === 'failed') throw refusal();
  if (new Date(row.expires_at).getTime() <= Date.now()) throw refusal();
  // Constant-time comparison is unnecessary for a 256-bit random value compared
  // by its digest, but the hash lookup is what makes the stored form useless.
  if (row.token_hash !== hashToken(input.token ?? '')) throw refusal();
  if (!row.payload) throw refusal();

  const now = new Date();
  await db
    .updateTable('subscriber_data_exports')
    .set({
      status: 'downloaded',
      download_count: row.download_count + 1,
      first_downloaded_at: row.first_downloaded_at ?? now,
      updated_at: now,
    })
    .where('id', '=', row.id)
    .execute();

  await writeAuditLog(db, {
    ...context,
    organizationId: row.organization_id,
    action: 'subscriber.export_downloaded',
    targetType: 'organization',
    targetId: row.organization_id,
    metadata: { exportId: row.id, downloadCount: row.download_count + 1, byteSize: row.byte_size },
  });

  return {
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    organizationId: row.organization_id,
    byteSize: row.byte_size,
  };
}

/** Withdraw an export before it expires, and destroy its payload. */
export async function revokeSubscriberExport(
  db: Kysely<Database>,
  input: { exportId: string; reason: string },
  context: ExportAdminContext,
): Promise<{ exportId: string; revoked: boolean }> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why this export is being withdrawn.' },
    });
  }

  const row = await db
    .selectFrom('subscriber_data_exports')
    .select(['id', 'organization_id', 'revoked_at'])
    .where('id', '=', input.exportId)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Export');
  if (row.revoked_at) return { exportId: row.id, revoked: true };

  await db
    .updateTable('subscriber_data_exports')
    .set({
      status: 'revoked',
      revoked_at: new Date(),
      // The copy goes with the link. A revoked export that still holds the data
      // is a revocation in name only.
      payload: null,
      updated_at: new Date(),
    })
    .where('id', '=', row.id)
    .execute();

  await writeAuditLog(db, {
    ...context,
    organizationId: row.organization_id,
    action: 'subscriber.export_revoked',
    targetType: 'organization',
    targetId: row.organization_id,
    metadata: { exportId: row.id, reason },
  });

  return { exportId: row.id, revoked: true };
}
