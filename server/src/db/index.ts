/**
 * Database construction.
 *
 * Production uses node-postgres against Render PostgreSQL. Development and tests
 * may use PGlite (real PostgreSQL, in-process) so the project is usable without
 * installing a database — never in production.
 */
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';
import { PGliteDialect } from './pgliteDialect.js';

export type Db = Kysely<Database>;

export interface CreateDatabaseOptions {
  databaseUrl?: string;
  isProduction?: boolean;
  /** Force the in-process engine (tests). */
  useInMemory?: boolean;
}

/**
 * node-postgres returns NUMERIC as a string to avoid precision loss. We keep
 * that — money must never round-trip through a JS float — and convert
 * explicitly at the edges.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));

export async function createDatabase(options: CreateDatabaseOptions = {}): Promise<Db> {
  const { databaseUrl, isProduction = false, useInMemory = false } = options;

  if (useInMemory || !databaseUrl) {
    if (isProduction) {
      throw new Error('Refusing to start in production without DATABASE_URL — the in-process database is not a production store.');
    }
    const { PGlite } = await import('@electric-sql/pglite');
    return new Kysely<Database>({ dialect: new PGliteDialect(new PGlite()) });
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Render's managed PostgreSQL terminates TLS with its own CA.
    ssl: isProduction ? { rejectUnauthorized: false } : undefined,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Liveness probe used by the health endpoint. Reveals nothing about config. */
export async function pingDatabase(db: Db): Promise<boolean> {
  try {
    await sql`SELECT 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}
