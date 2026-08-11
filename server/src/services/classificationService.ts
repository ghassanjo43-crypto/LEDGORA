/**
 * Legacy development-data classification.
 *
 * ── The contradiction this resolves ──────────────────────────────────────────
 * Migration `008` classifies every existing row `production`, because that is
 * the only safe default for a migration that cannot tell a real customer from a
 * developer's throwaway tenant. A database trigger then refuses every
 * `production → test|demo` move, permanently.
 *
 * Both of those are correct, and together they mean the development dataset this
 * whole feature exists to clean up is undeletable. Something has to be able to
 * say "these specific rows were never real". This module is that something, and
 * it is built so it can only ever say it about a development database.
 *
 * ── Why this is not an HTTP route ────────────────────────────────────────────
 * Reachability is the risk. An endpoint exists in every deployment, is one
 * authentication bug away from being called, and turns "route around retention"
 * into a request somebody can forge. A CLI has to be run by a person with shell
 * access to the machine, which in production is a different and much smaller set
 * of people than "anyone who can obtain a Super Admin session".
 *
 * The requirement offered an HTTP route behind a Super Admin check as an option.
 * The repository already reaches for CLIs for exactly this shape of task
 * (`cli/reconcileApplicants.ts`), and Platform Super Admin authority is
 * explicitly NOT sufficient to override retention — so a route guarded by it
 * would imply an authority that does not exist. Hence: no route.
 *
 * ── The layered refusals ─────────────────────────────────────────────────────
 * Each of these is independently sufficient to stop the operation:
 *   1. `config.isProduction` — refused, unconditionally, first.
 *   2. `ALLOW_LEGACY_DATA_CLASSIFICATION` — off by default, and `env.ts` THROWS
 *      at startup if it is set in production, so a leaked flag cannot arm this.
 *   3. Explicit organization ids only — never a predicate, never "all rows".
 *   4. Non-waivable blockers re-checked per organization.
 *   5. A dry run that mutates nothing, and a typed confirmation phrase.
 * Nothing here infers eligibility from a name, an email domain, a trial, a
 * package or a seeded id. The operator names the rows; the code only refuses.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config/env.js';
import type { Database, DataClassification } from '../db/schema.js';
import { writeAuditLog } from '../lib/audit.js';
import { everActivated } from './deletionService.js';

/** The operator must type this exactly. Deliberately awkward to paste by reflex. */
export const BOOTSTRAP_CONFIRMATION = 'RECLASSIFY DEVELOPMENT DATA';

/** Raised for every refusal, so a caller cannot mistake one for a partial success. */
export class ClassificationBootstrapRefused extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClassificationBootstrapRefused';
    this.code = code;
  }
}

export interface BootstrapCandidate {
  organizationId: string;
  legalName: string;
  currentClassification: string;
  /** Empty means this organization may be reclassified. */
  blockers: string[];
}

export interface BootstrapPreview {
  /** Correlates the preview with the mutation that follows, in the audit trail. */
  operationId: string;
  targetClassification: DataClassification;
  candidates: BootstrapCandidate[];
  eligibleCount: number;
  blockedCount: number;
}

export interface BootstrapInput {
  organizationIds: string[];
  targetClassification: DataClassification;
  /** Who is doing this. Recorded; never used to grant authority. */
  actorUserId: string | null;
  reason: string;
}

/**
 * Refuse unless this is a development or test environment with the flag set.
 *
 * Called by BOTH the preview and the mutation. The preview reads only, but it
 * also reveals which tenants are reclassifiable, and there is no reason for that
 * to answer in production either.
 */
function assertBootstrapPermitted(): void {
  const config = getConfig();

  /*
   * First and unconditional. This check does not consult the flag at all, so
   * enabling the flag in production cannot reach the code below — and `env.ts`
   * refuses to start in that case anyway. Two independent refusals, because a
   * single one is a single mistake away from not existing.
   */
  if (config.isProduction) {
    throw new ClassificationBootstrapRefused(
      'production_environment',
      'Legacy data classification cannot run in a production deployment. Production subscribers are permanently retained.',
    );
  }

  if (!config.ALLOW_LEGACY_DATA_CLASSIFICATION) {
    throw new ClassificationBootstrapRefused(
      'bootstrap_disabled',
      'Legacy data classification is disabled. Set ALLOW_LEGACY_DATA_CLASSIFICATION=true in a development environment to enable it.',
    );
  }
}

/**
 * The blockers a classification change cannot waive.
 *
 * These are the same protections `deletionService` treats as non-waivable, and
 * for the same reason: they protect something other than the tenant's own
 * business records, so a declaration that "this tenant was never real" has no
 * standing over them. Reclassifying past them would launder a protected tenant
 * into a deletable one in two steps.
 */
async function blockersFor(
  db: Kysely<Database>,
  organizationId: string,
): Promise<{ legalName: string; currentClassification: string; blockers: string[] } | null> {
  /*
   * Built from the SAME evidence the console's reconciliation dialog shows, so
   * the CLI and the UI cannot reach different verdicts about one organization.
   * Only the consequences differ: the CLI may act on a clean record, the console
   * may not.
   */
  const evidence = await gatherClassificationEvidence(db, organizationId);
  if (!evidence) return null;

  const blockers: string[] = [];

  if (evidence.legalHold) {
    blockers.push('A legal hold is in force. It must be lifted by the process that placed it.');
  }

  /*
   * A platform operator's identity is reachable from this tenant. Making the
   * tenant disposable puts that identity within reach of a cascade.
   */
  if (evidence.platformOperatorMember) {
    blockers.push('A platform administrator holds a membership here.');
  }

  return {
    legalName: evidence.legalName,
    currentClassification: evidence.currentClassification,
    blockers,
  };
}

/**
 * Dry run. Reads only — no transaction, no writes, nothing to roll back.
 *
 * Unknown ids are reported as blocked rather than skipped: an operator who
 * mistyped an id must see that, not a quietly shorter list.
 */
export async function previewLegacyClassification(
  db: Kysely<Database>,
  input: Omit<BootstrapInput, 'reason' | 'actorUserId'>,
): Promise<BootstrapPreview> {
  assertBootstrapPermitted();

  if (input.organizationIds.length === 0) {
    throw new ClassificationBootstrapRefused(
      'no_targets',
      'Name the organization ids to reclassify. This tool has no "all organizations" mode.',
    );
  }

  if (input.targetClassification === 'production') {
    throw new ClassificationBootstrapRefused(
      'wrong_direction',
      'This tool only classifies existing data as test or demo. Promotion to production is a normal, permitted operation.',
    );
  }

  const candidates: BootstrapCandidate[] = [];

  for (const organizationId of new Set(input.organizationIds)) {
    const found = await blockersFor(db, organizationId);

    candidates.push(
      found
        ? { organizationId, ...found }
        : {
            organizationId,
            legalName: '(not found)',
            currentClassification: '(not found)',
            blockers: ['No organization exists with this id.'],
          },
    );
  }

  return {
    operationId: randomUUID(),
    targetClassification: input.targetClassification,
    candidates,
    eligibleCount: candidates.filter((c) => c.blockers.length === 0).length,
    blockedCount: candidates.filter((c) => c.blockers.length > 0).length,
  };
}

export interface BootstrapResult {
  operationId: string;
  reclassified: BootstrapCandidate[];
  refused: BootstrapCandidate[];
}

/**
 * Apply the reclassification.
 *
 * All-or-nothing across the named organizations: if any one of them is blocked,
 * nothing is written. A partially-applied cleanup would leave the operator
 * guessing which half happened.
 */
export async function applyLegacyClassification(
  db: Kysely<Database>,
  input: BootstrapInput & { confirmation: string },
): Promise<BootstrapResult> {
  assertBootstrapPermitted();

  if (input.confirmation !== BOOTSTRAP_CONFIRMATION) {
    throw new ClassificationBootstrapRefused(
      'confirmation_mismatch',
      `Type ${BOOTSTRAP_CONFIRMATION} exactly to confirm this operation.`,
    );
  }

  const trimmedReason = input.reason.trim();
  if (trimmedReason.length < 10) {
    throw new ClassificationBootstrapRefused(
      'reason_required',
      'Record why these records are being reclassified. The audit entry is the only lasting explanation.',
    );
  }

  const preview = await previewLegacyClassification(db, {
    organizationIds: input.organizationIds,
    targetClassification: input.targetClassification,
  });

  const refused = preview.candidates.filter((c) => c.blockers.length > 0);
  if (refused.length > 0) {
    return { operationId: preview.operationId, reclassified: [], refused };
  }

  await db.transaction().execute(async (trx: Transaction<Database>) => {
    /*
     * Transaction-scoped, and the ONLY place in the codebase that sets it. SET
     * LOCAL means it disappears when this transaction ends however it ends, so
     * there is no state left behind for a later statement to inherit.
     */
    await sql`SET LOCAL ledgora.legacy_classification = 'on'`.execute(trx);

    for (const candidate of preview.candidates) {
      await trx
        .updateTable('organizations')
        .set({
          data_classification: input.targetClassification,
          classified_by: input.actorUserId,
          classification_reason: trimmedReason,
        })
        .where('id', '=', candidate.organizationId)
        /*
         * Re-assert the classification we previewed. If a concurrent writer
         * changed it between the preview and here, this row updates nothing
         * rather than reclassifying something the operator never reviewed.
         */
        .where('data_classification', '=', candidate.currentClassification as DataClassification)
        .execute();

      await writeAuditLog(trx, {
        action: 'organization.classification_bootstrapped',
        actorUserId: input.actorUserId,
        actorPlatformRole: null,
        organizationId: candidate.organizationId,
        targetType: 'organization',
        targetId: candidate.organizationId,
        metadata: {
          operationId: preview.operationId,
          previousClassification: candidate.currentClassification,
          newClassification: input.targetClassification,
          reason: trimmedReason,
          mechanism: 'development_cli',
        },
      });
    }
  });

  return { operationId: preview.operationId, reclassified: preview.candidates, refused: [] };
}

/* ══ Runtime reclassification ══════════════════════════════════════════════ */

/**
 * Change a subscriber's classification through the console.
 *
 * ── Why this one IS a route, when the bootstrap above is not ─────────────────
 * The two operations look similar and are opposites. The bootstrap above moves
 * data OUT of production protection, which is why it is a development-only CLI.
 * This one can only move data further IN — a disposable tenant becoming real, or
 * one flavour of disposable becoming another. Nothing it can do makes a
 * protected account destroyable, so exposing it to a Platform Super Admin grants
 * no authority over retention.
 *
 * The database trigger is the actual enforcement. The check below refuses the
 * same move a second time so the caller gets a sentence instead of a constraint
 * violation — but if this check were deleted, the operation would still fail.
 */
export const CLASSIFICATION_PERMANENT_MESSAGE =
  'Production classification is permanent. This subscriber cannot be reclassified as Demo or Test.';

export interface ChangeClassificationInput {
  organizationId: string;
  classification: DataClassification;
  reason: string;
}

export interface ChangeClassificationResult {
  organizationId: string;
  previousClassification: DataClassification;
  classification: DataClassification;
  classifiedProductionAt: string | null;
}

export async function changeSubscriberClassification(
  db: Kysely<Database>,
  input: ChangeClassificationInput,
  context: { actorUserId: string; actorPlatformRole: string; requestId?: string | null },
): Promise<ChangeClassificationResult> {
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 10) {
    throw new ClassificationBootstrapRefused(
      'reason_required',
      'Explain why this subscriber is being reclassified. The reason is recorded against the account permanently.',
    );
  }

  return db.transaction().execute(async (trx) => {
    /*
     * FOR UPDATE: the decision below is made from this row and acted on before
     * any other transaction can move the classification underneath it.
     */
    const organization = await trx
      .selectFrom('organizations')
      .select(['id', 'data_classification', 'legal_name'])
      .where('id', '=', input.organizationId)
      .forUpdate()
      .executeTakeFirst();

    if (!organization) {
      throw new ClassificationBootstrapRefused('not_found', 'No subscriber exists with this id.');
    }

    const previous = organization.data_classification;

    if (previous === input.classification) {
      throw new ClassificationBootstrapRefused(
        'unchanged',
        `This subscriber is already classified ${previous}.`,
      );
    }

    /*
     * The one-way rule. Restated here purely for the error message; the trigger
     * refuses this move regardless, including for any future caller that forgets
     * to ask.
     */
    if (previous === 'production') {
      throw new ClassificationBootstrapRefused('production_is_permanent', CLASSIFICATION_PERMANENT_MESSAGE);
    }

    await trx
      .updateTable('organizations')
      .set({
        data_classification: input.classification,
        classified_by: context.actorUserId,
        classification_reason: reason,
        // An explicit change is itself a review, so a reclassified account never
        // reappears in the reconciliation queue.
        classification_reviewed_at: new Date(),
        classification_reviewed_by: context.actorUserId,
      })
      .where('id', '=', input.organizationId)
      .execute();

    const updated = await trx
      .selectFrom('organizations')
      .select(['data_classification', 'classified_production_at'])
      .where('id', '=', input.organizationId)
      .executeTakeFirstOrThrow();

    await writeAuditLog(trx, {
      action: 'organization.classification_changed',
      actorUserId: context.actorUserId,
      actorPlatformRole: context.actorPlatformRole,
      organizationId: input.organizationId,
      targetType: 'organization',
      targetId: input.organizationId,
      requestId: context.requestId ?? null,
      /*
       * Both classifications, the actor and the reason. No credential, token or
       * session identifier ever appears here — an audit entry is read by more
       * people than the action it records.
       */
      metadata: {
        previousClassification: previous,
        newClassification: updated.data_classification,
        reason,
        legalName: organization.legal_name,
        irreversible: updated.data_classification === 'production',
        mechanism: 'admin_console',
      },
    });

    return {
      organizationId: input.organizationId,
      previousClassification: previous,
      classification: updated.data_classification,
      classifiedProductionAt: updated.classified_production_at
        ? new Date(updated.classified_production_at).toISOString()
        : null,
    };
  });
}

/* ══ Reconciling the migration's blanket default ═══════════════════════════ */

/**
 * What is known about whether a tenant was ever real.
 *
 * Shared by the console's reconciliation dialog, the endpoint that acts on it,
 * and the development CLI, so the UI and the CLI can never reach different
 * verdicts about the same organization — which is the failure mode that turns a
 * safety rule into a suggestion.
 *
 * Every field is read from the database. Nothing here is inferred from a name,
 * an email domain or a seeded id.
 */
export interface ClassificationEvidence {
  organizationId: string;
  legalName: string;
  ownerEmail: string | null;
  createdAt: string;
  organizationStatus: string;
  currentClassification: string;
  /** Null when the 008 default is the only thing that ever set it. */
  reviewedAt: string | null;
  everActivated: boolean;
  subscriptionCount: number;
  paidInvoiceCount: number;
  approvedProofCount: number;
  legalHold: boolean;
  platformOperatorMember: boolean;
  /** Plain sentences for the operator, in the order that matters. */
  findings: string[];
  /**
   * True when nothing in the record suggests this was ever a real customer.
   * Note that even then, this service will not make it disposable — see
   * `confirmSubscriberClassification`.
   */
  looksDisposable: boolean;
}

export async function gatherClassificationEvidence(
  db: Kysely<Database> | Transaction<Database>,
  organizationId: string,
): Promise<ClassificationEvidence | null> {
  const organization = await db
    .selectFrom('organizations')
    .select([
      'id',
      'legal_name',
      'status',
      'created_at',
      'data_classification',
      'legal_hold',
      'classification_reviewed_at',
    ])
    .where('id', '=', organizationId)
    .executeTakeFirst();

  if (!organization) return null;

  const owner = await db
    .selectFrom('organization_memberships')
    .innerJoin('users', 'users.id', 'organization_memberships.user_id')
    .select(['users.email', 'organization_memberships.role'])
    .where('organization_memberships.organization_id', '=', organizationId)
    .execute();

  const ownerEmail = owner.find((m) => m.role === 'owner')?.email ?? owner[0]?.email ?? null;

  const subscriptions = await db
    .selectFrom('subscriptions')
    .select('id')
    .where('organization_id', '=', organizationId)
    .execute();

  /*
   * A PAID invoice, not merely an issued one. An issued invoice proves somebody
   * pressed a button; a paid one is money having changed hands, which is the
   * strongest single signal that a tenant was real.
   */
  const paidInvoices = await db
    .selectFrom('subscription_invoices')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', organizationId)
    .where('status', '=', 'paid')
    .executeTakeFirst();

  const approvedProofs = await db
    .selectFrom('payment_proofs')
    .innerJoin('subscription_invoices', 'subscription_invoices.id', 'payment_proofs.invoice_id')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('subscription_invoices.organization_id', '=', organizationId)
    .where('payment_proofs.status', '=', 'approved')
    .executeTakeFirst();

  const platformMember = await db
    .selectFrom('organization_memberships')
    .innerJoin('platform_user_roles', 'platform_user_roles.user_id', 'organization_memberships.user_id')
    .select('platform_user_roles.role')
    .where('organization_memberships.organization_id', '=', organizationId)
    .executeTakeFirst();

  /*
   * The SAME signal the deletion gate uses, imported rather than recomputed. A
   * local reimplementation would eventually disagree with the service that
   * decides eligibility, and the reconciliation dialog would then describe a
   * tenant differently from the screen that acts on it.
   */
  const activated = await everActivated(db, organizationId);

  const subscriptionCount = subscriptions.length;
  const paidInvoiceCount = Number(paidInvoices?.n ?? 0);
  const approvedProofCount = Number(approvedProofs?.n ?? 0);
  const legalHold = organization.legal_hold;
  const platformOperatorMember = Boolean(platformMember);

  const findings: string[] = [];
  if (legalHold) findings.push('A legal hold is in force.');
  if (platformOperatorMember) findings.push('A platform administrator holds a membership here.');
  if (paidInvoiceCount > 0) findings.push(`${paidInvoiceCount} paid invoice(s) — money changed hands.`);
  if (approvedProofCount > 0) findings.push(`${approvedProofCount} approved payment proof(s).`);
  if (activated) {
    findings.push('The subscription was activated, so this tenant was permitted to keep accounting records.');
  }
  if (subscriptionCount > 0) findings.push(`${subscriptionCount} subscription record(s) in its history.`);
  if (findings.length === 0) findings.push('No billing, payment or activation history was found.');

  return {
    organizationId,
    legalName: organization.legal_name,
    ownerEmail,
    createdAt: new Date(organization.created_at).toISOString(),
    organizationStatus: organization.status,
    currentClassification: organization.data_classification,
    reviewedAt: organization.classification_reviewed_at
      ? new Date(organization.classification_reviewed_at).toISOString()
      : null,
    everActivated: activated,
    subscriptionCount,
    paidInvoiceCount,
    approvedProofCount,
    legalHold,
    platformOperatorMember,
    findings,
    looksDisposable:
      !legalHold &&
      !platformOperatorMember &&
      !activated &&
      paidInvoiceCount === 0 &&
      approvedProofCount === 0,
  };
}

/**
 * Confirm, as a human decision, that an unreviewed tenant really is production.
 *
 * ── What this can and cannot do ──────────────────────────────────────────────
 * It writes ONE outcome: reviewed-production. It cannot make anything
 * disposable, at any evidence level, for any operator. That is not an oversight
 * — it is the whole reason this can be an HTTP endpoint at all. The bootstrap
 * higher up this file moves data OUT of production protection and is therefore a
 * development-only CLI; this moves nothing, so a Super Admin can be trusted with
 * it without that implying an authority over retention they do not have.
 *
 * A caller asking for test/demo is refused with the evidence and a pointer to
 * the CLI, rather than being quietly given production — an operator who believes
 * they marked a tenant disposable must not walk away with the opposite result.
 */
export interface ConfirmClassificationInput {
  organizationId: string;
  /** Accepted so a demo/test request can be refused explicitly, not ignored. */
  classification: DataClassification;
  reason: string;
}

export interface ConfirmClassificationResult {
  organizationId: string;
  classification: DataClassification;
  reviewedAt: string;
  evidence: ClassificationEvidence;
}

export async function confirmSubscriberClassification(
  db: Kysely<Database>,
  input: ConfirmClassificationInput,
  context: { actorUserId: string; actorPlatformRole: string; requestId?: string | null },
): Promise<ConfirmClassificationResult> {
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 10) {
    throw new ClassificationBootstrapRefused(
      'reason_required',
      'Explain the basis for this classification. The reason is recorded against the account permanently.',
    );
  }

  return db.transaction().execute(async (trx) => {
    const organization = await trx
      .selectFrom('organizations')
      .select(['id', 'data_classification', 'classification_reviewed_at'])
      .where('id', '=', input.organizationId)
      .forUpdate()
      .executeTakeFirst();

    if (!organization) {
      throw new ClassificationBootstrapRefused('not_found', 'No subscriber exists with this id.');
    }

    /*
     * One-time. Re-running reconciliation over an account somebody already
     * reviewed would let a second operator overwrite the first one's recorded
     * decision without that showing as a change.
     */
    if (organization.classification_reviewed_at) {
      throw new ClassificationBootstrapRefused(
        'already_reviewed',
        'This subscriber has already been classified by an administrator. Use the Change classification action instead.',
      );
    }

    const evidence = await gatherClassificationEvidence(trx, input.organizationId);
    if (!evidence) {
      throw new ClassificationBootstrapRefused('not_found', 'No subscriber exists with this id.');
    }

    /*
     * The refusal. Note it does NOT depend on the evidence: reconciliation can
     * only ever confirm production. Ambiguity resolving to production is a
     * consequence of that, not a rule that has to be got right per-case.
     */
    if (input.classification !== 'production') {
      throw new ClassificationBootstrapRefused(
        'disposable_requires_cli',
        evidence.looksDisposable
          ? 'Reconciliation can only confirm a subscriber as Production. Marking an existing account disposable is a retention override and is available only through the development CLI, against a development database.'
          : `This subscriber cannot be marked disposable: ${evidence.findings.join(' ')} It must be classified Production.`,
      );
    }

    await trx
      .updateTable('organizations')
      .set({
        /*
         * data_classification is deliberately NOT written. The row is already
         * production; touching the column would fire the one-way trigger for no
         * reason and would misrepresent a review as a reclassification.
         */
        classification_reviewed_at: new Date(),
        classification_reviewed_by: context.actorUserId,
        classification_reason: reason,
      })
      .where('id', '=', input.organizationId)
      .execute();

    await writeAuditLog(trx, {
      action: 'organization.classification_reviewed',
      actorUserId: context.actorUserId,
      actorPlatformRole: context.actorPlatformRole,
      organizationId: input.organizationId,
      targetType: 'organization',
      targetId: input.organizationId,
      requestId: context.requestId ?? null,
      /* Evidence summary and reason. No credential, token or session id. */
      metadata: {
        classification: 'production',
        reason,
        legalName: evidence.legalName,
        evidence: {
          everActivated: evidence.everActivated,
          subscriptionCount: evidence.subscriptionCount,
          paidInvoiceCount: evidence.paidInvoiceCount,
          approvedProofCount: evidence.approvedProofCount,
          legalHold: evidence.legalHold,
          platformOperatorMember: evidence.platformOperatorMember,
          looksDisposable: evidence.looksDisposable,
        },
        mechanism: 'admin_console_reconciliation',
      },
    });

    const reviewedAt = new Date().toISOString();
    return {
      organizationId: input.organizationId,
      classification: 'production' as DataClassification,
      reviewedAt,
      evidence: { ...evidence, reviewedAt },
    };
  });
}
