/**
 * The invitation email.
 *
 * ── What it may and may not contain ──────────────────────────────────────────
 * ONE acceptance link, and nothing else that is secret. No password, no
 * temporary credential, no session information. The link is single-use,
 * expiring, and purpose-bound — redeeming it activates the membership and lets
 * the recipient choose their own password, which nobody else ever learns.
 *
 * The rendered body is returned to the caller and handed straight to the mailer.
 * It is never logged, never audited and never returned by an API response: the
 * link inside it is a bearer credential for somebody else's account.
 */

export interface InvitationEmailInput {
  /** The person being invited. */
  recipientName: string;
  organizationName: string;
  /** Who sent it, where that is safely known. Omitted rather than guessed. */
  inviterName?: string | null;
  roleLabel: string;
  acceptUrl: string;
  expiresAt: Date;
  /** `true` when this supersedes an earlier link. */
  isResend?: boolean;
}

/** Escape everything interpolated into the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatExpiry(expiresAt: Date): string {
  return expiresAt.toUTCString();
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  template: string;
}

export function renderInvitationEmail(input: InvitationEmailInput): RenderedEmail {
  const organization = escapeHtml(input.organizationName);
  const recipient = escapeHtml(input.recipientName);
  const role = escapeHtml(input.roleLabel);
  const inviter = input.inviterName ? escapeHtml(input.inviterName) : null;
  const expiry = escapeHtml(formatExpiry(input.expiresAt));
  // The URL is attribute- and text-escaped like everything else; it is generated
  // by this server, but escaping it costs nothing and removes a whole class of
  // question about where it came from.
  const url = escapeHtml(input.acceptUrl);

  const subject = input.isResend
    ? `Your invitation to ${input.organizationName} on Ledgora (resent)`
    : `You have been invited to ${input.organizationName} on Ledgora`;

  const supersededNotice = input.isResend
    ? '<p style="margin:0 0 16px;color:#b45309;">This replaces any earlier invitation email. Previous links no longer work.</p>'
    : '';

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;">
    <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;color:#4338ca;margin-bottom:20px;">LEDGORA</div>
    <h1 style="margin:0 0 16px;font-size:19px;">You have been invited to ${organization}</h1>
    ${supersededNotice}
    <p style="margin:0 0 12px;">Hello ${recipient},</p>
    <p style="margin:0 0 16px;">
      ${inviter ? `${inviter} has invited you` : 'You have been invited'} to join
      <strong>${organization}</strong> on Ledgora as <strong>${role}</strong>.
    </p>
    <p style="margin:0 0 20px;">Use the button below to accept and choose your own password. Nobody else, including your administrator, ever sees it.</p>
    <p style="margin:0 0 20px;">
      <a href="${url}" style="display:inline-block;background:#4338ca;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;">Accept invitation</a>
    </p>
    <p style="margin:0 0 16px;color:#475569;font-size:13px;">
      This link can be used once and expires on <strong>${expiry}</strong>.
      If it has expired, ask your administrator to send a new one.
    </p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;" />
    <p style="margin:0;color:#64748b;font-size:12px;">
      If you were not expecting this invitation, you can safely ignore this email —
      no account is created for you until the link is used. Please do not forward it:
      anyone holding the link can use it.
    </p>
  </div>
</body></html>`;

  const text = [
    'LEDGORA',
    '',
    `You have been invited to ${input.organizationName}`,
    '',
    ...(input.isResend ? ['This replaces any earlier invitation. Previous links no longer work.', ''] : []),
    `Hello ${input.recipientName},`,
    '',
    `${input.inviterName ? `${input.inviterName} has invited you` : 'You have been invited'} to join ${input.organizationName} on Ledgora as ${input.roleLabel}.`,
    '',
    'Accept the invitation and choose your own password here:',
    input.acceptUrl,
    '',
    `This link can be used once and expires on ${formatExpiry(input.expiresAt)}.`,
    '',
    'If you were not expecting this invitation you can safely ignore this email — no account is created for you until the link is used. Please do not forward it: anyone holding the link can use it.',
  ].join('\n');

  return { subject, html, text, template: input.isResend ? 'invitation.resend' : 'invitation.create' };
}

/**
 * The acceptance URL.
 *
 * Built from the configured frontend origin so the link always points at the
 * deployment that issued it. `/set-password` is the redemption page registered
 * in `lib/accessControl`.
 */
export function buildAcceptUrl(frontendUrl: string, token: string): string {
  const origin = frontendUrl.split(',')[0]!.trim().replace(/\/$/, '');
  return `${origin}/set-password?token=${encodeURIComponent(token)}`;
}
