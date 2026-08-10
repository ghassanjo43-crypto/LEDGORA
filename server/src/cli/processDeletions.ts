/**
 * Carry out due subscriber deletions.
 *
 * ── Why this is a CLI and not a timer ────────────────────────────────────────
 * This repository has no job runner. A `setInterval` inside the API process
 * would look like automation and behave like a liability: it dies with the
 * process, runs once per instance if the service is scaled, and would carry out
 * irreversible deletions with nobody watching and no record of the schedule
 * having fired.
 *
 * So the run is EXPLICIT. Point a cron entry, a Render scheduled job or an
 * operator at this command:
 *
 *     npm run db:process-deletions            # carry out every due purge
 *     npm run db:process-deletions -- --dry   # list what is due, change nothing
 *
 * Every subscriber is re-assessed at the moment of the run, so a request made 30
 * days ago is permission to try, never permission to proceed regardless.
 */
import { loadConfig } from '../config/env.js';
import { createDatabase } from '../db/index.js';
import { listDueDeletions, processDueDeletions } from '../services/subscriberClosureService.js';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry') || process.argv.includes('--dry-run');
  const config = loadConfig(process.env);
  const db = await createDatabase({ databaseUrl: config.DATABASE_URL, isProduction: config.isProduction });

  try {
    const due = await listDueDeletions(db);
    if (due.length === 0) {
      console.log('No subscriber deletions are due.');
      return;
    }

    console.log(`${due.length} subscriber deletion(s) due:`);
    for (const item of due) {
      console.log(`  · ${item.legalName} (${item.organizationId}) — requested ${item.requestedAt}`);
    }

    if (dryRun) {
      console.log('\nDry run: nothing was changed.');
      return;
    }

    const result = await processDueDeletions(db, {
      /*
       * No operator is present, so the acting user is null and the audit trail
       * says so. The requesting operator is already recorded on the original
       * `subscriber.deletion_requested` entry — attributing the scheduled run to
       * them would claim they were here when they were not.
       */
      actorUserId: null as unknown as string,
      actorPlatformRole: 'system:scheduled_deletion',
      requestId: `cli-${Date.now()}`,
    });

    console.log(
      `\nProcessed ${result.considered}: ${result.purged} purged, ${result.blocked} blocked, ${result.failed} failed.`,
    );
    for (const item of result.results) {
      if (item.outcome === 'purged') continue;
      const detail = item.blockedBy?.join(', ') ?? item.error ?? '';
      console.log(`  · ${item.legalName}: ${item.outcome}${detail ? ` — ${detail}` : ''}`);
    }

    // A failure is an operational event and must not exit 0.
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error('process-deletions failed:', error);
  process.exit(1);
});
