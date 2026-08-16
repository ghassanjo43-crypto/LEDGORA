/**
 * Password recovery email, and the security notice that follows a change.
 *
 * ── What a reset email may contain ───────────────────────────────────────────
 * ONE reset link, and nothing else that is secret. Never the existing password,
 * never a temporary one, never a password hash, never a session token, and never
 * anything that says whether the address belongs to a real account beyond the
 * fact that this message arrived at all. Someone who did not ask for it must be
 * able to read the whole message, learn nothing, and ignore it.
 *
 * ── Why the recipient is not greeted by name ─────────────────────────────────
 * A reset is requested by whoever typed the address, which is not necessarily
 * the account holder. The invitation email names its recipient because an
 * administrator chose them deliberately; this one is triggered by an
 * unauthenticated stranger, so it says as little about the account as it can.
 *
 * The rendered body is handed straight to the mailer. It is never logged, never
 * audited and never returned by an API response: the link inside it is a bearer
 * credential.
 */
import type { RenderedEmail } from './invitationEmail.js';

/** Escape everything interpolated into the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * "30 minutes" / "24 hours" — how long the link lasts, in the units a person
 * reading an email actually thinks in.
 */
export function describeExpiry(ttlMinutes: number): string {
  const minutes = Math.max(Math.round(ttlMinutes), 1);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

const SHELL_OPEN = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;">
    <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;color:#4338ca;margin-bottom:20px;">LEDGORA</div>`;
const SHELL_CLOSE = `
  </div>
</body></html>`;

export interface PasswordResetEmailInput {
  /** Where the link points. Built from `APP_PUBLIC_URL` — see `buildAcceptUrl`. */
  resetUrl: string;
  /** How long the token lasts, for the "expires in …" line. */
  ttlMinutes: number;
}

export function renderPasswordResetEmail(input: PasswordResetEmailInput): RenderedEmail {
  const url = escapeHtml(input.resetUrl);
  const expiry = escapeHtml(describeExpiry(input.ttlMinutes));

  const html = `${SHELL_OPEN}
    <h1 style="margin:0 0 16px;font-size:19px;">Reset your Ledgora password</h1>
    <p style="margin:0 0 16px;">A password reset was requested for your Ledgora account.</p>
    <p style="margin:0 0 20px;">
      <a href="${url}" style="display:inline-block;background:#4338ca;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;">Reset password</a>
    </p>
    <p style="margin:0 0 16px;color:#475569;font-size:13px;">
      This link can be used once and expires in <strong>${expiry}</strong>.
    </p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;" />
    <p style="margin:0;color:#64748b;font-size:12px;">
      If you did not request this, you can ignore this email — your password has not
      changed. Please do not forward it: anyone holding the link can use it.
    </p>${SHELL_CLOSE}`;

  const text = [
    'LEDGORA',
    '',
    'Reset your Ledgora password',
    '',
    'A password reset was requested for your Ledgora account.',
    '',
    'Choose a new password here:',
    input.resetUrl,
    '',
    `This link can be used once and expires in ${describeExpiry(input.ttlMinutes)}.`,
    '',
    'If you did not request this, you can ignore this email — your password has not changed. Please do not forward it: anyone holding the link can use it.',
  ].join('\n');

  return { subject: 'Reset your Ledgora password', html, text, template: 'password.reset' };
}

/**
 * The notice sent AFTER a password actually changed.
 *
 * Best-effort by design: it carries no link, no credential and no action the
 * recipient must take, so a delivery failure costs them nothing. Nothing in the
 * change path waits on it or fails because of it — see `routes/auth`.
 *
 * It deliberately says WHERE to go if the change was not theirs, and deliberately
 * does not embed a "this wasn't me" link: such a link is itself a credential, and
 * an account under attack is the worst moment to mail out another one.
 */
export function renderPasswordChangedEmail(input: { signInUrl: string }): RenderedEmail {
  const url = escapeHtml(input.signInUrl);

  const html = `${SHELL_OPEN}
    <h1 style="margin:0 0 16px;font-size:19px;">Your Ledgora password was changed</h1>
    <p style="margin:0 0 16px;">Your password was changed successfully.</p>
    <p style="margin:0 0 16px;color:#475569;font-size:13px;">
      Every other signed-in device has been signed out. You can sign in again at
      <a href="${url}" style="color:#4338ca;">${url}</a>.
    </p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;" />
    <p style="margin:0;color:#b45309;font-size:12px;">
      If you did not make this change, contact support immediately.
    </p>${SHELL_CLOSE}`;

  const text = [
    'LEDGORA',
    '',
    'Your Ledgora password was changed',
    '',
    'Your password was changed successfully.',
    '',
    `Every other signed-in device has been signed out. You can sign in again at ${input.signInUrl}.`,
    '',
    'If you did not make this change, contact support immediately.',
  ].join('\n');

  return { subject: 'Your Ledgora password was changed', html, text, template: 'password.changed' };
}
