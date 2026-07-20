/**
 * Environment configuration, validated once at boot.
 *
 * Fail-fast: a missing or malformed value stops the process with a readable
 * message rather than surfacing as a confusing runtime error later. Nothing here
 * is ever logged — `describeConfig()` returns a redacted view for diagnostics.
 */
import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Render injects this; the server must bind 0.0.0.0 to be reachable. */
  HOST: z.string().default('0.0.0.0'),

  /** Empty in test: the suite uses an in-process PGlite database instead. */
  DATABASE_URL: z.string().default(''),

  /** Exact origin(s) allowed to send credentialed requests. Comma-separated. */
  FRONTEND_URL: z.string().default('http://localhost:5173'),

  /** Used to derive the CSRF token binding. Must be long and random. */
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters').default('dev-only-insecure-session-secret'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(60 * 24).default(30),

  UPLOAD_DIRECTORY: z.string().default('./storage/payment-proofs'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(5 * 1024 * 1024),

  /** Set true only behind Render's proxy, so client IPs are read correctly. */
  TRUST_PROXY: booleanish.default(false),

  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
  /** Failed attempts before the account is temporarily locked. */
  ACCOUNT_LOCK_THRESHOLD: z.coerce.number().int().min(3).default(8),
  ACCOUNT_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),

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
  }

  return {
    ...value,
    isProduction,
    isTest: value.NODE_ENV === 'test',
    allowedOrigins: value.FRONTEND_URL.split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean),
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
    databaseConfigured: Boolean(config.DATABASE_URL),
    sessionSecretConfigured: config.SESSION_SECRET !== 'dev-only-insecure-session-secret',
    sessionTtlHours: config.SESSION_TTL_HOURS,
    trustProxy: config.TRUST_PROXY,
    bootstrapAdminEnabled: config.BOOTSTRAP_ADMIN_ENABLED,
  };
}
