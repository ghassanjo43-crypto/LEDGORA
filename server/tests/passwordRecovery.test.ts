/**
 * Self-service password recovery, end to end.
 *
 * The claims this suite proves:
 *
 *   non-enumeration  a known address, an unknown address, a disabled account and
 *                    a mail provider that refuses all produce the SAME status,
 *                    the SAME body and the same absence of any other signal;
 *   reuse            the link is a row in the EXISTING `password_reset_tokens`
 *                    table, redeemed by the EXISTING `/api/auth/reset-password`
 *                    — there is no second reset system;
 *   secrecy          the raw token reaches the email body and nothing else: not
 *                    the response, not the audit trail, not a log line, and not
 *                    the database, which holds only its SHA-256 digest;
 *   single use       expired, already-used and superseded links are all refused,
 *                    and a redemption ends every live session;
 *   configuration    the Resend variables the Render service carries select the
 *                    Resend transport, the key is never described anywhere, and
 *                    a deployment with no provider still behaves safely.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  authHeaders,
  createTestContext,
  login,
  readCookies,
  seedUser,
  TEST_PASSWORD,
  type TestContext,
} from './helpers/testApp.js';
import {
  HttpMailer,
  RESEND_ENDPOINT,
  UnavailableMailer,
  createMailer,
  resolveMailTransport,
  type MailMessage,
  type MailResult,
  type Mailer,
} from '../src/mail/mailer.js';
import { renderPasswordResetEmail, renderPasswordChangedEmail, describeExpiry } from '../src/mail/passwordEmails.js';
import { describeConfig, loadConfig } from '../src/config/env.js';
import { hashToken } from '../src/lib/tokens.js';

const APP_URL = 'https://ledgora-frontend.example.test';
const NEW_PASSWORD = 'Bright-Harbour-58-Zq';

/** Records what it was asked to send, and answers however the test wants. */
class RecordingMailer implements Mailer {
  readonly name = 'recording';
  readonly sent: MailMessage[] = [];
  constructor(private readonly result: MailResult = { delivery: 'sent', messageId: 'msg_1' }) {}
  async send(message: MailMessage): Promise<MailResult> {
    this.sent.push(message);
    return this.result;
  }
}

let ctx: TestContext;
let mailer: RecordingMailer;

async function boot(result?: MailResult, overrides: Record<string, string> = {}): Promise<void> {
  mailer = new RecordingMailer(result);
  ctx = await createTestContext(
    {
      APP_PUBLIC_URL: APP_URL,
      // The endpoint has a deliberately tight budget of its own; raise it here so
      // an ordinary test is not throttled by an earlier one. The limit itself has
      // its own test below, with its own context.
      FORGOT_PASSWORD_RATE_LIMIT_MAX: '50',
      ...overrides,
    },
    { mailer },
  );
}

afterEach(async () => {
  await ctx?.close();
  vi.restoreAllMocks();
});

const forgot = (email: string) =>
  ctx.app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email } });

const redeem = (token: string, newPassword = NEW_PASSWORD) =>
  ctx.app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, newPassword } });

/** The reset link out of the message that was actually sent. */
function linkFrom(message: MailMessage): string {
  const match = /(https?:\/\/\S*?set-password\?token=[^"\s<]+)/.exec(message.text);
  if (!match) throw new Error('the message carries no reset link');
  return match[1]!;
}

function tokenFrom(message: MailMessage): string {
  return decodeURIComponent(new URL(linkFrom(message)).searchParams.get('token') ?? '');
}

/* ══ The rendered message ════════════════════════════════════════════════ */

describe('the password reset email', () => {
  it('carries the branding, one link and the expiry — and no credential', () => {
    const rendered = renderPasswordResetEmail({
      resetUrl: `${APP_URL}/set-password?token=abc`,
      ttlMinutes: 30,
    });

    expect(rendered.subject).toBe('Reset your Ledgora password');
    for (const fragment of ['LEDGORA', 'A password reset was requested', '30 minutes']) {
      expect(rendered.html).toContain(fragment);
      expect(rendered.text).toContain(fragment);
    }
    // Exactly one link, in each part.
    expect(rendered.html.match(/set-password\?token=/g)).toHaveLength(1);
    expect(rendered.text.match(/set-password\?token=/g)).toHaveLength(1);
    expect(rendered.text).toMatch(/if you did not request this/i);
    // Nothing that looks like a credential other than the link itself.
    expect(rendered.html).not.toMatch(/temporary password|current password|password hash/i);
  });

  it('states the expiry in units a person reads', () => {
    expect(describeExpiry(1)).toBe('1 minute');
    expect(describeExpiry(30)).toBe('30 minutes');
    expect(describeExpiry(60)).toBe('1 hour');
    expect(describeExpiry(60 * 24 * 3)).toBe('3 days');
  });

  it('renders a change notice that carries no link to act on', () => {
    const rendered = renderPasswordChangedEmail({ signInUrl: `${APP_URL}/login` });
    expect(rendered.subject).toBe('Your Ledgora password was changed');
    expect(rendered.text).toContain('Your password was changed successfully.');
    expect(rendered.text).toMatch(/contact support immediately/i);
    // A sign-in page is not a credential; a token would be.
    expect(rendered.html).not.toContain('token=');
  });
});

/* ══ The request ═════════════════════════════════════════════════════════ */

describe('requesting a reset', () => {
  it('creates a reset token and mails the link to the right address', async () => {
    await boot();
    await seedUser(ctx, { email: 'ada@newco.test', fullName: 'Ada Lovelace' });

    const response = await forgot('ada@newco.test');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      message: 'If an account exists for that address, reset instructions have been sent.',
    });

    // A row in the EXISTING table, with the existing purpose vocabulary.
    const rows = await ctx.db.selectFrom('password_reset_tokens').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.purpose).toBe('reset');
    expect(rows[0]!.used_at).toBeNull();
    expect(rows[0]!.issued_by_user_id).toBeNull();

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('ada@newco.test');
    expect(mailer.sent[0]!.template).toBe('password.reset');
  });

  it('builds the link from APP_PUBLIC_URL, not from the CORS allow-list', async () => {
    await boot(undefined, { FRONTEND_URL: 'http://localhost:5173,https://staging.example.test' });
    await seedUser(ctx, { email: 'ada@newco.test' });

    await forgot('ada@newco.test');
    const link = linkFrom(mailer.sent[0]!);
    expect(link.startsWith(`${APP_URL}/set-password?token=`)).toBe(true);
    expect(mailer.sent[0]!.html).toContain(APP_URL);
    expect(mailer.sent[0]!.html).not.toContain('localhost:5173');
  });

  it('stores only the digest, and puts the raw token nowhere else', async () => {
    await boot();
    await seedUser(ctx, { email: 'ada@newco.test' });
    const response = await forgot('ada@newco.test');
    const token = tokenFrom(mailer.sent[0]!);

    expect(token.length).toBeGreaterThan(20);

    const rows = await ctx.db.selectFrom('password_reset_tokens').selectAll().execute();
    // What is stored is the hash and nothing that can be replayed.
    expect(rows[0]!.token_hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(token);

    // Not in the response...
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain('set-password?token=');
    // ...and not in the audit trail, which records the fact and the window only.
    const audits = await ctx.db.selectFrom('audit_logs').selectAll().execute();
    const requested = audits.filter((a) => a.action === 'auth.password_reset_requested');
    expect(requested).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(JSON.stringify(audits)).not.toContain('set-password?token=');
  });

  it('never writes the token to a log line, even when delivery fails', async () => {
    await boot({ delivery: 'failed', error: 'Mail provider responded 500.' });
    await seedUser(ctx, { email: 'ada@newco.test' });

    const warn = vi.spyOn(ctx.app.log, 'warn');
    const error = vi.spyOn(ctx.app.log, 'error');
    const info = vi.spyOn(ctx.app.log, 'info');

    await forgot('ada@newco.test');
    const token = tokenFrom(mailer.sent[0]!);

    // The failure IS reported server-side — an operator must be able to see that
    // recovery is broken — but with the reason only.
    expect(warn).toHaveBeenCalled();
    const written = JSON.stringify([warn.mock.calls, error.mock.calls, info.mock.calls]);
    expect(written).not.toContain(token);
    expect(written).not.toContain('set-password?token=');
    expect(written).toContain('password reset email was not delivered');
  });

  it('supersedes an earlier link rather than stacking valid ones', async () => {
    await boot();
    await seedUser(ctx, { email: 'ada@newco.test' });

    await forgot('ada@newco.test');
    const first = tokenFrom(mailer.sent[0]!);
    await forgot('ada@newco.test');
    const second = tokenFrom(mailer.sent[1]!);
    expect(second).not.toBe(first);

    expect((await redeem(first)).statusCode).toBe(400);
    expect((await redeem(second)).statusCode).toBe(200);
  });
});

/* ══ Non-enumeration ═════════════════════════════════════════════════════ */

describe('what the endpoint refuses to reveal', () => {
  it('answers an unknown address exactly as a known one, and sends nothing', async () => {
    await boot();
    await seedUser(ctx, { email: 'ada@newco.test' });

    const known = await forgot('ada@newco.test');
    const unknown = await forgot('nobody@nowhere.test');

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);

    // Exactly one message — the known address's.
    expect(mailer.sent.map((m) => m.to)).toEqual(['ada@newco.test']);
    // And nothing was written for the address that does not exist: an audit row
    // per unknown address would be the oracle the identical body denies.
    const rows = await ctx.db.selectFrom('password_reset_tokens').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('answers a disabled account the same way, and issues no link it could not use', async () => {
    await boot();
    await seedUser(ctx, { email: 'gone@newco.test', status: 'disabled' });

    const response = await forgot('gone@newco.test');
    expect(response.statusCode).toBe(200);
    expect(response.json().message).toBe(
      'If an account exists for that address, reset instructions have been sent.',
    );
    expect(mailer.sent).toHaveLength(0);
    expect(await ctx.db.selectFrom('password_reset_tokens').selectAll().execute()).toHaveLength(0);
  });

  it('answers identically when the provider refuses the message', async () => {
    await boot({ delivery: 'failed', error: 'Mail provider responded 422.' });
    await seedUser(ctx, { email: 'ada@newco.test' });

    const failed = await forgot('ada@newco.test');
    const unknown = await forgot('nobody@nowhere.test');

    expect(failed.statusCode).toBe(200);
    expect(failed.body).toBe(unknown.body);
    // Nothing in the response hints that a send was even attempted.
    expect(failed.body).not.toMatch(/fail|error|provider/i);
  });

  it('answers identically when a provider throws instead of returning', async () => {
    const throwing: Mailer = {
      name: 'throwing',
      async send() {
        throw new Error('ECONNRESET');
      },
    };
    ctx = await createTestContext(
      { APP_PUBLIC_URL: APP_URL, FORGOT_PASSWORD_RATE_LIMIT_MAX: '50' },
      { mailer: throwing },
    );
    await seedUser(ctx, { email: 'ada@newco.test' });

    // A 500 here would answer the question the 200 refuses to.
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: 'ada@newco.test' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });

  it('answers identically when no mail provider is configured at all', async () => {
    // The default transport reports `unavailable`; nothing may claim delivery.
    ctx = await createTestContext({ APP_PUBLIC_URL: APP_URL, FORGOT_PASSWORD_RATE_LIMIT_MAX: '50' });
    await seedUser(ctx, { email: 'ada@newco.test' });

    const response = await forgot('ada@newco.test');
    expect(response.statusCode).toBe(200);
    expect(response.json().message).toBe(
      'If an account exists for that address, reset instructions have been sent.',
    );
    // The token still exists, so an operator can still issue the link by hand.
    expect(await ctx.db.selectFrom('password_reset_tokens').selectAll().execute()).toHaveLength(1);
  });

  it('issues no session', async () => {
    await boot();
    await seedUser(ctx, { email: 'ada@newco.test' });
    const response = await forgot('ada@newco.test');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('is rate limited more tightly than login', async () => {
    await boot(undefined, { FORGOT_PASSWORD_RATE_LIMIT_MAX: '2' });
    await seedUser(ctx, { email: 'ada@newco.test' });

    expect((await forgot('ada@newco.test')).statusCode).toBe(200);
    expect((await forgot('ada@newco.test')).statusCode).toBe(200);
    expect((await forgot('ada@newco.test')).statusCode).toBe(429);
    // Login, on its far larger budget, is untouched.
    expect((await forgot('nobody@nowhere.test')).statusCode).toBe(429);
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'ada@newco.test', password: TEST_PASSWORD },
      })).statusCode,
    ).toBe(200);
  });
});

/* ══ Redemption ══════════════════════════════════════════════════════════ */

describe('using the emailed link', () => {
  it('lets the account holder choose a new password and sign in with it', async () => {
    await boot();
    await seedUser(ctx, { email: 'ada@newco.test', fullName: 'Ada Lovelace' });
    await forgot('ada@newco.test');
    const token = tokenFrom(mailer.sent[0]!);

    // The page inspects the link before rendering — masked address only.
    const inspected = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/invitation/inspect',
      payload: { token },
    });
    expect(inspected.json()).toMatchObject({ valid: true, purpose: 'reset', maskedEmail: 'a**@newco.test' });
    expect(inspected.body).not.toContain('ada@newco.test');

    const redeemed = await redeem(token);
    expect(redeemed.statusCode).toBe(200);
    // No session is issued by redemption; the person signs in afterwards.
    expect(redeemed.headers['set-cookie']).toBeUndefined();

    const signedIn = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ada@newco.test', password: NEW_PASSWORD },
    });
    expect(signedIn.statusCode).toBe(200);
    // The old password no longer works.
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'ada@newco.test', password: TEST_PASSWORD },
      })).statusCode,
    ).toBe(401);
  });

  it('is single use', async () => {
    await boot();
    await seedUser(ctx, { email: 'ada@newco.test' });
    await forgot('ada@newco.test');
    const token = tokenFrom(mailer.sent[0]!);

    expect((await redeem(token)).statusCode).toBe(200);
    const second = await redeem(token, 'Second-Attempt-77-Xy');
    expect(second.statusCode).toBe(400);
    // The same refusal an invented token gets — nothing distinguishes them.
    expect(second.json().error.message).toBe((await redeem('invented'.repeat(4))).json().error.message);
  });

  it('refuses an expired link', async () => {
    await boot();
    const user = await seedUser(ctx, { email: 'ada@newco.test' });
    // A token minted in the existing shape, already past its window.
    const stale = 'stale-token-value-with-enough-length';
    await ctx.db
      .insertInto('password_reset_tokens')
      .values({
        user_id: user.id,
        token_hash: hashToken(stale),
        expires_at: new Date(Date.now() - 60_000),
        purpose: 'reset',
      })
      .execute();

    expect((await redeem(stale)).statusCode).toBe(400);
    const inspected = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/invitation/inspect',
      payload: { token: stale },
    });
    expect(inspected.json()).toEqual({ valid: false, purpose: null, maskedEmail: null, expiresAt: null });
  });

  it('ends every session the previous password had opened', async () => {
    await boot();
    await seedUser(ctx, { email: 'ada@newco.test' });
    const cookies = await login(ctx, 'ada@newco.test');
    // The session works before the reset.
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/auth/session', headers: authHeaders(cookies) })).json()
        .authenticated,
    ).toBe(true);

    await forgot('ada@newco.test');
    await redeem(tokenFrom(mailer.sent[0]!));

    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/auth/session', headers: authHeaders(cookies) })).json()
        .authenticated,
    ).toBe(false);
  });

  it('returns no token, hash or credential in its response', async () => {
    await boot();
    await seedUser(ctx, { email: 'ada@newco.test' });
    await forgot('ada@newco.test');
    const token = tokenFrom(mailer.sent[0]!);

    const response = await redeem(token);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['email', 'message', 'ok', 'purpose']);
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain(hashToken(token));
    expect(response.body).not.toContain(NEW_PASSWORD);
  });

  it('sends the security notice after a reset, but never blocks on it', async () => {
    await boot({ delivery: 'failed', error: 'Mail provider responded 500.' });
    await seedUser(ctx, { email: 'ada@newco.test' });
    await forgot('ada@newco.test');

    // The notice fails to send, and the password change still succeeds.
    const redeemed = await redeem(tokenFrom(mailer.sent[0]!));
    expect(redeemed.statusCode).toBe(200);

    const notice = mailer.sent.find((m) => m.template === 'password.changed');
    expect(notice?.to).toBe('ada@newco.test');
    expect(notice?.text).toContain('Your password was changed successfully.');
    expect(notice?.text).not.toContain('token=');
  });

  it('notifies after a self-service change too, without failing it', async () => {
    await boot({ delivery: 'failed' });
    await seedUser(ctx, { email: 'ada@newco.test' });
    const cookies = await login(ctx, 'ada@newco.test');

    const changed = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders(cookies),
      payload: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(changed.statusCode).toBe(200);
    expect(mailer.sent.map((m) => m.template)).toEqual(['password.changed']);
  });

  it('does not send a change notice when an invitation is first redeemed', async () => {
    // The recipient has just been through a mail round-trip to get here; a
    // "your password was changed" would be noise, not a security signal.
    await boot();
    const user = await seedUser(ctx, { email: 'invited@newco.test' });
    const raw = 'invitation-token-value-with-length';
    await ctx.db
      .insertInto('password_reset_tokens')
      .values({
        user_id: user.id,
        token_hash: hashToken(raw),
        expires_at: new Date(Date.now() + 600_000),
        purpose: 'invitation',
      })
      .execute();

    expect((await redeem(raw)).statusCode).toBe(200);
    expect(mailer.sent).toHaveLength(0);
  });
});

/* ══ Configuration ═══════════════════════════════════════════════════════ */

describe('the Resend configuration', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://x/y',
    SESSION_SECRET: 'a-strong-random-production-secret',
  } as NodeJS.ProcessEnv;

  it('selects the Resend endpoint from RESEND_API_KEY alone', () => {
    const resolved = resolveMailTransport({
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM: 'Ledgora <accounts@expertsgroup.me>',
    });
    expect(resolved.transport).toEqual({
      endpoint: RESEND_ENDPOINT,
      apiKey: 're_test_key',
      from: 'Ledgora <accounts@expertsgroup.me>',
    });
    expect(
      createMailer({ RESEND_API_KEY: 're_k', EMAIL_FROM: 'a@b.test', isProduction: true, isTest: false }),
    ).toBeInstanceOf(HttpMailer);
  });

  it('lets an explicit MAIL_* value override the Resend defaults', () => {
    const resolved = resolveMailTransport({
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM: 'a@b.test',
      MAIL_PROVIDER_URL: 'https://compatible.test/send',
      MAIL_FROM: 'ops@ledgora.test',
    });
    expect(resolved.transport).toEqual({
      endpoint: 'https://compatible.test/send',
      apiKey: 're_test_key',
      from: 'ops@ledgora.test',
    });
  });

  it('accepts a display-name sender, which a bare email check would refuse', () => {
    const config = loadConfig({
      ...base,
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM: 'Ledgora <accounts@expertsgroup.me>',
      APP_PUBLIC_URL: 'https://ledgora-frontend.onrender.com',
    });
    expect(config.EMAIL_FROM).toBe('Ledgora <accounts@expertsgroup.me>');
    expect(config.appPublicUrl).toBe('https://ledgora-frontend.onrender.com');
  });

  it('refuses a HALF-configured mailer in production', () => {
    // Somebody meant to turn email on and left a variable behind. Disabling
    // silently would make password resets vanish behind a cheerful success.
    expect(() => loadConfig({ ...base, RESEND_API_KEY: 're_test_key' })).toThrow(/only partly configured/i);
    expect(() => loadConfig({ ...base, EMAIL_FROM: 'a@b.test' })).toThrow(/only partly configured/i);
  });

  it('boots with email deliberately OFF, and never claims delivery', async () => {
    const config = loadConfig(base);
    expect(resolveMailTransport(config).transport).toBeNull();
    const chosen = createMailer(config);
    expect(chosen).toBeInstanceOf(UnavailableMailer);
    expect(
      (await chosen.send({ to: 'a@b.test', subject: '', html: '', text: '', template: 't' })).delivery,
    ).toBe('unavailable');
  });

  it('never describes the API key — not even redacted', () => {
    const config = loadConfig({
      ...base,
      RESEND_API_KEY: 're_a_very_secret_key_value',
      EMAIL_FROM: 'Ledgora <accounts@expertsgroup.me>',
    });
    const described = JSON.stringify(describeConfig(config));
    expect(described).not.toContain('re_a_very_secret_key_value');
    expect(described).not.toContain('RESEND_API_KEY');
    // Only WHETHER it is configured.
    expect(describeConfig(config).mailConfigured).toBe(true);
  });

  it('falls back to the first allowed origin when APP_PUBLIC_URL is unset', () => {
    const config = loadConfig({
      ...base,
      FRONTEND_URL: 'https://app.example.test/,https://other.test',
    });
    expect(config.appPublicUrl).toBe('https://app.example.test');
  });
});

/* ══ The invitation path is untouched ════════════════════════════════════ */

describe('the existing invitation flow', () => {
  it('still redeems through the same endpoint and the same table', async () => {
    await boot();
    const admin = await seedUser(ctx, {
      email: 'super@ledgora.test',
      fullName: 'Platform Super Admin',
      platformRoles: ['super_admin'],
    });
    const cookies = readCookies(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'super@ledgora.test', password: TEST_PASSWORD },
        })
      ).headers as Record<string, unknown>,
    );

    const plans = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/subscribers',
      headers: authHeaders(cookies),
      payload: {
        fullName: 'Owner Person',
        email: 'owner@newco.test',
        organizationLegalName: 'NewCo Trading LLC',
        country: 'AE',
        baseCurrency: 'AED',
        planId: plans.json().plans[0].id,
        onboarding: 'temporary',
        paymentConfirmed: true,
      },
    });
    expect(created.statusCode).toBe(201);

    const invited = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/organizations/${created.json().subscriber.organizationId}/members/invite`,
      headers: authHeaders(cookies),
      payload: { email: 'new@newco.test', fullName: 'New Person', role: 'member' },
    });
    expect(invited.statusCode).toBe(201);
    expect(invited.json().delivery).toBe('sent');
    expect(admin.id).toBeTruthy();

    const invitation = mailer.sent.find((m) => m.template === 'invitation.create')!;
    expect(invitation.to).toBe('new@newco.test');
    // The invitation link is built from the SAME public origin the reset link is.
    expect(linkFrom(invitation).startsWith(`${APP_URL}/set-password?token=`)).toBe(true);

    // And the invited person can complete password setup with it.
    expect((await redeem(tokenFrom(invitation))).json().purpose).toBe('invitation');
    const signedIn = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'new@newco.test', password: NEW_PASSWORD },
    });
    expect(signedIn.statusCode).toBe(200);
  });
});
