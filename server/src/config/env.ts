/**
 * Environment configuration, validated once at boot.
 *
 * Fail-fast: a missing or malformed value stops the process with a readable
 * message rather than surfacing as a confusing runtime error later. Nothing here
 * is ever logged — `describeConfig()` returns a redacted view for diagnostics.
 */
import { z } from 'zod';
import { resolveMailTransport } from '../mail/mailer.js';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

/**
 * An RFC 5322 sender: either a bare address or `Display Name <address>`.
 *
 * A bare-`.email()` check would refuse `Ledgora <accounts@expertsgroup.me>`,
 * which is the form every transactional provider expects and the form the Render
 * service is configured with. The display name is deliberately kept out of angle
 * brackets and quotes so a header cannot be split.
 */
const mailFrom = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .refine((value) => {
    const match = /^(?:([^<>\r\n]*)\s)?<?([^<>\s\r\n]+@[^<>\s\r\n]+\.[^<>\s\r\n]+)>?$/.exec(value);
    return Boolean(match) && z.string().email().safeParse(match![2]).success;
  }, 'EMAIL_FROM must be an email address, optionally as "Display Name <address>".');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Return raw invitation links in API responses.
   *
   * A DEVELOPMENT convenience for deployments with no mail service: without it
   * an invited person cannot be reached at all, because the token exists in one
   * response and is stored only as a digest.
   *
   * It is refused outright in production (see below) rather than merely
   * defaulting to false — a flag that can be switched on by an environment
   * variable is a flag that eventually is, and this one hands out a live
   * credential for somebody else's account.
   */
  /**
   * Transactional email. All three are required before anything is attempted:
   * a half-configured mailer that silently fails every send is worse than one
   * that reports itself unavailable.
   *
   * `MAIL_PROVIDER_URL` must accept the RESEND-COMPATIBLE contract — a JSON body
   * of `{from, to[], subject, html, text}` with a `Bearer` token. Postmark,
   * SendGrid and Mailgun use different payloads and auth schemes and need a
   * per-provider adapter; see `mail/mailer`.
   *
   * `MAIL_API_KEY` is a backend-only credential. It is never returned by an API
   * response, never logged, and never reaches the browser.
   */
  MAIL_PROVIDER_URL: z.string().url().optional(),
  MAIL_API_KEY: z.string().min(1).optional(),
  MAIL_FROM: mailFrom.optional(),
  /**
   * Resend, named as Resend names it.
   *
   * These three are the variables the Render service actually carries, so they
   * are read directly rather than asking an operator to re-spell them as
   * `MAIL_*`. They are ALIASES, not a second system: `resolveMailTransport`
   * folds them into the same `{endpoint, apiKey, from}` the generic variables
   * produce, and supplying `RESEND_API_KEY` alone simply defaults the endpoint
   * to Resend's. An explicit `MAIL_*` value always wins, so a deployment can
   * still point at a Resend-compatible provider that is not Resend.
   *
   * `RESEND_API_KEY` is a backend-only credential. It is never returned by an
   * API response, never logged, and never reaches the browser — `describeConfig`
   * reports only WHETHER mail is configured.
   */
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: mailFrom.optional(),
  /**
   * The public origin of the Ledgora frontend, used to build the links inside
   * transactional email.
   *
   * Distinct from `FRONTEND_URL`, which is a CORS allow-list and may hold
   * several origins: a link has to name exactly one. Defaults to the first
   * allowed origin so an existing deployment keeps working unchanged.
   */
  APP_PUBLIC_URL: z.string().url().optional(),
  /**
   * Permit the DEVELOPMENT bootstrap that reclassifies existing production rows
   * as test/demo so a development dataset can be cleaned up.
   *
   * Refused outright in production (see below) rather than merely defaulting to
   * false: this is the one route around the retention invariant, and a flag that
   * an environment variable can switch on is a flag that eventually is.
   */
  ALLOW_LEGACY_DATA_CLASSIFICATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  EXPOSE_INVITATION_TOKENS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Render injects this; the server must bind 0.0.0.0 to be reachable. */
  HOST: z.string().default('0.0.0.0'),

  /** Empty in test: the suite uses an in-process PGlite database instead. */
  DATABASE_URL: z.string().default(''),

  /** Exact origin(s) allowed to send credentialed requests. Comma-separated. */
  FRONTEND_URL: z.string().default('http://localhost:5173'),

  /**
   * Cross-site behaviour of the session/CSRF cookies.
   *
   *  · `lax`  — the browser sends the cookie on same-origin (and top-level GET)
   *    requests. Correct when the API is reached through the frontend origin
   *    (a `/api` reverse proxy). This is the DEFAULT and the recommended
   *    deployment.
   *  · `none` — the cookie travels on genuinely cross-site requests. Required
   *    when the browser talks to a *different* API hostname. The browser only
   *    honours `SameSite=None` on a `Secure` cookie, so this is production-only.
   *
   * `strict` is offered for completeness but breaks the cross-origin login flow.
   */
  COOKIE_SAMESITE: z.enum(['lax', 'none', 'strict']).default('lax'),
  /**
   * Emit the `Partitioned` attribute (CHIPS) alongside `SameSite=None`. Where
   * the browser supports it the cookie is double-keyed to the top-level site,
   * which keeps a cross-site session working as third-party cookies are phased
   * out. Ignored by browsers that do not implement it.
   */
  COOKIE_PARTITIONED: booleanish.default(false),

  /** Used to derive the CSRF token binding. Must be long and random. */
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters').default('dev-only-insecure-session-secret'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(60 * 24).default(30),
  /**
   * How long an administrator-issued TEMPORARY password stays usable.
   *
   * Longer than a reset link on purpose: a temporary password is read out or
   * handed over by a human, which is not instantaneous, whereas a link is
   * clicked. It still expires — a credential an operator generated and forgot
   * about must not remain valid indefinitely. The account holder is forced to
   * replace it at first sign-in regardless.
   */
  TEMPORARY_PASSWORD_TTL_MINUTES: z.coerce.number().int().min(5).max(60 * 24 * 30).default(60 * 24),

  UPLOAD_DIRECTORY: z.string().default('./storage/payment-proofs'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(5 * 1024 * 1024),

  /** Set true only behind Render's proxy, so client IPs are read correctly. */
  TRUST_PROXY: booleanish.default(false),

  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
  /**
   * A tighter budget than login for `POST /api/auth/forgot-password`.
   *
   * Lower on purpose: the endpoint answers identically for every address, so it
   * cannot be used to enumerate accounts, but each accepted call sends mail to a
   * third party. The limit is what stops it being used to post mail at somebody
   * — and what keeps the sending domain's reputation out of an attacker's hands.
   */
  FORGOT_PASSWORD_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(5),
  /** Failed attempts before the account is temporarily locked. */
  ACCOUNT_LOCK_THRESHOLD: z.coerce.number().int().min(3).default(8),
  ACCOUNT_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),

  /**
   * How long an applicant may be inactive before the administrator roster shows
   * them as dormant. Purely a display overlay — nothing is ever deleted, and the
   * applicant leaves the dormant tab the moment they sign in again.
   */
  APPLICANT_DORMANT_DAYS: z.coerce.number().int().min(1).max(3650).default(30),

  /* One-shot administrator bootstrap. Disabled unless explicitly turned on. */
  BOOTSTRAP_ADMIN_ENABLED: booleanish.default(false),
  BOOTSTRAP_ADMIN_EMAIL: z.string().default(''),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().default(''),
  BOOTSTRAP_ADMIN_FULL_NAME: z.string().default(''),
});

export type AppConfig = z.infer<typeof schema> & {
  isProduction: boolean;
  isTest: boolean;
  allowedOrigins: string[];
  /**
   * The ONE origin every emailed link is built from. Resolved once here so a
   * caller never has to decide which entry of a multi-origin `FRONTEND_URL` a
   * link should name.
   */
  appPublicUrl: string;
  /** Resolved cookie attributes, so the session plugin has one source of truth. */
  cookie: {
    sameSite: 'lax' | 'none' | 'strict';
    /** `SameSite=None` is only honoured on a Secure cookie. */
    secure: boolean;
    partitioned: boolean;
  };
};

let cached: AppConfig | null = null;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  const value = parsed.data;
  const isProduction = value.NODE_ENV === 'production';

  if (isProduction) {
    if (!value.DATABASE_URL) throw new Error('DATABASE_URL is required in production.');
    if (value.SESSION_SECRET === 'dev-only-insecure-session-secret') {
      throw new Error('SESSION_SECRET must be set to a strong random value in production.');
    }
    if (value.ALLOW_LEGACY_DATA_CLASSIFICATION) {
      throw new Error(
        'ALLOW_LEGACY_DATA_CLASSIFICATION cannot be enabled in production. Reclassifying a production subscriber as test or demo data would remove it from retention protection.',
      );
    }
    if (value.EXPOSE_INVITATION_TOKENS) {
      /*
       * Refused, not ignored. Silently disabling it would leave an operator
       * believing invitation links are being surfaced somewhere; failing at boot
       * makes the misconfiguration impossible to miss.
       */
      throw new Error(
        'EXPOSE_INVITATION_TOKENS cannot be enabled in production. Invitation links are a bearer credential and must be delivered by the mail service.',
      );
    }
    /*
     * A HALF-configured mailer is refused outright.
     *
     * Not the same as no mailer at all: a deployment with nothing set has simply
     * not turned email on, and `createMailer` reports itself `unavailable` so
     * nothing ever claims a message was sent. But a key with no sender (or a
     * sender with no key) is a MISCONFIGURATION — somebody meant to enable mail
     * and left a variable behind — and silently disabling it there would leave
     * password resets vanishing with a cheerful "instructions have been sent".
     */
    if (resolveMailTransport(value).partial) {
      throw new Error(
        'Transactional email is only partly configured. Set the API key (RESEND_API_KEY or MAIL_API_KEY) AND the sender (EMAIL_FROM or MAIL_FROM), or unset both to run with email disabled.',
      );
    }
    if (value.COOKIE_SAMESITE === 'none' && !value.TRUST_PROXY) {
      // Cross-site cookies must be Secure, and only reach the app as Secure when
      // TLS termination (Render's proxy) is trusted. Refusing here turns a
      // silent "the cookie never arrives" into a clear boot-time error.
      throw new Error('COOKIE_SAMESITE=none requires TRUST_PROXY=true so Secure cookies are honoured behind the proxy.');
    }
  }

  // `SameSite=None` is meaningless without `Secure`; force it on so a
  // cross-site session cannot silently degrade to a cookie the browser drops.
  const cookieSecure = isProduction || value.COOKIE_SAMESITE === 'none';

  const allowedOrigins = value.FRONTEND_URL.split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

  return {
    ...value,
    isProduction,
    isTest: value.NODE_ENV === 'test',
    allowedOrigins,
    // An explicit public URL wins; otherwise the first allowed origin, which is
    // what every link was already being built from.
    appPublicUrl: (value.APP_PUBLIC_URL ?? allowedOrigins[0] ?? value.FRONTEND_URL).replace(/\/$/, ''),
    cookie: {
      sameSite: value.COOKIE_SAMESITE,
      secure: cookieSecure,
      partitioned: value.COOKIE_PARTITIONED && value.COOKIE_SAMESITE === 'none',
    },
  };
}

export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Diagnostics view. Secrets are never included, only whether they are set. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: config.NODE_ENV,
    port: config.PORT,
    host: config.HOST,
    allowedOrigins: config.allowedOrigins,
    appPublicUrl: config.appPublicUrl,
    databaseConfigured: Boolean(config.DATABASE_URL),
    /*
     * WHETHER mail is configured, never HOW. The API key is not reported here in
     * any form — not redacted, not fingerprinted, not by length — because this
     * object is written to logs and returned by diagnostics.
     */
    mailConfigured: Boolean(resolveMailTransport(config).transport),
    sessionSecretConfigured: config.SESSION_SECRET !== 'dev-only-insecure-session-secret',
    sessionTtlHours: config.SESSION_TTL_HOURS,
    trustProxy: config.TRUST_PROXY,
    cookieSameSite: config.cookie.sameSite,
    cookieSecure: config.cookie.secure,
    cookiePartitioned: config.cookie.partitioned,
    bootstrapAdminEnabled: config.BOOTSTRAP_ADMIN_ENABLED,
  };
}
