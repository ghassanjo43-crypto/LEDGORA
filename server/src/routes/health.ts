/**
 * Health endpoint for Render's health check.
 *
 * Reports liveness and database reachability only. It never reveals
 * configuration, versions of dependencies, connection strings or secrets, and
 * is deliberately unauthenticated so the platform can poll it.
 */
import type { FastifyInstance } from 'fastify';
import { pingDatabase } from '../db/index.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (_request, reply) => {
    const databaseReachable = await pingDatabase(app.db);
    const status = databaseReachable ? 'ok' : 'degraded';
    return reply.code(databaseReachable ? 200 : 503).send({
      status,
      database: databaseReachable ? 'up' : 'down',
      timestamp: new Date().toISOString(),
    });
  });
}
