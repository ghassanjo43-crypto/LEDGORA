/**
 * Outbound mail.
 *
 * ── Why this shape ───────────────────────────────────────────────────────────
 * Modelled on `storage/fileStorage`: an interface with swappable adapters, so
 * the code that SENDS never knows how. There is no mail dependency in this
 * repository and adding one for a single template would be a heavy way to make
 * an HTTPS request, so the production adapter posts JSON to a transactional
 * provider's API with Node's built-in `fetch`.
 *
 * ── Which providers this actually works with ─────────────────────────────────
 * ONE contract: a JSON body of `{from, to[], subject, html, text}` with a
 * `Bearer` token in `Authorization`. That is Resend's API, and anything that
 * deliberately mimics it.
 *
 * It does NOT work with Postmark (`X-Postmark-Server-Token`, and
 * `From`/`To`/`HtmlBody`/`TextBody`), SendGrid (`personalizations[]`) or
 * Mailgun (form-encoded, basic auth) without a per-provider adapter. An earlier
 * version of this comment claimed otherwise; it was wrong.
 *
 * ── The honesty rule ─────────────────────────────────────────────────────────
 * `send` returns a RESULT; it does not throw on delivery failure and it never
 * reports success it cannot substantiate:
 *
 *   sent        the provider accepted the message
 *   unavailable no transport is configured — nothing was attempted
 *   failed      delivery was attempted and the provider refused or errored
 *
 * "Nothing was attempted" and "it broke" are different facts for the
 * administrator: one means they must hand the invitation over themselves, the
 * other means they should retry. Collapsing them into a boolean is how a UI ends
 * up claiming an email was sent when no mail service exists.
 *
 * ── What never reaches a log ─────────────────────────────────────────────────
 * The acceptance link is a bearer credential. Nothing in this module logs the
 * body, the link or the token — only the recipient, the template name and the
 * outcome. The provider's own response body is not logged either, because a
 * failing provider commonly echoes the request back.
 */

export type MailDelivery = 'sent' | 'unavailable' | 'failed';

export interface MailMessage {
  to: string;
  subject: string;
  /** Rendered HTML. Contains the acceptance link — never log this. */
  html: string;
  /** Plain-text alternative. Also contains the link — never log this. */
  text: string;
  /** For diagnostics only. Carries no secret. */
  template: string;
}

export interface MailResult {
  delivery: MailDelivery;
  /** Provider message id when one is returned. Never a token. */
  messageId?: string;
  /** A short, safe reason. Never the provider's echoed request body. */
  error?: string;
}

export interface Mailer {
  readonly name: string;
  send(message: MailMessage): Promise<MailResult>;
}

/**
 * The default when nothing is configured.
 *
 * Reports `unavailable` rather than pretending. This is what makes
 * `EXPOSE_INVITATION_TOKENS` a development affordance rather than a necessity:
 * with no transport, the administrator is told plainly that they are the
 * delivery channel.
 */
export class UnavailableMailer implements Mailer {
  readonly name = 'unavailable';
  async send(): Promise<MailResult> {
    return { delivery: 'unavailable' };
  }
}

/**
 * Development transport: records that a message WOULD have been sent.
 *
 * Deliberately logs the recipient and template only. Printing the body would put
 * a live acceptance link in the terminal, the scrollback and any log shipper
 * pointed at it — which is the precise thing the token gate exists to prevent.
 */
export class ConsoleMailer implements Mailer {
  readonly name = 'console';
  constructor(private readonly log: (message: string) => void = console.log) {}

  async send(message: MailMessage): Promise<MailResult> {
    this.log(`[mail] would send "${message.template}" to ${message.to} — body withheld`);
    /*
     * `unavailable`, not `sent`. Nothing left this process, and a development
     * transport that claimed delivery would make the UI lie in exactly the
     * situation the UI most needs to be honest.
     */
    return { delivery: 'unavailable' };
  }
}

export interface HttpMailerOptions {
  /** The provider's send endpoint. Must accept the Resend-compatible contract. */
  endpoint: string;
  /** Bearer credential. Backend-only; never returned by any API response. */
  apiKey: string;
  from: string;
  /** Milliseconds before a hung provider is treated as a failure. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Production transport: POSTs JSON to a transactional email provider.
 *
 * The request carries the API key in an `Authorization` header, so the
 * credential lives only in this process's environment — it is never sent to a
 * browser, never returned by an endpoint, and never written to the audit trail.
 */
export class HttpMailer implements Mailer {
  readonly name = 'http';
  constructor(private readonly options: HttpMailerOptions) {}

  async send(message: MailMessage): Promise<MailResult> {
    const doFetch = this.options.fetchImpl ?? fetch;
    // A provider that never answers must not hold the request open forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);

    try {
      const response = await doFetch(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        /*
         * The status only. A provider's error body routinely echoes the request
         * — including the HTML, including the link — so it must not be recorded.
         */
        return { delivery: 'failed', error: `Mail provider responded ${response.status}.` };
      }

      let messageId: string | undefined;
      try {
        const body = (await response.json()) as { id?: string; MessageID?: string };
        messageId = body.id ?? body.MessageID;
      } catch {
        // A provider that returns no JSON still accepted the message.
      }
      return { delivery: 'sent', ...(messageId ? { messageId } : {}) };
    } catch (cause) {
      const aborted = (cause as { name?: string }).name === 'AbortError';
      return {
        delivery: 'failed',
        error: aborted ? 'The mail provider timed out.' : 'The mail provider could not be reached.',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface MailConfig {
  MAIL_PROVIDER_URL?: string | undefined;
  MAIL_API_KEY?: string | undefined;
  MAIL_FROM?: string | undefined;
  isProduction: boolean;
  isTest: boolean;
}

/**
 * Choose a transport from configuration.
 *
 * Both the endpoint and the key are required before anything is attempted: a
 * half-configured mailer that silently fails every send is worse than one that
 * says up front it is not configured.
 */
export function createMailer(config: MailConfig): Mailer {
  if (config.MAIL_PROVIDER_URL && config.MAIL_API_KEY && config.MAIL_FROM) {
    return new HttpMailer({
      endpoint: config.MAIL_PROVIDER_URL,
      apiKey: config.MAIL_API_KEY,
      from: config.MAIL_FROM,
    });
  }
  // Tests must not print; development gets a breadcrumb that it would have sent.
  if (config.isTest) return new UnavailableMailer();
  return config.isProduction ? new UnavailableMailer() : new ConsoleMailer();
}
