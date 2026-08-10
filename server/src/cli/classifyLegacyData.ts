/**
 * Development-only legacy data classification.
 *
 *   npm run db:classify-legacy -- --preview <id> [<id>…]
 *   npm run db:classify-legacy -- --apply --as test --reason "…" --confirm "RECLASSIFY DEVELOPMENT DATA" <id> [<id>…]
 *
 * Marks named EXISTING organizations as test or demo data so a development
 * database can be cleaned up. Migration `008` classifies everything
 * `production` — the only safe default — and a database trigger then refuses
 * every move away from it. This is the sole, deliberately narrow exception.
 *
 * Refused outright in production, and additionally requires
 * ALLOW_LEGACY_DATA_CLASSIFICATION=true. See `services/classificationService`
 * for why this is a CLI and not an HTTP route.
 *
 * `--preview` is the default: `--apply` must be asked for explicitly, so a
 * half-typed command inspects rather than mutates.
 */
import { argv, exit } from 'node:process';
import { getConfig } from '../config/env.js';
import { createDatabase } from '../db/index.js';
import type { DataClassification } from '../db/schema.js';
import {
  applyLegacyClassification,
  previewLegacyClassification,
  ClassificationBootstrapRefused,
} from '../services/classificationService.js';

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const args = argv.slice(2);
  const apply = args.includes('--apply');
  const organizationIds = args.filter((a) => !a.startsWith('--') && /^[0-9a-f-]{36}$/i.test(a));

  const target = (flag('as') ?? 'test') as DataClassification;

  const config = getConfig();
  const db = await createDatabase({ databaseUrl: config.DATABASE_URL, isProduction: config.isProduction });

  try {
    const preview = await previewLegacyClassification(db, {
      organizationIds,
      targetClassification: target,
    });

    console.info(`\nOperation ${preview.operationId} — reclassify as ${preview.targetClassification}\n`);
    for (const candidate of preview.candidates) {
      const verdict = candidate.blockers.length === 0 ? 'ELIGIBLE' : `BLOCKED: ${candidate.blockers.join(' ')}`;
      console.info(`  ${candidate.organizationId}  ${candidate.legalName}  [${candidate.currentClassification}]  ${verdict}`);
    }
    console.info(`\n${preview.eligibleCount} eligible, ${preview.blockedCount} blocked.\n`);

    if (!apply) {
      console.info('Preview only. Nothing was changed. Re-run with --apply to proceed.');
      return;
    }

    const result = await applyLegacyClassification(db, {
      organizationIds,
      targetClassification: target,
      actorUserId: flag('actor') ?? null,
      reason: flag('reason') ?? '',
      confirmation: flag('confirm') ?? '',
    });

    if (result.refused.length > 0) {
      console.error('Refused — nothing was changed. Resolve the blockers above first.');
      exit(1);
    }

    console.info(`Reclassified ${result.reclassified.length} organization(s). Operation ${result.operationId}.`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ClassificationBootstrapRefused) {
    console.error(`Refused (${error.code}): ${error.message}`);
    exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
});
