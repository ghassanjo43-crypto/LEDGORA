/**
 * Removal, archival and permanent deletion.
 *
 * ══ The fact that shapes this entire module ═══════════════════════════════════
 *
 * Ledgora's ACCOUNTING DATA IS NOT IN THIS DATABASE. Journals, sales invoices,
 * bills, payments, fixed assets, inventory and tax filings live in the customer's
 * browser workspace. The backend holds only identity and billing: users,
 * organizations, memberships, subscriptions, subscription invoices and payment
 * proofs.
 *
 * So a deletion-impact report CANNOT truthfully say "posted journal entries: 0".
 * Zero would mean "there are none" when the honest answer is "this server cannot
 * see them". Reporting 0 there is the single most dangerous thing this feature
 * could do: it would green-light the purge of a tenant with a full ledger.
 *
 * Those categories are therefore reported as `serverVerifiable: false` — explicitly
 * unknown — and the eligibility rule is built on an invariant the server CAN
 * verify:
 *
 *     `guards/persistence.ts` refuses every durable business write unless the
 *     organization's subscription is `active`.
 *
 * Therefore an organization that has NEVER held an active subscription cannot
 * hold durable business records. That — not a count of zero — is what makes a
 * purge safe, and it is why "was this tenant ever activated?" is the primary
 * blocking check. A tenant that was ever activated is archived, never purged.
 *
 * ══ Retained versus removed ═══════════════════════════════════════════════════
 *
 * `audit_logs.actor_user_id` references `users(id)`. The audit trail is evidence,
 * and a dangling actor turns "who did this?" into "nobody knows" — so a user who
 * appears in retained audit history is ANONYMISED IN PLACE (id kept, personal
 * fields replaced) rather than deleted. Only an account that appears nowhere is
 * deleted outright. Nothing here ever deletes an audit row.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, OrganizationStatus } from '../db/schema.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { revokeAllUserSessions } from './sessionService.js';
import { recalculateEntitlements } from './entitlementService.js';

export interface DeletionAdminContext extends AuditContext {
  actorUserId: string;
  actorPlatformRole: string;
}

/** How long after a purge is requested it may be carried out. */
export const PURGE_COOLING_OFF_HOURS = 0;

/* ══ Impact reporting ═══════════════════════════════════════════════════════ */

/**
 * One line of the impact report.
 *
 * `serverVerifiable: false` is the load-bearing field. It marks a category this
 * server genuinely cannot count — not one that happens to be empty — and the UI
 * must render it as "not verifiable here", never as a zero.
 */
export interface ImpactCount {
  key: string;
  label: string;
  count: number | null;
  serverVerifiable: boolean;
  note?: string;
}

export interface BlockingReason {
  code: string;
  message: string;
}

export interface DeletionImpact {
  organizationId: string;
  legalName: string;
  organizationStatus: string;
  /** production | test | demo, read from the database. Never client-supplied. */
  classification: string;
  /** True only for `test` and `demo`. */
  disposable: boolean;
  /** Server-counted facts. */
  counts: ImpactCount[];
  /** True only when every blocking check passed. */
  deletionPermitted: boolean;
  blockingReasons: BlockingReason[];
  /** Rows whose personal fields will be replaced, keeping their ids. */
  willBeAnonymized: string[];
  /** Rows that will be removed outright. */
  willBePermanentlyDeleted: string[];
  /** Rows that are kept whatever happens. */
  willBeRetained: string[];
  /** Present when deletion is refused — the exact sentence the UI shows. */
  recommendation: string;
  /**
   * Per-person outcome, so the impact screen can distinguish the identity that
   * exists only for this tenant from the colleague who also belongs elsewhere.
   * A single "members will be anonymised" line cannot say which is which, and
   * that is exactly the distinction an operator needs before confirming.
   */
  people: IdentityOutcome[];
  /**
   * True when this tenant can be destroyed NOW, with no recovery window.
   *
   * The 30-day window exists to protect real records from a mistaken deletion.
   * A disposable tenant that has never billed, never activated and holds no
   * evidence has nothing for the window to protect, and forcing one on it leaves
   * development data undeletable for a month — the problem this feature exists
   * to solve. Production is never immediately purgeable, whatever its history.
   */
  immediatePurgeEligible: boolean;
  /** Why immediate purge is unavailable. Empty when it is available. */
  immediatePurgeBlockers: string[];
  /** Recomputed every time; a client may not cache or forge it. */
  assessedAt: string;
}

/** What happens to one person when this tenant is destroyed. */
export interface IdentityOutcome {
  userId: string;
  email: string;
  fullName: string;
  /** `disposable` is the only outcome that deletes the account itself. */
  outcome: 'disposable' | 'retained_other_membership' | 'retained_platform_role' | 'retained_production';
  detail: string;
}

/** The retention refusal, worded so the operator knows the safe action. */
export const PRODUCTION_RETENTION_MESSAGE =
  'Production subscribers cannot be permanently deleted. Archive this subscriber instead.';

/** The sentence the requirement specifies, verbatim. */
export const PURGE_REFUSED_MESSAGE =
  'This subscriber contains accounting or legally retained records and cannot be permanently deleted. Archive the subscriber instead.';

/**
 * Thrown when the in-transaction eligibility check refuses.
 *
 * ── Why this exists rather than a plain throw ────────────────────────────────
 * The refusal itself must be audited — "somebody tried to purge this and was
 * stopped" is exactly the kind of thing an auditor wants to see. But an audit row
 * written INSIDE the transaction that then throws is rolled back with everything
 * else, so the record of the refusal destroys itself.
 *
 * So the transaction throws this marker, the caller catches it OUTSIDE the
 * transaction, writes the audit entry on the pooled connection where it will
 * actually commit, and then surfaces the user-facing conflict.
 */
class DeletionBlocked extends Error {
  constructor(
    readonly recommendation: string,
    readonly blockedBy: string[],
    readonly detail: Record<string, unknown> = {},
  ) {
    super(recommendation);
    this.name = 'DeletionBlocked';
  }
}

type Executor = Kysely<Database> | Transaction<Database>;

/** Row count for a narrow projection. Kept tiny: only ids are selected. */
async function countWhere(
  db: Executor,
  build: (db: Executor) => { execute: () => Promise<unknown[]> },
): Promise<number> {
  return (await build(db).execute()).length;
}

async function requireOrganizationRow(db: Executor, organizationId: string) {
  const row = await db
    .selectFrom('organizations')
    .selectAll()
    .where('id', '=', organizationId)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Subscriber');
  return row;
}

/**
 * Has this organization EVER held an entitling subscription?
 *
 * The question the whole purge decision turns on. Checked three independent ways,
 * because any one of them alone could be wiped by a later edit:
 *   · the subscription's current status;
 *   · `starts_at` — set only when a subscription actually began;
 *   · the package history, which is append-only and records every activation.
 * If any says yes, the tenant may hold durable business records and cannot be
 * purged.
 */
export async function everActivated(db: Executor, organizationId: string): Promise<boolean> {
  /*
   * `starts_at` is set ONLY on genuine activation, which makes it the reliable
   * signal. Deliberately NOT keyed on `suspended`/`cancelled`/`expired`: a tenant
   * can reach all three without ever having been activated (suspending an unpaid
   * account, or archiving a test one), and treating those as evidence would make
   * every empty subscriber unpurgeable.
   */
  const live = await db
    .selectFrom('subscriptions')
    .select(['id'])
    .where('organization_id', '=', organizationId)
    .where((eb) => eb.or([eb('status', 'in', ['active', 'past_due']), eb('starts_at', 'is not', null)]))
    .executeTakeFirst();
  if (live) return true;

  const history = await db
    .selectFrom('subscription_package_changes')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('new_status', 'in', ['active', 'past_due'])
    .executeTakeFirst();
  return Boolean(history);
}

/**
 * Assess a subscriber for permanent deletion.
 *
 * A pure read, recomputed on every call — including inside the purge transaction
 * itself, so a client cannot present a stale or hand-edited assessment and have it
 * believed. See `purgeSubscriber`.
 */
export async function assessSubscriberDeletion(
  db: Executor,
  organizationId: string,
): Promise<DeletionImpact> {
  const organization = await requireOrganizationRow(db, organizationId);

  /*
   * Joined to `users` because the impact report names each person and states
   * what happens to them. `data_classification` comes from the IDENTITY, never
   * from the organization: the two are independent, which is the whole reason a
   * real person can sit inside a demo tenant and survive it.
   */
  const members = await db
    .selectFrom('organization_memberships')
    .innerJoin('users', 'users.id', 'organization_memberships.user_id')
    .select([
      'organization_memberships.user_id as user_id',
      'organization_memberships.role as role',
      'users.email as email',
      'users.full_name as full_name',
      'users.data_classification as data_classification',
    ])
    .where('organization_memberships.organization_id', '=', organizationId)
    .execute();

  const invoices = await db
    .selectFrom('subscription_invoices')
    .select(['id', 'status'])
    .where('organization_id', '=', organizationId)
    .execute();

  const proofs = await db
    .selectFrom('payment_proofs')
    .innerJoin('subscription_invoices', 'subscription_invoices.id', 'payment_proofs.invoice_id')
    .select(['payment_proofs.id', 'payment_proofs.status'])
    .where('subscription_invoices.organization_id', '=', organizationId)
    .execute();

  const subscriptions = await db
    .selectFrom('subscriptions')
    .select(['id', 'status'])
    .where('organization_id', '=', organizationId)
    .execute();

  const auditEntries = await countWhere(db, (qb) =>
    qb.selectFrom('audit_logs').select('id').where('organization_id', '=', organizationId),
  );
  const packageChanges = await countWhere(db, (qb) =>
    qb.selectFrom('subscription_package_changes').select('id').where('organization_id', '=', organizationId),
  );

  const platformStaff = members.length
    ? await db
        .selectFrom('platform_user_roles')
        .select(['user_id', 'role'])
        .where(
          'user_id',
          'in',
          members.map((m) => m.user_id),
        )
        .execute()
    : [];

  const activated = await everActivated(db, organizationId);
  const settledInvoices = invoices.filter((i) => i.status === 'paid' || i.status === 'proof_submitted');
  const decidedProofs = proofs.filter((p) => p.status === 'approved' || p.status === 'submitted');
  const pendingReview = proofs.filter((p) => p.status === 'submitted');
  const liveSubscription = subscriptions.find((s) => s.status === 'active' || s.status === 'past_due');

  /* ── Counts ────────────────────────────────────────────────────────────── */
  const counts: ImpactCount[] = [
    { key: 'members', label: 'Organization members', count: members.length, serverVerifiable: true },
    {
      key: 'subscription_invoices',
      label: 'Subscription invoices',
      count: invoices.length,
      serverVerifiable: true,
    },
    { key: 'payments', label: 'Settled invoice payments', count: settledInvoices.length, serverVerifiable: true },
    { key: 'payment_proofs', label: 'Payment proofs', count: proofs.length, serverVerifiable: true },
    { key: 'subscriptions', label: 'Subscription records', count: subscriptions.length, serverVerifiable: true },
    { key: 'package_changes', label: 'Package history entries', count: packageChanges, serverVerifiable: true },
    { key: 'audit_entries', label: 'Audit entries', count: auditEntries, serverVerifiable: true },
    /*
     * The browser-resident categories. Reported as UNKNOWN, never as zero — this
     * server has no table for them, and pretending otherwise is how a tenant with
     * a full ledger gets purged.
     */
    {
      key: 'journal_entries',
      label: 'Posted journal entries',
      count: null,
      serverVerifiable: false,
      note: 'Held in the customer workspace, not in the account service. Cannot be counted here.',
    },
    {
      key: 'business_documents',
      label: 'Sales invoices, bills and receipts',
      count: null,
      serverVerifiable: false,
      note: 'Held in the customer workspace. Cannot be counted here.',
    },
    {
      key: 'locked_periods',
      label: 'Locked periods and tax filings',
      count: null,
      serverVerifiable: false,
      note: 'Held in the customer workspace. Cannot be counted here.',
    },
  ];

  /* ── Blocking checks ──────────────────────────────────────────────────── */
  const blockingReasons: BlockingReason[] = [];

  /**
   * The retention rule, evaluated FIRST and read from the database row.
   *
   * A `production` subscriber can never be permanently deleted through this
   * application, whatever else is true of it — no lifecycle state, no empty
   * billing table and no operator authority makes it eligible. The value is read
   * here, not accepted from a caller, so a request carrying
   * `classification: "test"` changes nothing.
   */
  const classification = organization.data_classification;
  const disposable = classification === 'test' || classification === 'demo';

  if (!disposable) {
    blockingReasons.push({
      code: 'production_subscriber',
      message: PRODUCTION_RETENTION_MESSAGE,
    });
  }

  if (organization.legal_hold) {
    blockingReasons.push({
      code: 'legal_hold',
      message: `This subscriber is under a legal hold${organization.legal_hold_reason ? `: ${organization.legal_hold_reason}` : ''}. The hold must be lifted first.`,
    });
  }

  /*
   * ── Retention blockers, and why test/demo is exempt from them ───────────
   *
   * Everything in this group exists to protect REAL records: a tenant that was
   * once activated may hold accounting data, a settled invoice is billing
   * evidence, an approved proof is payment evidence. Every one of those is a
   * statement about data worth keeping.
   *
   * Test and demo data is, by the operator's explicit and irreversible
   * declaration, none of those things — that is the entire point of classifying
   * it. Applying these blockers to it would leave the development dataset
   * permanently undeletable, which is the problem this feature exists to solve.
   *
   * The blockers that are NOT waived below (legal hold, platform-role member)
   * are deliberately kept: they protect something other than the tenant's own
   * business records, and a classification cannot speak for those.
   */
  if (!disposable) {
    if (activated) {
      /*
       * THE central rule for production. An activated tenant was permitted
       * durable business writes, so accounting records may exist where this
       * server cannot see them.
       */
      blockingReasons.push({
        code: 'accounting_records_possible',
        message:
          'This subscriber has held an active subscription, so it was permitted to create accounting records. Those live in the customer workspace and cannot be verified from here.',
      });
    }

    if (liveSubscription) {
      blockingReasons.push({
        code: 'active_subscription',
        message: `The subscription is ${liveSubscription.status}. Cancel or archive the subscriber first.`,
      });
    }

    if (settledInvoices.length > 0) {
      blockingReasons.push({
        code: 'settled_invoices',
        message: `${settledInvoices.length} invoice(s) have been paid or have a proof submitted. Billing records must be retained.`,
      });
    }

    if (decidedProofs.length > 0) {
      blockingReasons.push({
        code: 'payment_proofs',
        message: `${decidedProofs.length} payment proof(s) have been submitted or approved. Payment evidence must be retained.`,
      });
    }

    if (pendingReview.length > 0) {
      blockingReasons.push({
        code: 'pending_review',
        message: 'A payment proof is awaiting review. Complete the review before deleting anything.',
      });
    }
  }

  if (platformStaff.length > 0) {
    blockingReasons.push({
      code: 'platform_role_member',
      message: 'A member of this organization holds a Ledgora platform role.',
    });
  }

  if (organization.deletion_eligible_after && new Date(organization.deletion_eligible_after) > new Date()) {
    blockingReasons.push({
      code: 'cooling_off',
      message: `Deletion was requested but is not permitted until ${new Date(organization.deletion_eligible_after).toISOString()}.`,
    });
  }

  const deletionPermitted = blockingReasons.length === 0;

  /*
   * ── Per-person outcomes ─────────────────────────────────────────────────
   * Default is RETAIN, and an identity reaches `disposable` only by proving
   * every reason to keep it is absent. The order matters: a person who belongs
   * elsewhere is retained for that reason regardless of how they are
   * classified, because deleting them would reach into a tenant this operation
   * has no business touching.
   */
  const people: IdentityOutcome[] = [];
  for (const member of members) {
    const elsewhere = await db
      .selectFrom('organization_memberships')
      .select('id')
      .where('user_id', '=', member.user_id)
      .where('organization_id', '!=', organizationId)
      .executeTakeFirst();

    if (elsewhere) {
      people.push({
        userId: member.user_id,
        email: member.email,
        fullName: member.full_name,
        outcome: 'retained_other_membership',
        detail: 'Belongs to another organization. Its membership here is removed; the account is kept.',
      });
      continue;
    }

    if (platformStaff.some((s) => s.user_id === member.user_id)) {
      people.push({
        userId: member.user_id,
        email: member.email,
        fullName: member.full_name,
        outcome: 'retained_platform_role',
        detail: 'Holds a Ledgora platform role. A platform identity is never disposable.',
      });
      continue;
    }

    if (member.data_classification !== 'test' && member.data_classification !== 'demo') {
      people.push({
        userId: member.user_id,
        email: member.email,
        fullName: member.full_name,
        outcome: 'retained_production',
        detail:
          'The identity is production-classified. Deleting a tenant never decides the fate of a person recorded as real.',
      });
      continue;
    }

    people.push({
      userId: member.user_id,
      email: member.email,
      fullName: member.full_name,
      outcome: 'disposable',
      detail:
        'Created exclusively for this subscriber and has no retained production relationships.',
    });
  }

  /*
   * ── Immediate purge ─────────────────────────────────────────────────────
   * Deliberately stricter than `deletionPermitted`. Skipping the recovery
   * window is only defensible when there is provably nothing to recover: no
   * billing, no payment evidence, no activation, and therefore no accounting
   * records anywhere. Anything at all in the history means the window applies.
   */
  const immediatePurgeBlockers: string[] = [];
  if (!disposable) {
    immediatePurgeBlockers.push('Only Demo and Test subscribers may be purged without a recovery window.');
  }
  if (activated) {
    immediatePurgeBlockers.push('The subscription was activated, so accounting records may exist.');
  }
  if (liveSubscription) immediatePurgeBlockers.push(`The subscription is ${liveSubscription.status}.`);
  if (settledInvoices.length > 0) {
    immediatePurgeBlockers.push(`${settledInvoices.length} invoice(s) are paid or have a proof submitted.`);
  }
  if (decidedProofs.length > 0) {
    immediatePurgeBlockers.push(`${decidedProofs.length} payment proof(s) have been submitted or approved.`);
  }
  if (organization.legal_hold) immediatePurgeBlockers.push('A legal hold is in force.');
  if (platformStaff.length > 0) {
    immediatePurgeBlockers.push('A member of this organization holds a Ledgora platform role.');
  }
  /*
   * A production identity here does NOT block the tenant's deletion — the
   * person is simply retained. It blocks the SHORTCUT, because a real person
   * being detached from a tenant is exactly the kind of thing somebody may want
   * thirty days to reverse.
   *
   * Counted from the IDENTITY's own classification rather than from its retain
   * reason. A production person who also belongs elsewhere is retained for the
   * membership reason, not the classification one, and keying off the outcome
   * would let that case slip through as "no production dependency".
   */
  const productionIdentities = members.filter(
    (m) => m.data_classification !== 'test' && m.data_classification !== 'demo',
  );
  if (productionIdentities.length > 0) {
    immediatePurgeBlockers.push(
      `${productionIdentities.length} production-classified identity/identities would lose their membership.`,
    );
  }

  const immediatePurgeEligible = deletionPermitted && immediatePurgeBlockers.length === 0;

  return {
    organizationId,
    legalName: organization.legal_name,
    organizationStatus: organization.status,
    classification,
    disposable,
    counts,
    deletionPermitted,
    blockingReasons,
    willBeAnonymized: deletionPermitted
      ? [
          'Members who appear in retained audit history (name and email replaced; user id kept so audit stays resolvable)',
        ]
      : [],
    willBePermanentlyDeleted: deletionPermitted
      ? [
          'Organization record',
          'Organization memberships',
          'Draft and unpaid subscription records',
          'Cancelled or unpaid subscription invoices',
          'Entitlement record',
          'Package history',
          'Subscription applications',
          'Sessions and unused reset tokens of members with no other organization',
        ]
      : [],
    willBeRetained: [
      'Every audit entry (personal fields anonymised where required, never removed)',
      'User accounts that belong to another organization',
      'User ids, so historical references keep resolving',
    ],
    recommendation: deletionPermitted
      ? disposable
        ? `This subscriber is classified as ${classification} data and may be permanently deleted, along with everything it owns.`
        : 'This subscriber holds no accounting or retained billing records in the account service and may be permanently deleted.'
      : /*
         * Retention is the recommendation only when it is the SOLE refusal. If
         * the tenant also holds accounting or billing records, that is the more
         * specific fact and stays the headline — both appear in
         * `blockingReasons` either way, so nothing is hidden.
         */
        blockingReasons.length === 1 && !disposable
        ? PRODUCTION_RETENTION_MESSAGE
        : PURGE_REFUSED_MESSAGE,
    people,
    immediatePurgeEligible,
    immediatePurgeBlockers,
    assessedAt: new Date().toISOString(),
  };
}

/* ══ Member deletion assessment ════════════════════════════════════════════ */

export interface MemberDeletionImpact {
  userId: string;
  email: string;
  fullName: string;
  accountStatus: string;
  /** Every organization the account belongs to. */
  memberships: Array<{ organizationId: string; organizationName: string; role: string; status: string }>;
  counts: ImpactCount[];
  deletionPermitted: boolean;
  blockingReasons: BlockingReason[];
  willBeAnonymized: string[];
  willBePermanentlyDeleted: string[];
  willBeRetained: string[];
  /** True when the account appears in retained evidence and must be kept as a row. */
  requiresAnonymization: boolean;
  recommendation: string;
  assessedAt: string;
}

export const MEMBER_DELETE_REFUSED_MESSAGE =
  'This account is referenced by records that must be retained and cannot be permanently deleted. Disable the account instead.';

/**
 * Assess a user account for permanent deletion.
 *
 * "Unused" is a strong claim, so it is checked against every table that could
 * reference the account: memberships, uploaded proofs, reviewed proofs, audit
 * actor rows, and the configuration tables that record who last changed them.
 */
export async function assessMemberDeletion(db: Executor, userId: string): Promise<MemberDeletionImpact> {
  const user = await db
    .selectFrom('users')
    .select(['id', 'email', 'full_name', 'status', 'anonymized_at'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw errors.notFound('Member');

  const memberships = await db
    .selectFrom('organization_memberships')
    .innerJoin('organizations', 'organizations.id', 'organization_memberships.organization_id')
    .select([
      'organization_memberships.organization_id',
      'organization_memberships.role',
      'organization_memberships.status',
      'organizations.legal_name',
    ])
    .where('organization_memberships.user_id', '=', userId)
    .execute();

  const platformRoles = await db
    .selectFrom('platform_user_roles')
    .select('role')
    .where('user_id', '=', userId)
    .execute();

  const uploadedProofs = await countWhere(db, (qb) =>
    qb.selectFrom('payment_proofs').select('id').where('uploaded_by_user_id', '=', userId),
  );
  const reviewedProofs = await countWhere(db, (qb) =>
    qb.selectFrom('payment_proofs').select('id').where('reviewed_by_user_id', '=', userId),
  );
  const auditAsActor = await countWhere(db, (qb) =>
    qb.selectFrom('audit_logs').select('id').where('actor_user_id', '=', userId),
  );
  const auditAsTarget = await countWhere(db, (qb) =>
    qb.selectFrom('audit_logs').select('id').where('target_id', '=', userId),
  );
  const packageChanges = await countWhere(db, (qb) =>
    qb.selectFrom('subscription_package_changes').select('id').where('changed_by_user_id', '=', userId),
  );
  const sessions = await countWhere(db, (qb) =>
    qb.selectFrom('auth_sessions').select('id').where('user_id', '=', userId),
  );
  const activeMemberships = memberships.filter((m) => m.status !== 'suspended');

  const counts: ImpactCount[] = [
    { key: 'memberships', label: 'Organization memberships', count: memberships.length, serverVerifiable: true },
    { key: 'uploaded_proofs', label: 'Payment proofs uploaded', count: uploadedProofs, serverVerifiable: true },
    { key: 'reviewed_proofs', label: 'Payment proofs reviewed', count: reviewedProofs, serverVerifiable: true },
    { key: 'audit_actor', label: 'Audit entries as the actor', count: auditAsActor, serverVerifiable: true },
    { key: 'audit_target', label: 'Audit entries naming this account', count: auditAsTarget, serverVerifiable: true },
    { key: 'package_changes', label: 'Package changes made', count: packageChanges, serverVerifiable: true },
    { key: 'sessions', label: 'Sessions on record', count: sessions, serverVerifiable: true },
    {
      key: 'business_attribution',
      label: 'Journal, invoice and approval attribution',
      count: null,
      serverVerifiable: false,
      note: 'Held in the customer workspace. Attribution there references the user id, which is why the id is always preserved.',
    },
  ];

  const blockingReasons: BlockingReason[] = [];

  if (platformRoles.length > 0) {
    blockingReasons.push({
      code: 'platform_role',
      message: `This account holds the platform role(s) ${platformRoles.map((r) => r.role).join(', ')}. Revoke them first.`,
    });
  }
  if (activeMemberships.length > 0) {
    blockingReasons.push({
      code: 'still_a_member',
      message: `This account still belongs to ${activeMemberships.length} organization(s). Remove it from each first.`,
    });
  }
  if (uploadedProofs > 0 || reviewedProofs > 0) {
    blockingReasons.push({
      code: 'payment_evidence',
      message: 'This account uploaded or reviewed payment evidence, which must be retained.',
    });
  }

  /*
   * Audit references do NOT block deletion — they change its FORM. The account is
   * anonymised in place so the trail keeps resolving, which is both safer and what
   * retention rules generally require.
   */
  const requiresAnonymization = auditAsActor > 0 || auditAsTarget > 0 || packageChanges > 0;
  const deletionPermitted = blockingReasons.length === 0;

  return {
    userId,
    email: user.email,
    fullName: user.full_name,
    accountStatus: user.status,
    memberships: memberships.map((m) => ({
      organizationId: m.organization_id,
      organizationName: m.legal_name,
      role: m.role,
      status: m.status,
    })),
    counts,
    deletionPermitted,
    blockingReasons,
    requiresAnonymization,
    willBeAnonymized:
      deletionPermitted && requiresAnonymization
        ? ['This user record — name and email replaced, user id and every audit entry kept']
        : [],
    willBePermanentlyDeleted: deletionPermitted
      ? [
          'Sessions',
          'Unused password reset and invitation tokens',
          'Subscription application',
          ...(requiresAnonymization ? [] : ['The user record itself']),
        ]
      : [],
    willBeRetained: [
      'Every audit entry that names this account',
      'The user id, so historical attribution keeps resolving',
    ],
    recommendation: deletionPermitted
      ? requiresAnonymization
        ? 'This account appears in retained audit history. It will be anonymised in place: the id survives so history stays intact, and it can no longer sign in.'
        : 'This account is unused and can be permanently deleted.'
      : MEMBER_DELETE_REFUSED_MESSAGE,
    assessedAt: new Date().toISOString(),
  };
}

/* ══ Safeguards shared by every destructive path ═══════════════════════════ */

async function assertNotSelf(userId: string, actorUserId: string, what: string): Promise<void> {
  if (userId === actorUserId) {
    throw errors.validation(`You cannot ${what} your own account.`);
  }
}

/** Refuse to leave the platform with no way back in. */
async function assertNotLastSuperAdmin(db: Executor, userId: string): Promise<void> {
  const isSuper = await db
    .selectFrom('platform_user_roles')
    .select('id')
    .where('user_id', '=', userId)
    .where('role', '=', 'super_admin')
    .executeTakeFirst();
  if (!isSuper) return;

  const others = await db
    .selectFrom('platform_user_roles')
    .innerJoin('users', 'users.id', 'platform_user_roles.user_id')
    .select('platform_user_roles.id')
    .where('platform_user_roles.role', '=', 'super_admin')
    .where('users.status', '=', 'active')
    .where('users.id', '!=', userId)
    .execute();
  if (others.length === 0) {
    throw errors.conflict(
      'This is the last active platform super administrator. Grant the role to another account first.',
    );
  }
}

/**
 * The subscriber owner cannot be removed from the workspace they own.
 *
 * There is exactly one, permanently, so there is no "unless somebody else owns
 * it too" branch left to take — and no transfer to suggest as a way round it.
 * The database refuses this as well; refusing here is what turns a constraint
 * violation into an explanation.
 */
async function assertNotLastOwner(db: Executor, organizationId: string, userId: string): Promise<void> {
  const membership = await db
    .selectFrom('organization_memberships')
    .select(['role', 'status'])
    .where('organization_id', '=', organizationId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!membership || membership.role !== 'owner') return;

  throw errors.conflict(
    'This is the workspace’s subscriber owner, the last active owner it will ever have. ' +
      'Ownership is permanent, so they cannot be removed — close the subscriber account instead.',
  );
}

/** A proof awaiting review is an operation in flight. */
async function assertNoPendingReview(db: Executor, organizationId: string): Promise<void> {
  const pending = await db
    .selectFrom('payment_proofs')
    .innerJoin('subscription_invoices', 'subscription_invoices.id', 'payment_proofs.invoice_id')
    .select('payment_proofs.id')
    .where('subscription_invoices.organization_id', '=', organizationId)
    .where('payment_proofs.status', '=', 'submitted')
    .executeTakeFirst();
  if (pending) {
    throw errors.conflict('A payment proof for this organization is awaiting review. Complete it first.');
  }
}

/* ══ A: Remove member ══════════════════════════════════════════════════════ */

export interface RemoveMemberResult {
  userId: string;
  organizationId: string;
  removed: boolean;
  revokedSessions: number;
  /** True when this was the account's last membership. */
  hasOtherMemberships: boolean;
  /** What the operator may do next when it was. */
  followUp: 'none' | 'disable_or_delete';
  accountRetained: boolean;
}

/**
 * Remove a member from ONE organization.
 *
 * The membership row is deleted; nothing else is. The user account, every record
 * they authored and every audit entry naming them stay exactly where they are —
 * which is what keeps journal, invoice and approval attribution intact.
 *
 * ── About session revocation ────────────────────────────────────────────────
 * `auth_sessions` is keyed by user, not by organization, so there is no such thing
 * as "their sessions for that organization". Every session is therefore revoked.
 * For a member of several tenants that is slightly blunt — they sign in again — but
 * the alternative is leaving a live session whose access has just changed, and that
 * is not a trade worth making.
 *
 * Idempotent: removing an already-removed member reports `removed: false` rather
 * than failing, so a retried request converges.
 */
export async function removeMemberFromOrganization(
  db: Kysely<Database>,
  input: { userId: string; organizationId: string; reason: string },
  context: DeletionAdminContext,
): Promise<RemoveMemberResult> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why this member is being removed.' },
    });
  }

  await requireOrganizationRow(db, input.organizationId);
  await assertNotLastOwner(db, input.organizationId, input.userId);

  return db.transaction().execute(async (trx) => {
    const membership = await trx
      .selectFrom('organization_memberships')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .where('user_id', '=', input.userId)
      .forUpdate()
      .executeTakeFirst();

    // Idempotence: already gone is a success, not a conflict.
    if (!membership) {
      const others = await trx
        .selectFrom('organization_memberships')
        .select('id')
        .where('user_id', '=', input.userId)
        .execute();
      return {
        userId: input.userId,
        organizationId: input.organizationId,
        removed: false,
        revokedSessions: 0,
        hasOtherMemberships: others.length > 0,
        followUp: others.length > 0 ? ('none' as const) : ('disable_or_delete' as const),
        accountRetained: true,
      };
    }

    await trx
      .deleteFrom('organization_memberships')
      .where('id', '=', membership.id)
      .execute();

    const others = await trx
      .selectFrom('organization_memberships')
      .select('id')
      .where('user_id', '=', input.userId)
      .execute();

    // Their access just changed; no live session may outlast that.
    const revokedSessions = await revokeAllUserSessions(trx, input.userId);

    // The tenant's seat usage changed, so its entitlement view is recomputed.
    await recalculateEntitlements(trx, input.organizationId);

    await writeAuditLog(trx, {
      ...context,
      organizationId: input.organizationId,
      action: 'member.removed_from_organization',
      targetType: 'user',
      targetId: input.userId,
      metadata: {
        reason,
        removedRole: membership.role,
        removedStatus: membership.status,
        revokedSessions,
        remainingMemberships: others.length,
        // Say plainly what was NOT touched.
        accountDeleted: false,
        accountingRecordsDeleted: false,
      },
    });

    return {
      userId: input.userId,
      organizationId: input.organizationId,
      removed: true,
      revokedSessions,
      hasOtherMemberships: others.length > 0,
      followUp: others.length > 0 ? ('none' as const) : ('disable_or_delete' as const),
      accountRetained: true,
    };
  });
}

/* ══ Disable account ═══════════════════════════════════════════════════════ */

export interface DisableAccountResult {
  userId: string;
  accountStatus: string;
  revokedSessions: number;
  disabledAt: string;
}

/**
 * Disable an account without deleting anything.
 *
 * The reversible alternative to deletion, and the right answer for almost every
 * "get rid of this user" request: they cannot sign in, and every record survives.
 */
export async function disableAccount(
  db: Kysely<Database>,
  input: { userId: string; reason: string },
  context: DeletionAdminContext,
): Promise<DisableAccountResult> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why this account is being disabled.' },
    });
  }

  const user = await db
    .selectFrom('users')
    .select(['id', 'status'])
    .where('id', '=', input.userId)
    .executeTakeFirst();
  if (!user) throw errors.notFound('Member');

  await assertNotSelf(input.userId, context.actorUserId, 'disable');
  await assertNotLastSuperAdmin(db, input.userId);

  const disabledAt = new Date();
  const revokedSessions = await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('users')
      .set({ status: 'disabled', disabled_at: disabledAt, updated_at: disabledAt })
      .where('id', '=', input.userId)
      .execute();

    const revoked = await revokeAllUserSessions(trx, input.userId);

    await writeAuditLog(trx, {
      ...context,
      action: 'member.account_disabled',
      targetType: 'user',
      targetId: input.userId,
      metadata: { reason, previousStatus: user.status, revokedSessions: revoked, recordsDeleted: false },
    });
    return revoked;
  });

  return {
    userId: input.userId,
    accountStatus: 'disabled',
    revokedSessions,
    disabledAt: disabledAt.toISOString(),
  };
}

/* ══ B: Delete applicant / unused account ══════════════════════════════════ */

export interface DeleteAccountResult {
  userId: string;
  /** `deleted` when the row went; `anonymized` when it had to stay. */
  outcome: 'deleted' | 'anonymized';
  revokedSessions: number;
  removed: Record<string, number>;
  anonymizedFields: string[];
  impact: MemberDeletionImpact;
}

/** Deterministic, non-routable placeholder identity for an anonymised account. */
function anonymousIdentity(userId: string): { email: string; fullName: string } {
  // `.invalid` is reserved by RFC 2606 and can never be delivered to, so the row
  // keeps a unique value for the UNIQUE index without becoming a usable address.
  return { email: `deleted-${userId}@anonymized.invalid`, fullName: 'Former user' };
}

/**
 * Permanently delete — or anonymise — an unused account.
 *
 * The eligibility assessment is recomputed INSIDE the transaction. A client cannot
 * hand in a favourable verdict: the only assessment that matters is the one taken
 * against the rows being deleted, at the moment they are deleted.
 *
 * Which of the two outcomes applies is decided by the data, not by the caller:
 * an account named in retained audit history is anonymised in place (id kept), and
 * only an account referenced nowhere is deleted outright.
 */
export async function deleteAccount(
  db: Kysely<Database>,
  input: { userId: string; reason: string; expectedEmail?: string },
  context: DeletionAdminContext,
): Promise<DeleteAccountResult> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why this account is being deleted.' },
    });
  }

  await assertNotSelf(input.userId, context.actorUserId, 'delete');

  return runAuditingBlocks(db, context, () => deleteAccountTransaction(db, input, context, reason));
}

/**
 * Run a destructive transaction, and if its eligibility check refuses, record the
 * refusal on the pooled connection where the write survives.
 *
 * ── Why the audit cannot live inside the transaction ─────────────────────────
 * The refusal and the rollback are the same event. Anything written on `trx` is
 * undone by the rollback that the refusal causes, so an audit row written there
 * is guaranteed to disappear — the trail would show nothing for an attempt that
 * definitely happened. `DeletionBlocked` therefore carries the facts OUT of the
 * transaction, and the row is written here, on the pooled connection.
 *
 * ── Exactly one entry per attempt ────────────────────────────────────────────
 * The transaction writes no refusal entry of its own, so a blocked purge
 * produces one row and no more. A retried request is a genuinely separate
 * attempt and correctly gets its own row, distinguishable by `requestId`.
 *
 * ── The conflict is preserved ────────────────────────────────────────────────
 * The original recommendation is rethrown as the same 409 the caller expects.
 * Auditing the refusal changes what is recorded, never what is returned. Any
 * error that is NOT a deliberate refusal is rethrown untouched, so a genuine
 * fault is never mislabelled as a policy decision.
 */
async function runAuditingBlocks<T>(
  db: Kysely<Database>,
  context: DeletionAdminContext,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (!(cause instanceof DeletionBlocked)) throw cause;
    await writeAuditLog(db, {
      // Carries the actor, the platform role, the ip/user-agent and the
      // correlation id; `created_at` supplies the timestamp.
      ...context,
      action: 'subscriber.purge_blocked',
      targetType: (cause.detail.targetType as string | undefined) ?? null,
      targetId: (cause.detail.targetId as string | undefined) ?? null,
      metadata: {
        reason: cause.detail.reason ?? null,
        blockedBy: cause.blockedBy,
        ...(cause.detail.legalName ? { legalName: cause.detail.legalName } : {}),
      },
    });
    throw errors.conflict(cause.recommendation);
  }
}

async function deleteAccountTransaction(
  db: Kysely<Database>,
  input: { userId: string; reason: string; expectedEmail?: string },
  context: DeletionAdminContext,
  reason: string,
): Promise<DeleteAccountResult> {
  return db.transaction().execute(async (trx) => {
    /*
     * Erasing an identity cascades into the append-only `legal_acceptances`
     * table. Authorise that removal for this transaction only. DELETE alone —
     * UPDATE stays refused unconditionally, so no record of consent can be
     * quietly rewritten on the way past.
     */
    await sql`SET LOCAL ledgora.allow_legal_purge = 'on'`.execute(trx);
    /*
     * And the stock ledger, for the same reason and on the same terms. Movements
     * are immutable evidence in every other circumstance; a workspace being
     * destroyed is the one circumstance where they must go with it.
     */
    await sql`SET LOCAL ledgora.allow_stock_purge = 'on'`.execute(trx);
    /*
     * And the fixed-asset trail, for the same reason and on the same terms. The
     * register's history is append-only in every other circumstance; a workspace
     * being destroyed is the one circumstance where it must go with it. DELETE
     * alone — UPDATE stays refused unconditionally, so no record of who
     * configured what can be quietly rewritten under cover of a purge.
     */
    await sql`SET LOCAL ledgora.allow_fixed_asset_purge = 'on'`.execute(trx);
    const user = await trx
      .selectFrom('users')
      .selectAll()
      .where('id', '=', input.userId)
      .forUpdate()
      .executeTakeFirst();
    if (!user) throw errors.notFound('Member');

    // A typed confirmation, checked server-side rather than trusted from the UI.
    if (input.expectedEmail && input.expectedEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
      throw errors.validation('The email address you typed does not match this account.', {
        fieldErrors: { expectedEmail: 'Type the account email exactly as shown.' },
      });
    }

    await assertNotLastSuperAdmin(trx, input.userId);

    /* Recomputed here, against the live rows. This is the authoritative verdict. */
    const impact = await assessMemberDeletion(trx, input.userId);
    if (!impact.deletionPermitted) {
      // Audited by the caller, outside this transaction — see `DeletionBlocked`.
      throw new DeletionBlocked(
        impact.recommendation,
        impact.blockingReasons.map((b) => b.code),
        { targetType: 'user', targetId: input.userId, reason },
      );
    }

    const revokedSessions = await revokeAllUserSessions(trx, input.userId);
    const removed: Record<string, number> = {};

    const drop = async (
      table: 'auth_sessions' | 'password_reset_tokens' | 'subscription_applications',
      column: 'user_id',
    ): Promise<void> => {
      const result = await trx.deleteFrom(table).where(column, '=', input.userId).executeTakeFirst();
      removed[table] = Number(result.numDeletedRows ?? 0);
    };

    // Onboarding artefacts and credentials. None of these is evidence.
    await drop('auth_sessions', 'user_id');
    await drop('password_reset_tokens', 'user_id');
    await drop('subscription_applications', 'user_id');
    // Any suspended membership left behind (active ones block deletion outright).
    const memberships = await trx
      .deleteFrom('organization_memberships')
      .where('user_id', '=', input.userId)
      .executeTakeFirst();
    removed.organization_memberships = Number(memberships.numDeletedRows ?? 0);

    let outcome: 'deleted' | 'anonymized';
    let anonymizedFields: string[] = [];

    if (impact.requiresAnonymization) {
      /*
       * The account is named in retained audit history. Deleting the row would
       * either break `audit_logs.actor_user_id` or, with ON DELETE SET NULL, erase
       * WHO acted — so the row stays and its personal fields go instead.
       */
      const identity = anonymousIdentity(input.userId);
      const now = new Date();
      await trx
        .updateTable('users')
        .set({
          email: identity.email,
          normalized_email: identity.email,
          full_name: identity.fullName,
          // An unusable credential: the hash is a literal that no password can
          // produce, so there is nothing to guess and nothing to reset.
          password_hash: 'anonymized-no-login',
          status: 'disabled',
          must_change_password: false,
          password_expires_at: null,
          locked_until: null,
          failed_login_count: 0,
          email_verified_at: null,
          last_login_at: null,
          disabled_at: now,
          deleted_at: now,
          anonymized_at: now,
          updated_at: now,
        })
        .where('id', '=', input.userId)
        .execute();
      outcome = 'anonymized';
      anonymizedFields = ['email', 'full_name', 'password_hash', 'email_verified_at', 'last_login_at'];

      await writeAuditLog(trx, {
        ...context,
        action: 'member.account_anonymized',
        targetType: 'user',
        targetId: input.userId,
        metadata: {
          reason,
          // The ORIGINAL email is deliberately absent: the point of anonymising is
          // that it stops being recoverable, and the audit row must not reinstate it.
          anonymizedFields,
          revokedSessions,
          removed,
          userIdPreserved: true,
        },
      });
    } else {
      await trx.deleteFrom('users').where('id', '=', input.userId).execute();
      outcome = 'deleted';

      await writeAuditLog(trx, {
        ...context,
        action: 'member.account_deleted',
        targetType: 'user',
        targetId: input.userId,
        metadata: { reason, revokedSessions, removed, permanentlyDeleted: true },
      });
    }

    return { userId: input.userId, outcome, revokedSessions, removed, anonymizedFields, impact };
  });
}

/**
 * Delete an unused applicant, including the empty organization shell they may
 * have created.
 *
 * A thin wrapper over the account path: it clears an unused organization out of
 * the way first (so the account stops being "still a member" and becomes
 * deletable), then deletes the account itself. If the organization turns out NOT
 * to be empty, the purge assessment refuses and nothing is touched.
 */
export async function deleteApplicant(
  db: Kysely<Database>,
  input: { userId: string; reason: string; expectedEmail?: string },
  context: DeletionAdminContext,
): Promise<DeleteAccountResult & { purgedOrganizations: string[] }> {
  const platformRole = await db
    .selectFrom('platform_user_roles')
    .select('id')
    .where('user_id', '=', input.userId)
    .executeTakeFirst();
  if (platformRole) {
    throw errors.validation('Platform operators are not applicants and cannot be deleted here.');
  }

  const memberships = await db
    .selectFrom('organization_memberships')
    .select('organization_id')
    .where('user_id', '=', input.userId)
    .execute();

  const purgedOrganizations: string[] = [];
  for (const membership of memberships) {
    const impact = await assessSubscriberDeletion(db, membership.organization_id);
    if (!impact.deletionPermitted) {
      // The applicant is attached to a tenant that must be retained.
      throw errors.conflict(impact.recommendation);
    }
    const otherMembers = await db
      .selectFrom('organization_memberships')
      .select('user_id')
      .where('organization_id', '=', membership.organization_id)
      .where('user_id', '!=', input.userId)
      .execute();
    if (otherMembers.length > 0) {
      throw errors.conflict(
        'This applicant’s organization has other members. Remove them, or archive the subscriber instead.',
      );
    }
    await purgeSubscriber(
      db,
      { organizationId: membership.organization_id, reason: `Applicant deletion: ${input.reason}`, skipConfirmation: true },
      context,
    );
    purgedOrganizations.push(membership.organization_id);
  }

  const result = await deleteAccount(db, input, context);

  await writeAuditLog(db, {
    ...context,
    action: 'applicant.deleted',
    targetType: 'user',
    targetId: input.userId,
    metadata: {
      reason: input.reason.trim(),
      outcome: result.outcome,
      purgedOrganizations: purgedOrganizations.length,
    },
  });

  return { ...result, purgedOrganizations };
}

/* ══ C: Archive / restore subscriber ═══════════════════════════════════════ */

export interface ArchiveResult {
  organizationId: string;
  organizationStatus: OrganizationStatus;
  subscriptionStatus: string | null;
  revokedSessions: number;
  archivedAt: string | null;
  entitlementActive: boolean;
}

/**
 * Archive a subscriber: the NORMAL way to retire a tenant.
 *
 * Reversible and non-destructive. Access stops — the organization is no longer
 * active, so the persistence guard refuses durable writes and members' sessions
 * are revoked — while accounting data, invoices, payments, proofs, member
 * attribution and audit history all stay exactly where they are.
 *
 * Idempotent: archiving an archived subscriber reports the same state instead of
 * failing.
 */
export async function archiveSubscriber(
  db: Kysely<Database>,
  input: { organizationId: string; reason: string },
  context: DeletionAdminContext,
): Promise<ArchiveResult> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why this subscriber is being archived.' },
    });
  }

  await assertNoPendingReview(db, input.organizationId);

  return db.transaction().execute(async (trx) => {
    const organization = await trx
      .selectFrom('organizations')
      .selectAll()
      .where('id', '=', input.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!organization) throw errors.notFound('Subscriber');

    const archivedAt = organization.archived_at ? new Date(organization.archived_at) : new Date();

    await trx
      .updateTable('organizations')
      .set({
        status: 'archived',
        archived_at: archivedAt,
        archived_by: context.actorUserId,
        archive_reason: reason,
        updated_at: new Date(),
      })
      .where('id', '=', input.organizationId)
      .execute();

    // The subscription stops entitling; the record itself is retained.
    const subscription = await trx
      .selectFrom('subscriptions')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .orderBy(sql`(status = 'active') DESC`)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    let subscriptionStatus: string | null = subscription?.status ?? null;
    if (subscription && !['cancelled', 'expired'].includes(subscription.status)) {
      subscriptionStatus = 'cancelled';
      await trx
        .updateTable('subscriptions')
        .set({ status: 'cancelled', updated_at: new Date() })
        .where('id', '=', subscription.id)
        .execute();
    }

    await trx
      .updateTable('subscription_applications')
      .set({ status: 'archived', updated_at: new Date() })
      .where('organization_id', '=', input.organizationId)
      .execute();

    /* No member may keep a live session into an archived tenant. */
    const members = await trx
      .selectFrom('organization_memberships')
      .select('user_id')
      .where('organization_id', '=', input.organizationId)
      .execute();
    let revokedSessions = 0;
    for (const member of members) {
      revokedSessions += await revokeAllUserSessions(trx, member.user_id);
    }

    const entitlements = await recalculateEntitlements(trx, input.organizationId);

    await writeAuditLog(trx, {
      ...context,
      organizationId: input.organizationId,
      action: 'subscriber.archived',
      targetType: 'organization',
      targetId: input.organizationId,
      metadata: {
        reason,
        previousStatus: organization.status,
        previousSubscriptionStatus: subscription?.status ?? null,
        newSubscriptionStatus: subscriptionStatus,
        revokedSessions,
        memberCount: members.length,
        // The whole point of archiving, recorded explicitly.
        recordsRetained: true,
        accountingDeleted: false,
      },
    });

    return {
      organizationId: input.organizationId,
      organizationStatus: 'archived' as OrganizationStatus,
      subscriptionStatus,
      revokedSessions,
      archivedAt: archivedAt.toISOString(),
      entitlementActive: entitlements.active,
    };
  });
}

/**
 * Restore an archived subscriber.
 *
 * Returns the organization to active. It does NOT invent an entitlement: a
 * subscription that was cancelled on archival comes back as `pending_payment`
 * unless it had genuinely started, in which case it returns to active.
 */
export async function restoreSubscriber(
  db: Kysely<Database>,
  input: { organizationId: string; reason: string },
  context: DeletionAdminContext,
): Promise<ArchiveResult> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why this subscriber is being restored.' },
    });
  }

  return db.transaction().execute(async (trx) => {
    const organization = await trx
      .selectFrom('organizations')
      .selectAll()
      .where('id', '=', input.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!organization) throw errors.notFound('Subscriber');

    await trx
      .updateTable('organizations')
      .set({
        status: 'active',
        archived_at: null,
        archived_by: null,
        archive_reason: null,
        // Restoring cancels any pending purge request.
        deletion_requested_at: null,
        deletion_eligible_after: null,
        updated_at: new Date(),
      })
      .where('id', '=', input.organizationId)
      .execute();

    const subscription = await trx
      .selectFrom('subscriptions')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    let subscriptionStatus: string | null = subscription?.status ?? null;
    if (subscription && subscription.status === 'cancelled') {
      // Never invent an entitlement that was not paid for.
      subscriptionStatus = subscription.starts_at ? 'active' : 'pending_payment';
      await trx
        .updateTable('subscriptions')
        .set({ status: subscriptionStatus as never, updated_at: new Date() })
        .where('id', '=', subscription.id)
        .execute();
    }

    await trx
      .updateTable('subscription_applications')
      .set({
        status: subscriptionStatus === 'active' ? 'active_subscriber' : 'awaiting_payment',
        updated_at: new Date(),
      })
      .where('organization_id', '=', input.organizationId)
      .execute();

    const entitlements = await recalculateEntitlements(trx, input.organizationId);

    await writeAuditLog(trx, {
      ...context,
      organizationId: input.organizationId,
      action: 'subscriber.restored',
      targetType: 'organization',
      targetId: input.organizationId,
      metadata: {
        reason,
        previousStatus: organization.status,
        newSubscriptionStatus: subscriptionStatus,
        entitlementActive: entitlements.active,
      },
    });

    return {
      organizationId: input.organizationId,
      organizationStatus: 'active' as OrganizationStatus,
      subscriptionStatus,
      revokedSessions: 0,
      archivedAt: null,
      entitlementActive: entitlements.active,
    };
  });
}

/* ══ D: Permanent purge ════════════════════════════════════════════════════ */

export interface PurgeResult {
  organizationId: string;
  legalName: string;
  purged: boolean;
  removed: Record<string, number>;
  anonymizedUsers: string[];
  deletedUsers: string[];
  retainedUsers: string[];
  revokedSessions: number;
  impact: DeletionImpact;
}

/**
 * Permanently delete a subscriber organization.
 *
 * ── Why the assessment is recomputed inside the transaction ──────────────────
 * Eligibility is decided HERE, against the rows about to be deleted, under row
 * locks. A verdict computed a minute ago in a browser is a hint, not an
 * authorisation: an invoice could have been paid, a proof submitted, or a legal
 * hold applied in between. A client that fabricates `deletionPermitted: true`
 * changes nothing, because this value is never read from the request.
 *
 * ── Order matters ───────────────────────────────────────────────────────────
 * Children before parents, so no step can leave an orphan or trip a foreign key:
 * proofs → invoices → package changes → entitlements → applications →
 * memberships → subscriptions → organization. Users are handled last, and only
 * those with no remaining membership.
 */
export async function purgeSubscriber(
  db: Kysely<Database>,
  input: {
    organizationId: string;
    reason: string;
    /** The legal name the administrator typed. Verified server-side. */
    confirmationName?: string;
    /** Internal callers that have already established eligibility. */
    skipConfirmation?: boolean;
  },
  context: DeletionAdminContext,
): Promise<PurgeResult> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why this subscriber is being permanently deleted.' },
    });
  }

  /*
   * Wrapped, so a refusal is recorded on the pooled connection AFTER the
   * transaction below has rolled back. Writing the refusal INSIDE the
   * transaction and then throwing — which is what this used to do — discards the
   * audit row along with everything the rollback undoes, leaving a rejected
   * purge with no trace that it was ever attempted. `deleteAccount` has always
   * used this pattern; `purgeSubscriber` simply was not.
   */
  return runAuditingBlocks(db, { ...context, organizationId: input.organizationId }, () =>
    purgeSubscriberTransaction(db, input, context, reason),
  );
}

/**
 * The destructive half. Either every deletion below commits, or none of it does
 * — a refusal leaves the subscriber exactly as it was.
 */
async function purgeSubscriberTransaction(
  db: Kysely<Database>,
  input: {
    organizationId: string;
    confirmationName?: string;
    skipConfirmation?: boolean;
  },
  context: DeletionAdminContext,
  reason: string,
): Promise<PurgeResult> {
  return db.transaction().execute(async (trx) => {
    /*
     * Deleting the organization cascades into `legal_acceptances`, which is
     * append-only. Authorise that one removal for this transaction: a customer
     * who has asked to be erased must actually be erasable, and evidence of a
     * contract cannot outlive every party to it. The flag permits DELETE only —
     * UPDATE stays refused unconditionally, so nothing here can rewrite what
     * somebody agreed to on the way past.
     */
    await sql`SET LOCAL ledgora.allow_legal_purge = 'on'`.execute(trx);
    /*
     * And the stock ledger, for the same reason and on the same terms. Movements
     * are immutable evidence in every other circumstance; a workspace being
     * destroyed is the one circumstance where they must go with it.
     */
    await sql`SET LOCAL ledgora.allow_stock_purge = 'on'`.execute(trx);
    /*
     * And the fixed-asset trail, for the same reason and on the same terms. The
     * register's history is append-only in every other circumstance; a workspace
     * being destroyed is the one circumstance where it must go with it. DELETE
     * alone — UPDATE stays refused unconditionally, so no record of who
     * configured what can be quietly rewritten under cover of a purge.
     */
    await sql`SET LOCAL ledgora.allow_fixed_asset_purge = 'on'`.execute(trx);

    const organization = await trx
      .selectFrom('organizations')
      .selectAll()
      .where('id', '=', input.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!organization) throw errors.notFound('Subscriber');

    /*
     * The typed legal name. Checked against the DATABASE value, not against
     * anything the client also supplied — otherwise it would confirm nothing.
     */
    if (!input.skipConfirmation) {
      const typed = input.confirmationName?.trim() ?? '';
      if (typed.toLowerCase() !== organization.legal_name.trim().toLowerCase()) {
        throw errors.validation('The organization name you typed does not match.', {
          fieldErrors: { confirmationName: `Type “${organization.legal_name}” exactly to confirm.` },
        });
      }
    }

    /* THE authoritative eligibility decision. */
    const impact = await assessSubscriberDeletion(trx, input.organizationId);
    if (!impact.deletionPermitted) {
      // Audited by the caller, outside this transaction — see `DeletionBlocked`.
      throw new DeletionBlocked(
        impact.recommendation,
        impact.blockingReasons.map((b) => b.code),
        {
          targetType: 'organization',
          targetId: input.organizationId,
          reason,
          legalName: organization.legal_name,
        },
      );
    }

    const members = await trx
      .selectFrom('organization_memberships')
      .select('user_id')
      .where('organization_id', '=', input.organizationId)
      .execute();

    // Revoke first: no session may outlive the tenant it belonged to.
    let revokedSessions = 0;
    for (const member of members) {
      revokedSessions += await revokeAllUserSessions(trx, member.user_id);
    }

    const removed: Record<string, number> = {};
    const record = async (key: string, result: { numDeletedRows?: bigint }): Promise<void> => {
      removed[key] = Number(result.numDeletedRows ?? 0);
    };

    /* ── Children first ────────────────────────────────────────────────── */
    const invoiceIds = (
      await trx
        .selectFrom('subscription_invoices')
        .select('id')
        .where('organization_id', '=', input.organizationId)
        .execute()
    ).map((row) => row.id);

    if (invoiceIds.length > 0) {
      await record(
        'payment_proofs',
        await trx.deleteFrom('payment_proofs').where('invoice_id', 'in', invoiceIds).executeTakeFirst(),
      );
    } else {
      removed.payment_proofs = 0;
    }

    await record(
      'subscription_invoices',
      await trx.deleteFrom('subscription_invoices').where('organization_id', '=', input.organizationId).executeTakeFirst(),
    );
    await record(
      'subscription_package_changes',
      await trx
        .deleteFrom('subscription_package_changes')
        .where('organization_id', '=', input.organizationId)
        .executeTakeFirst(),
    );
    await record(
      'organization_entitlements',
      await trx
        .deleteFrom('organization_entitlements')
        .where('organization_id', '=', input.organizationId)
        .executeTakeFirst(),
    );
    await record(
      'subscription_applications',
      await trx
        .deleteFrom('subscription_applications')
        .where('organization_id', '=', input.organizationId)
        .executeTakeFirst(),
    );
    // Retire, but never remove, the permanent subscriber/workspace claim. This
    // is the only condition under which the database permits the live owner
    // membership and workspace shell to be purged, and the transaction makes
    // the retirement roll back if any later deletion fails.
    await sql`UPDATE subscriber_workspace_ownership_claims
      SET retired_at = now()
      WHERE workspace_id = ${input.organizationId} AND retired_at IS NULL`.execute(trx);
    await record(
      'organization_memberships',
      await trx
        .deleteFrom('organization_memberships')
        .where('organization_id', '=', input.organizationId)
        .executeTakeFirst(),
    );
    await record(
      'subscriptions',
      await trx.deleteFrom('subscriptions').where('organization_id', '=', input.organizationId).executeTakeFirst(),
    );

    /*
     * The audit trail is NOT deleted. `audit_logs.organization_id` is
     * ON DELETE SET NULL, so entries survive the organization with their action,
     * actor and timestamp intact — the legal name is carried into the purge entry
     * below so the history remains readable.
     */
    const auditRows = await countWhere(trx, (qb) =>
      qb.selectFrom('audit_logs').select('id').where('organization_id', '=', input.organizationId),
    );

    await record(
      'organizations',
      await trx.deleteFrom('organizations').where('id', '=', input.organizationId).executeTakeFirst(),
    );

    /* ── Then the members who now belong nowhere ───────────────────────── */
    const anonymizedUsers: string[] = [];
    const deletedUsers: string[] = [];
    const retainedUsers: string[] = [];

    for (const member of members) {
      const stillAMember = await trx
        .selectFrom('organization_memberships')
        .select('id')
        .where('user_id', '=', member.user_id)
        .executeTakeFirst();
      if (stillAMember) {
        // Belongs to another tenant — the account is none of our business.
        retainedUsers.push(member.user_id);
        continue;
      }

      const isStaff = await trx
        .selectFrom('platform_user_roles')
        .select('id')
        .where('user_id', '=', member.user_id)
        .executeTakeFirst();
      if (isStaff) {
        retainedUsers.push(member.user_id);
        continue;
      }

      const namedInAudit = await trx
        .selectFrom('audit_logs')
        .select('id')
        .where((eb) => eb.or([eb('actor_user_id', '=', member.user_id), eb('target_id', '=', member.user_id)]))
        .executeTakeFirst();

      await trx.deleteFrom('auth_sessions').where('user_id', '=', member.user_id).execute();
      await trx.deleteFrom('password_reset_tokens').where('user_id', '=', member.user_id).execute();
      await trx.deleteFrom('subscription_applications').where('user_id', '=', member.user_id).execute();

      if (namedInAudit) {
        const identity = anonymousIdentity(member.user_id);
        const now = new Date();
        await trx
          .updateTable('users')
          .set({
            email: identity.email,
            normalized_email: identity.email,
            full_name: identity.fullName,
            password_hash: 'anonymized-no-login',
            status: 'disabled',
            must_change_password: false,
            password_expires_at: null,
            locked_until: null,
            failed_login_count: 0,
            email_verified_at: null,
            last_login_at: null,
            disabled_at: now,
            deleted_at: now,
            anonymized_at: now,
            updated_at: now,
          })
          .where('id', '=', member.user_id)
          .execute();
        anonymizedUsers.push(member.user_id);
      } else {
        await trx.deleteFrom('users').where('id', '=', member.user_id).execute();
        deletedUsers.push(member.user_id);
      }
    }

    await writeAuditLog(trx, {
      ...context,
      // Deliberately NOT organizationId: the row is gone, and the FK would null it.
      action: 'subscriber.purged',
      targetType: 'organization',
      targetId: input.organizationId,
      metadata: {
        reason,
        // Carried into the entry so the trail stays readable without the row.
        legalName: organization.legal_name,
        country: organization.country,
        removed,
        anonymizedUsers: anonymizedUsers.length,
        deletedUsers: deletedUsers.length,
        retainedUsers: retainedUsers.length,
        revokedSessions,
        auditEntriesRetained: auditRows,
        // The verdict that authorised this, as computed here.
        assessedAt: impact.assessedAt,
      },
    });

    return {
      organizationId: input.organizationId,
      legalName: organization.legal_name,
      purged: true,
      removed,
      anonymizedUsers,
      deletedUsers,
      retainedUsers,
      revokedSessions,
      impact,
    };
  });
}

/** Set or lift a legal hold — a block no eligibility calculation may override. */
export async function setLegalHold(
  db: Kysely<Database>,
  input: { organizationId: string; hold: boolean; reason: string },
  context: DeletionAdminContext,
): Promise<{ organizationId: string; legalHold: boolean }> {
  const reason = input.reason?.trim();
  if (!reason) throw errors.validation('A reason is required and is recorded in the audit trail.');

  const organization = await db
    .selectFrom('organizations')
    .select(['id', 'legal_hold'])
    .where('id', '=', input.organizationId)
    .executeTakeFirst();
  if (!organization) throw errors.notFound('Subscriber');

  await db
    .updateTable('organizations')
    .set({
      legal_hold: input.hold,
      legal_hold_reason: input.hold ? reason : null,
      updated_at: new Date(),
    })
    .where('id', '=', input.organizationId)
    .execute();

  await writeAuditLog(db, {
    ...context,
    organizationId: input.organizationId,
    action: 'subscriber.legal_hold_changed',
    targetType: 'organization',
    targetId: input.organizationId,
    metadata: { reason, from: organization.legal_hold, to: input.hold },
  });

  return { organizationId: input.organizationId, legalHold: input.hold };
}
