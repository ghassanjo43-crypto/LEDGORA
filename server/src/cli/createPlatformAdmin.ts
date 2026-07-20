/**
 * Interactive first-administrator command — the NORMAL way to create a LEDGORA
 * platform administrator.
 *
 *   npm run create-platform-admin -- --email admin@example.com
 *
 * The password is read from the terminal with echo suppressed, confirmed, hashed
 * with Argon2id and discarded. It is never printed, never logged, never written
 * to a file, never placed in an environment variable and never committed.
 */
import { createInterface } from 'node:readline';
import { stdin, stdout, argv, exit } from 'node:process';
import { getConfig } from '../config/env.js';
import { createDatabase } from '../db/index.js';
import { assertMigrationsSucceeded, migrateToLatest } from '../db/migrator.js';
import { checkPasswordPolicy, hashPassword } from '../lib/password.js';
import { assignPlatformRole, createUser, findUserByEmail, normaliseEmail } from '../services/userService.js';
import { writeAuditLog } from '../lib/audit.js';
import { z } from 'zod';

function parseArgs(args: string[]): { email?: string; force: boolean } {
  const out: { email?: string; force: boolean } = { force: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--email') out.email = args[i + 1];
    else if (arg?.startsWith('--email=')) out.email = arg.slice('--email='.length);
    else if (arg === '--force') out.force = true;
  }
  return out;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

/** Read a line without echoing it to the terminal. */
function askSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.write(question);
    const isTTY = Boolean(stdin.isTTY);
    if (!isTTY) {
      reject(new Error('A terminal is required to enter a password. Use the bootstrap variables for non-interactive deployment.'));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '') { // Ctrl-C
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(argv.slice(2));

  const emailResult = z.string().email().safeParse(args.email ?? (await ask('Email: ')));
  if (!emailResult.success) {
    console.error('A valid --email is required.');
    exit(1);
  }
  const email = emailResult.data;

  const config = getConfig();
  const db = await createDatabase({ databaseUrl: config.DATABASE_URL, isProduction: config.isProduction });
  assertMigrationsSucceeded(await migrateToLatest(db));

  try {
    const existing = await findUserByEmail(db, email);

    if (existing && !args.force) {
      // Never silently reset an existing administrator's password.
      console.error(
        `A user already exists for ${normaliseEmail(email)}.\n` +
          'Re-run with --force to set a new password for that account (this is audited).',
      );
      exit(1);
    }

    const fullName = existing?.full_name ?? (await ask('Full name: '));
    if (!fullName) {
      console.error('Full name is required.');
      exit(1);
    }

    const password = await askSecret('Password (input hidden): ');
    const confirmation = await askSecret('Confirm password: ');
    if (password !== confirmation) {
      console.error('Passwords do not match.');
      exit(1);
    }

    const policy = checkPasswordPolicy(password, { email, fullName });
    if (!policy.ok) {
      console.error(`Password rejected:\n${policy.problems.map((p) => `  - ${p}`).join('\n')}`);
      exit(1);
    }

    const userId = await db.transaction().execute(async (trx) => {
      let id: string;
      if (existing) {
        await trx
          .updateTable('users')
          .set({
            password_hash: await hashPassword(password),
            full_name: fullName,
            status: 'active',
            // The operator chose this password interactively, so no forced change.
            must_change_password: false,
            failed_login_count: 0,
            locked_until: null,
            updated_at: new Date(),
          })
          .where('id', '=', existing.id)
          .execute();
        id = existing.id;
      } else {
        const created = await createUser(trx, {
          email,
          password,
          fullName,
          status: 'active',
          emailVerified: true,
          mustChangePassword: false,
        });
        id = created.id;
      }

      await assignPlatformRole(trx, id, 'super_admin', { actorUserId: id });
      await writeAuditLog(trx, {
        actorUserId: id,
        actorPlatformRole: 'super_admin',
        action: 'admin.created',
        targetType: 'user',
        targetId: id,
        // The password is not referenced here in any form.
        metadata: { email: normaliseEmail(email), method: 'cli', replacedExisting: Boolean(existing) },
      });
      return id;
    });

    console.info(`\nSuper administrator ready: ${normaliseEmail(email)} (user ${userId}).`);
    console.info('Sign in through the LEDGORA frontend. The password was not stored or displayed anywhere.');
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
});
