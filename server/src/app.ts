/**
 * Fastify application assembly.
 *
 * `buildApp` returns a fully wired instance without listening, so tests can
 * drive it through `app.inject()` against a real PostgreSQL (PGlite) database
 * with no network involved.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import type { AppConfig } from './config/env.js';
import type { Db } from './db/index.js';
import sessionPlugin from './plugins/session.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { adminBillingRoutes } from './routes/adminBilling.js';
import { LocalFileStorage, type FileStorage } from './storage/fileStorage.js';
import { AppError, toErrorResponse } from './lib/errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: AppConfig;
    /** Payment-proof bytes. Never PostgreSQL — see storage/fileStorage. */
    fileStorage: FileStorage;
  }
}

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  /** Override the storage adapter (tests use the in-memory one). */
  fileStorage?: FileStorage;
}

export async function buildApp({ config, db, fileStorage }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // Render terminates TLS upstream; trust the proxy so `request.ip` is the
    // real client address (rate limiting and audit logs depend on it).
    trustProxy: config.TRUST_PROXY,
    // Cap request bodies. Uploads use their own, larger limit in Phase 2.
    bodyLimit: 256 * 1024,
    logger: config.isTest
      ? false
      : {
          level: config.isProduction ? 'info' : 'debug',
          // Never let a credential reach the log, even via an echoed header.
          redact: {
            paths: ['req.headers.cookie', 'req.headers.authorization', 'req.body.password', 'req.body.newPassword', 'req.body.currentPassword'],
            censor: '[redacted]',
          },
        },
  });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('fileStorage', fileStorage ?? new LocalFileStorage(config.UPLOAD_DIRECTORY));

  /**
   * Tolerate an empty body on `application/json` requests. Browser clients
   * routinely set a default JSON content-type on bodyless POSTs (logout,
   * logout-all); Fastify's stock parser rejects those with a 400.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (raw === '') return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(new AppError('validation_error', 'Request body is not valid JSON.'), undefined);
    }
  });

  /* ── Security headers ─────────────────────────────────────────────────── */
  await app.register(helmet, {
    // The API serves JSON only; a restrictive CSP costs nothing here.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: config.isProduction ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });

  /* ── CORS: exact-origin allow-list, credentials enabled ───────────────── */
  await app.register(cors, {
    origin(origin, callback) {
      // Same-origin/curl requests carry no Origin header — allowed.
      if (!origin) return callback(null, true);
      const normalised = origin.replace(/\/$/, '');
      if (config.allowedOrigins.includes(normalised)) return callback(null, true);
      // Reject rather than silently omitting the header, so misconfiguration is
      // obvious during deployment instead of failing mysteriously in the browser.
      return callback(new Error('Origin not allowed'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token'],
    maxAge: 600,
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });

  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: 60_000,
    keyGenerator: (request) => request.ip,
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.MAX_UPLOAD_BYTES,
      files: 1,
      fields: 10,
      fieldSize: 4096,
    },
  });

  await app.register(sessionPlugin, { config });

  /* ── Central error handling ───────────────────────────────────────────── */
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      const { statusCode, body } = toErrorResponse(error);
      return reply.code(statusCode).send(body);
    }
    // Fastify's own typed errors (rate limit, payload size, bad JSON…).
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Try again shortly.' } });
    }
    if (statusCode === 413) {
      return reply.code(413).send({ error: { code: 'payload_too_large', message: 'Request body is too large.' } });
    }
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: { code: 'validation_error', message: 'The request could not be processed.' } });
    }
    // 5xx: log the detail server-side, return nothing revealing.
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'An unexpected error occurred.' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Endpoint not found.' } }),
  );

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(subscriptionRoutes);
  await app.register(adminBillingRoutes);

  return app;
}
