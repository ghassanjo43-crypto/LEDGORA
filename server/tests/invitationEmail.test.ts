/**
 * Invitation email delivery.
 *
 * The claims this suite proves:
 *
 *   honesty     the API reports `sent` only when a provider accepted the
 *               message, and `unavailable` / `failed` are never conflated;
 *   secrecy     the acceptance link never reaches a log, an audit entry, or a
 *               production response — and the API key never leaves the process;
 *   recovery    a delivery failure leaves the membership and its reserved seat
 *               intact, so a resend costs neither a second seat nor a second
 *               membership;
 *   supersession a resend invalidates the previous link.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  authHeaders,
  createTestContext,
  login,
  seedUser,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';
import {
  ConsoleMailer,
  HttpMailer,
  UnavailableMailer,
  createMailer,
  type MailMessage,
  type MailResult,
  type Mailer,
} from '../src/mail/mailer.js';
import { buildAcceptUrl, renderInvitationEmail } from '../src/mail/invitationEmail.js';

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

async function boot(result?: MailResult): Promise<void> {
  mailer = new RecordingMailer(result);
  ctx = await createTestContext({}, { mailer });
}

afterEach(async () => {
  await ctx?.close();
  vi.restoreAllMocks();
});

async function operator(): Promise<{ cookies: SessionCookies; userId: string }> {
  const user = await seedUser(ctx, {
    email: 'super@ledgora.test',
    fullName: 'Platform Super Admin',
    platformRoles: ['super_admin'],
  });
  return { cookies: await login(ctx, 'super@ledgora.test'), userId: user.id };
}

async function subscriber(admin: SessionCookies): Promise<string> {
  const plans = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/subscribers',
    headers: authHeaders(admin),
    payload: {
      fullName: 'Owner Person',
      email: 'owner@newco.test',
      organizationLegalName: 'NewCo Trading LLC',
      country: 'AE',
      planId: plans.json().plans.find((p: { code: string }) => p.code === 'enterprise').id,
      onboarding: 'temporary',
      paymentConfirmed: true,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().subscriber.organizationId;
}

const invite = (admin: SessionCookies, organizationId: string, email = 'new@newco.test') =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/admin/organizations/${organizationId}/members/invite`,
    headers: authHeaders(admin),
    payload: { email, fullName: 'New Person', role: 'member' },
  });

/* ══ The rendered message ════════════════════════════════════════════════ */

describe('the invitation email', () => {
  it('carries the branding, organization, inviter, role and expiry', () => {
    const rendered = renderInvitationEmail({
      recipientName: 'Rami Bookkeeper',
      organizationName: 'NewCo Trading LLC',
      inviterName: 'Sam Owner',
      roleLabel: 'accountant',
      acceptUrl: 'https://app.example.test/set-password?token=abc',
      expiresAt: new Date('2026-09-01T10:00:00.000Z'),
    });

    for (const fragment of ['LEDGORA', 'NewCo Trading LLC', 'Sam Owner', 'accountant']) {
      expect(rendered.html).toContain(fragment);
      expect(rendered.text).toContain(fragment);
    }
    expect(rendered.html).toContain('2026');
    // Exactly one acceptance link.
    expect(rendered.html.match(/set-password\?token=/g)).toHaveLength(1);
    // And the warning for somebody who was not expecting it.
    expect(rendered.text).toMatch(/safely ignore this email/i);
    expect(rendered.html).toMatch(/safely ignore this email/i);
  });

  it('escapes interpolated values', () => {
    const rendered = renderInvitationEmail({
      recipientName: '<script>alert(1)</script>',
      organizationName: 'A & B "Ltd"',
      inviterName: null,
      roleLabel: 'viewer',
      acceptUrl: 'https://app.example.test/set-password?token=abc',
      expiresAt: new Date('2026-09-01T10:00:00.000Z'),
    });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).toContain('A &amp; B &quot;Ltd&quot;');
  });

  it('says plainly when it supersedes an earlier link', () => {
    const rendered = renderInvitationEmail({
      recipientName: 'Rami',
      organizationName: 'NewCo',
      roleLabel: 'member',
      acceptUrl: 'https://app.example.test/set-password?token=abc',
      expiresAt: new Date('2026-09-01T10:00:00.000Z'),
      isResend: true,
    });
    expect(rendered.subject).toMatch(/resent/i);
    expect(rendered.text).toMatch(/previous links no longer work/i);
  });

  it('builds the acceptance URL from the configured origin', () => {
    // A comma-separated allow-list uses its first entry, and never double-slashes.
    expect(buildAcceptUrl('https://app.example.test/,https://other.test', 'tok en')).toBe(
      'https://app.example.test/set-password?token=tok%20en',
    );
  });
});

/* ══ Transport selection and honesty ═════════════════════════════════════ */

describe('the mail transport', () => {
  it('reports unavailable when nothing is configured', async () => {
    const chosen = createMailer({ isProduction: true, isTest: false });
    expect(chosen).toBeInstanceOf(UnavailableMailer);
    expect((await chosen.send({ to: 'a@b.test', subject: '', html: '', text: '', template: 't' })).delivery).toBe(
      'unavailable',
    );
  });

  it('requires the endpoint, the key AND the sender before attempting anything', () => {
    // A half-configured mailer that silently fails every send is worse than one
    // that says up front it is not configured.
    expect(
      createMailer({ MAIL_PROVIDER_URL: 'https://x.test', isProduction: true, isTest: false }),
    ).toBeInstanceOf(UnavailableMailer);
    expect(
      createMailer({
        MAIL_PROVIDER_URL: 'https://x.test',
        MAIL_API_KEY: 'k',
        MAIL_FROM: 'no-reply@ledgora.test',
        isProduction: true,
        isTest: false,
      }),
    ).toBeInstanceOf(HttpMailer);
  });

  it('never prints the message body in development', async () => {
    const lines: string[] = [];
    const console = new ConsoleMailer((line) => lines.push(line));
    const result = await console.send({
      to: 'rami@newco.test',
      subject: 'Invitation',
      html: '<a href="https://app.test/set-password?token=SECRET-TOKEN">Accept</a>',
      text: 'https://app.test/set-password?token=SECRET-TOKEN',
      template: 'invitation.create',
    });

    expect(lines.join('\n')).not.toContain('SECRET-TOKEN');
    expect(lines.join('\n')).toContain('rami@newco.test');
    // Nothing left the process, so it must not claim delivery.
    expect(result.delivery).toBe('unavailable');
  });

  it('sends the API key in a header and never in the body', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const http = new HttpMailer({
      endpoint: 'https://provider.test/send',
      apiKey: 'super-secret-key',
      from: 'no-reply@ledgora.test',
      fetchImpl: (async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response(JSON.stringify({ id: 'msg_9' }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const result = await http.send({ to: 'a@b.test', subject: 's', html: 'h', text: 't', template: 'x' });
    expect(result).toEqual({ delivery: 'sent', messageId: 'msg_9' });
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer super-secret-key');
    expect(String(captured!.init.body)).not.toContain('super-secret-key');
  });

  it('reports failed — not sent — when the provider refuses, without echoing its body', async () => {
    const http = new HttpMailer({
      endpoint: 'https://provider.test/send',
      apiKey: 'k',
      from: 'no-reply@ledgora.test',
      fetchImpl: (async () =>
        // A provider commonly echoes the request, link and all.
        new Response('{"error":"bad","echo":"token=SECRET-TOKEN"}', { status: 422 })) as unknown as typeof fetch,
    });

    const result = await http.send({ to: 'a@b.test', subject: 's', html: 'h', text: 't', template: 'x' });
    expect(result.delivery).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('SECRET-TOKEN');
    expect(result.error).toContain('422');
  });

  it('reports failed when the provider cannot be reached', async () => {
    const http = new HttpMailer({
      endpoint: 'https://provider.test/send',
      apiKey: 'k',
      from: 'no-reply@ledgora.test',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect((await http.send({ to: 'a@b.test', subject: '', html: '', text: '', template: 'x' })).delivery).toBe(
      'failed',
    );
  });
});

/* ══ Delivery through the real invite route ══════════════════════════════ */

describe('inviting through the API', () => {
  it('reports sent, and mails exactly one acceptance link', async () => {
    await boot({ delivery: 'sent', messageId: 'msg_1' });
    const admin = await operator();
    const organizationId = await subscriber(admin.cookies);

    const response = await invite(admin.cookies, organizationId);
    expect(response.statusCode).toBe(201);
    expect(response.json().delivery).toBe('sent');

    expect(mailer.sent).toHaveLength(1);
    const message = mailer.sent[0]!;
    expect(message.to).toBe('new@newco.test');
    expect(message.html).toContain('NewCo Trading LLC');
    // The inviter is named where it is safely known.
    expect(message.html).toContain('Platform Super Admin');
    expect(message.html.match(/set-password\?token=/g)).toHaveLength(1);
  });

  it('reports failed without claiming success, and keeps the membership', async () => {
    await boot({ delivery: 'failed', error: 'Mail provider responded 500.' });
    const admin = await operator();
    const organizationId = await subscriber(admin.cookies);

    const response = await invite(admin.cookies, organizationId);
    // The invitation was CREATED; only its delivery failed.
    expect(response.statusCode).toBe(201);
    expect(response.json().delivery).toBe('failed');

    // The membership and its reserved seat survive, so a resend costs neither a
    // second seat nor a second membership.
    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .execute();
    expect(memberships).toHaveLength(2);
    expect(memberships.find((m) => m.status === 'invited')).toBeTruthy();
  });

  it('lets a failed delivery be retried by resending, without a second seat', async () => {
    await boot({ delivery: 'failed' });
    const admin = await operator();
    const organizationId = await subscriber(admin.cookies);
    const invited = await invite(admin.cookies, organizationId);
    const userId = invited.json().member.userId as string;

    const membershipsBefore = await ctx.db
      .selectFrom('organization_memberships')
      .select('id')
      .where('organization_id', '=', organizationId)
      .execute();

    const { resendInvitation } = await import('../src/services/memberService.js');
    const resent = await resendInvitation(
      ctx.db,
      { organizationId, userId },
      { actorUserId: admin.userId, actorPlatformRole: 'super_admin' },
    );

    // Same membership, same seat.
    expect(
      await ctx.db
        .selectFrom('organization_memberships')
        .select('id')
        .where('organization_id', '=', organizationId)
        .execute(),
    ).toEqual(membershipsBefore);

    // And the new link works while the old one does not.
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: invited.json().invitationToken, newPassword: 'Bright-Harbour-58-Zq' },
      })).statusCode,
    ).toBe(400);
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: resent.invitationToken, newPassword: 'Bright-Harbour-58-Zq' },
      })).statusCode,
    ).toBe(200);
  });

  it('never writes the acceptance link to the audit trail', async () => {
    await boot({ delivery: 'sent' });
    const admin = await operator();
    const organizationId = await subscriber(admin.cookies);
    const invited = await invite(admin.cookies, organizationId);
    const token = invited.json().invitationToken as string;

    const audits = await ctx.db.selectFrom('audit_logs').selectAll().execute();
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(JSON.stringify(audits)).not.toContain('set-password?token=');
  });

  it('withholds the token from the response even when delivery fails', async () => {
    // Production must not fall back to handing the operator the raw link
    // because the mail provider was down.
    const plain = await createTestContext(
      { EXPOSE_INVITATION_TOKENS: 'false' },
      { mailer: new RecordingMailer({ delivery: 'failed' }) },
    );
    try {
      const { createUser, assignPlatformRole } = await import('../src/services/userService.js');
      const user = await createUser(plain.db, {
        email: 'super@ledgora.test',
        password: 'Correct-Horse-9-Battery',
        fullName: 'Admin',
        status: 'active',
        emailVerified: true,
      });
      await assignPlatformRole(plain.db, user.id, 'super_admin');
      const cookies = await login(plain, 'super@ledgora.test', 'Correct-Horse-9-Battery');

      const plans = await plain.app.inject({ method: 'GET', url: '/api/plans/public' });
      const created = await plain.app.inject({
        method: 'POST',
        url: '/api/admin/subscribers',
        headers: authHeaders(cookies),
        payload: {
          fullName: 'Owner',
          email: 'owner@newco.test',
          organizationLegalName: 'NewCo Trading LLC',
          country: 'AE',
          planId: plans.json().plans[0].id,
          onboarding: 'temporary',
          paymentConfirmed: true,
        },
      });

      const response = await plain.app.inject({
        method: 'POST',
        url: `/api/admin/organizations/${created.json().subscriber.organizationId}/members/invite`,
        headers: authHeaders(cookies),
        payload: { email: 'new@newco.test', fullName: 'New Person', role: 'member' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().delivery).toBe('failed');
      expect(response.json().invitationToken).toBeUndefined();
      expect(response.body).not.toMatch(/set-password\?token=/);
    } finally {
      await plain.close();
    }
  });
});
