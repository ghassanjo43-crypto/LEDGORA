/**
 * Kysely dialect over PGlite — a real PostgreSQL engine compiled to WASM.
 *
 * Purpose: run the exact same SQL, migrations and queries as production against
 * a genuine PostgreSQL instance with nothing installed. Used by the test suite
 * and by `npm run server:dev` when no DATABASE_URL is configured, so a developer
 * can work without provisioning Postgres.
 *
 * It is NOT a production path: `createDatabase()` refuses to use it when
 * NODE_ENV is production.
 */
import {
  CompiledQuery,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  type Kysely,
  type DatabaseIntrospector,
} from 'kysely';
import type { PGlite } from '@electric-sql/pglite';

class PGliteConnection implements DatabaseConnection {
  constructor(private readonly client: PGlite) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.client.query<R>(compiledQuery.sql, [...compiledQuery.parameters]);
    return {
      rows: result.rows ?? [],
      numAffectedRows: BigInt(result.affectedRows ?? 0),
    };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Streaming is not supported by the PGlite dialect.');
  }
}

class PGliteDriver implements Driver {
  private connection: PGliteConnection;

  constructor(private readonly client: PGlite) {
    this.connection = new PGliteConnection(client);
  }

  async init(): Promise<void> {
    await this.client.waitReady;
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('BEGIN'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('COMMIT'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'));
  }

  async releaseConnection(): Promise<void> {
    /* single in-process connection — nothing to release */
  }

  async destroy(): Promise<void> {
    await this.client.close();
  }
}

export class PGliteDialect implements Dialect {
  constructor(private readonly client: PGlite) {}

  createAdapter(): PostgresAdapter {
    return new PostgresAdapter();
  }

  createDriver(): Driver {
    return new PGliteDriver(this.client);
  }

  createQueryCompiler(): PostgresQueryCompiler {
    return new PostgresQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }
}
