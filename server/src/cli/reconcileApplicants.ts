/**
 * Applicant reconciliation CLI.
 *
 *   npm run db:reconcile-applicants
 *
 * Creates the onboarding record for any registered customer that is missing
 * one. Idempotent: running it again when nothing is missing reports 0 and
 * changes nothing. Migration `003` already runs this once — the CLI exists so an
 * operator can repair the roster at any time without a deployment.
 */
import { exit } from 'node:process';
import { getConfig } from '../config/env.js';
import { createDatabase } from '../db/index.js';
import { reconcileApplications } from '../services/applicantService.js';

async function main(): Promise<void> {
  const config = getConfig();
  const db = await createDatabase({ databaseUrl: config.DATABASE_URL, isProduction: config.isProduction });

  try {
    const { created } = await reconcileApplications(db);
    console.info(
      created === 0
        ? 'Every registered customer already has an applicant record.'
        : `Created ${created} missing applicant record${created === 1 ? '' : 's'}.`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
});
