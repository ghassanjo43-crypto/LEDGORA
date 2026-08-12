/**
 * DEVELOPMENT-ONLY local subscriber-data reset.
 *
 *   npm run dev:reset-subscribers                      # preview only (default)
 *   npm run dev:reset-subscribers -- --apply \
 *     --expect-database ledgora_local \
 *     --confirm "RESET LOCAL LEDGORA SUBSCRIBER DATA"
 *
 * Empties a LOCAL database of every customer/subscriber row so development can
 * start from subscriber #1, preserving platform operators, the plan catalogue,
 * reference data, migrations and schema.
 *
 * ── Why this is a CLI and never an HTTP route ────────────────────────────────
 * An endpoint is reachable by anything holding a session — a stolen cookie, a
 * CSRF-confused browser, a misconfigured proxy, an operator on the wrong
 * environment. This operation has no eligibility gate to fall back on, so
 * reachability itself is the risk. A CLI requires shell access to the machine
 * running the database, which is exactly the population allowed to do this.
 * `devReset.test.ts` fails if the service is ever imported by the HTTP layer.
 *
 * ── Preview is the default ───────────────────────────────────────────────────
 * `--apply` must be asked for explicitly, so a half-typed command inspects
 * rather than destroys.
 */
import { argv, exit } from 'node:process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config/env.js';
import { createDatabase } from '../db/index.js';
import {
  DevResetRefused,
  RESET_CONFIRMATION,
  assertLocalDevelopmentTarget,
  executeReset,
  previewReset,
  type ResetPreview,
} from '../services/devResetService.js';

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function line(label: string, value: string | number): void {
  console.info(`  ${label.padEnd(38)} ${value}`);
}

function renderPreview(preview: ResetPreview): void {
  console.info('\n══════════════════════════════════════════════════════════════');
  console.info('  LOCAL LEDGORA SUBSCRIBER DATA RESET — PREVIEW');
  console.info('══════════════════════════════════════════════════════════════\n');

  // Host, port and database only. The password is never read out of the URL.
  console.info('Database:');
  line('host', preview.target.host);
  line('port', preview.target.port);
  line('database', preview.target.database);

  console.info('\nPreserved:');
  line(`${preview.preservedAdmins.length} platform operator(s)`, '');
  for (const admin of preview.preservedAdmins) {
    console.info(`      · ${admin.email}  (${admin.fullName})  [${admin.roles.join(', ')}]`);
  }
  for (const reference of preview.preservedReferenceRows) {
    line(reference.table, `${reference.rows} row(s)`);
  }

  console.info('\nWill DELETE:');
  for (const count of preview.counts) {
    if (count.action === 'preserve' || count.willDelete === 0) continue;
    line(count.label, `${count.willDelete}`);
  }

  const untouched = preview.counts.filter((c) => c.action !== 'preserve' && c.willDelete === 0);
  if (untouched.length > 0) {
    console.info('\nAlready empty:');
    console.info(`  ${untouched.map((c) => c.table).join(', ')}`);
  }

  if (preview.preservedAdminMembershipsRemoved > 0) {
    console.info(
      `\nNote: ${preview.preservedAdminMembershipsRemoved} membership(s) held by PRESERVED operators go with their tenant.` +
        '\n      The accounts themselves survive; no operator is added to any organization.',
    );
  }

  if (preview.storageKeys.length > 0) {
    console.info(`\nStored proof files to remove: ${preview.storageKeys.length}`);
    for (const key of preview.storageKeys) console.info(`      · ${key}`);
  }

  console.info(
    `\nRemaining afterwards: 0 organizations, 0 applicants, ` +
      `${preview.counts.find((c) => c.table === 'users')?.willRemain ?? '?'} user(s) (platform operators only).`,
  );
}

async function main(): Promise<void> {
  const apply = argv.includes('--apply');
  const config = getConfig();

  const guard = {
    nodeEnv: config.NODE_ENV,
    isProduction: config.isProduction,
    databaseUrl: config.DATABASE_URL,
    expectedDatabase: flag('expect-database'),
  };

  /* Checked BEFORE a connection is opened: a refused target is never dialled. */
  const target = assertLocalDevelopmentTarget(guard);

  const db = await createDatabase({ databaseUrl: config.DATABASE_URL, isProduction: config.isProduction });

  try {
    const preview = await previewReset(db, target);
    renderPreview(preview);

    if (!apply) {
      console.info('\nPreview only — NOTHING was changed.');
      console.info('To execute, re-run with:');
      console.info(`  --apply --expect-database ${target.database} --confirm "${RESET_CONFIRMATION}"\n`);
      return;
    }

    const result = await executeReset(db, { confirmation: flag('confirm') ?? '', guard });

    console.info('\n══════════════════════════════════════════════════════════════');
    console.info('  RESET EXECUTED');
    console.info('══════════════════════════════════════════════════════════════\n');
    console.info('Deleted:');
    for (const [table, n] of Object.entries(result.deleted)) if (n > 0) line(table, n);

    console.info('\nRemaining:');
    for (const [table, n] of Object.entries(result.remaining)) line(table, n);

    console.info('\nPreserved operators:');
    for (const admin of result.preservedAdmins) console.info(`      · ${admin.email} [${admin.roles.join(', ')}]`);

    /*
     * Files come AFTER the commit, never before. Deleting an object whose row
     * then survives a rolled-back transaction is unrecoverable; a file left
     * behind by a committed delete is merely untidy and is removed here.
     */
    const uploadDirectory = path.resolve(config.UPLOAD_DIRECTORY);
    let removedFiles = 0;
    for (const key of result.storageKeys) {
      // Resolve and re-check: only paths INSIDE the upload directory are touched,
      // so a malformed key can never reach application source.
      const resolved = path.resolve(uploadDirectory, key);
      if (resolved !== uploadDirectory && !resolved.startsWith(uploadDirectory + path.sep)) {
        console.warn(`      ! skipped (outside upload directory): ${key}`);
        continue;
      }
      await rm(resolved, { force: true });
      removedFiles += 1;
    }
    console.info(`\nStored files removed: ${removedFiles} (from ${uploadDirectory})`);

    console.info(
      '\nBrowser accounting workspaces are NOT touched by this command.' +
        '\nThey live in each browser under `ledgora:ws:*` and must be cleared per browser.\n',
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  if (error instanceof DevResetRefused) {
    console.error(`\nREFUSED (${error.code})\n${error.message}\n`);
    exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
});
