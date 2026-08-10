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
  const organization = await db
    .selectFrom('organizations')
    .select(['legal_name', 'legal_hold', 'data_classification'])
    .where('id', '=', organizationId)
    .executeTakeFirst();

  if (!organization) return null;

  const blockers: string[] = [];

  if (organization.legal_hold) {
    blockers.push('A legal hold is in force. It must be lifted by the process that placed it.');
  }

  /*
   * A platform operator's identity is reachable from this tenant. Making the
   * tenant disposable puts that identity within reach of a cascade.
   */
  const platformMember = await db
    .selectFrom('organization_memberships')
    .innerJoin('platform_user_roles', 'platform_user_roles.user_id', 'organization_memberships.user_id')
    .select('platform_user_roles.role')
    .where('organization_memberships.organization_id', '=', organizationId)
    .executeTakeFirst();

  if (platformMember) {
    blockers.push('A platform administrator holds a membership here.');
  }

  return {
    legalName: organization.legal_name,
    currentClassification: organization.data_classification,
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
