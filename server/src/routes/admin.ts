/**
 * Administrator routes (Phase 1 subset).
 *
 * Every route below is guarded by a database-backed platform role. A customer —
 * including an organization owner — receives 403 regardless of anything their
 * browser claims. Phase 3 adds payment review, plan and bank administration on
 * the same guard foundation.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePlatformCapability } from '../guards/platform.js';
import { setUserStatus, toPublicUser } from '../services/userService.js';
import { listAuditLogs } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import type { PlatformRole, UserStatus } from '../db/schema.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(200).optional(),
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const context = (request: { ip: string; headers: Record<string, unknown> }) => ({
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  });

  /* ── Who am I (administrator view) ────────────────────────────────────── */
  app.get('/api/admin/me', { preHandler: requirePlatformCapability('view-admin') }, async (request, reply) => {
    const { user, platformRoles } = request.principal!;
    return reply.send({ user: toPublicUser(user, platformRoles) });
  });

  /* ── Users ────────────────────────────────────────────────────────────── */
  app.get('/api/admin/users', { preHandler: requirePlatformCapability('view-admin') }, async (request, reply) => {
    const query = listQuerySchema.parse(request.query ?? {});

    let statement = app.db.selectFrom('users').selectAll().orderBy('created_at', 'desc');
    if (query.search) {
      // Parameterized by Kysely — the value is never interpolated into SQL.
      statement = statement.where('normalized_email', 'like', `%${query.search.toLowerCase()}%`);
    }
    const rows = await statement.limit(query.limit).offset(query.offset).execute();

    const roleRows = rows.length
      ? await app.db
          .selectFrom('platform_user_roles')
          .select(['user_id', 'role'])
          .where('user_id', 'in', rows.map((r) => r.id))
          .execute()
      : [];

    const rolesByUser = new Map<string, PlatformRole[]>();
    for (const row of roleRows) {
      rolesByUser.set(row.user_id, [...(rolesByUser.get(row.user_id) ?? []), row.role]);
    }

    return reply.send({
      users: rows.map((user) => toPublicUser(user, rolesByUser.get(user.id) ?? [])),
      pagination: { limit: query.limit, offset: query.offset, count: rows.length },
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/admin/users/:id',
    { preHandler: requirePlatformCapability('view-admin') },
    async (request, reply) => {
      const user = await app.db.selectFrom('users').selectAll().where('id', '=', request.params.id).executeTakeFirst();
      if (!user) throw errors.notFound('User');
      const roles = await app.db
        .selectFrom('platform_user_roles')
        .select('role')
        .where('user_id', '=', user.id)
        .execute();
      return reply.send({ user: toPublicUser(user, roles.map((r) => r.role)) });
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/admin/users/:id/status',
    { preHandler: requirePlatformCapability('manage-users') },
    async (request, reply) => {
      const body = z
        .object({ status: z.enum(['active', 'disabled', 'locked', 'pending_verification']) })
        .parse(request.body);
      const actor = request.principal!;

      if (actor.user.id === request.params.id && body.status !== 'active') {
        throw errors.validation('You cannot disable your own account.');
      }

      const updated = await setUserStatus(app.db, request.params.id, body.status as UserStatus, {
        ...context(request),
        actorUserId: actor.user.id,
        actorPlatformRole: actor.platformRoles[0] ?? null,
      });
      return reply.send({ user: toPublicUser(updated) });
    },
  );

  /* ── Organizations ────────────────────────────────────────────────────── */
  app.get('/api/admin/organizations', { preHandler: requirePlatformCapability('view-admin') }, async (request, reply) => {
    const query = listQuerySchema.parse(request.query ?? {});
    const rows = await app.db
      .selectFrom('organizations')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(query.limit)
      .offset(query.offset)
      .execute();
    return reply.send({
      organizations: rows,
      pagination: { limit: query.limit, offset: query.offset, count: rows.length },
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/admin/organizations/:id',
    { preHandler: requirePlatformCapability('view-admin') },
    async (request, reply) => {
      const organization = await app.db
        .selectFrom('organizations')
        .selectAll()
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!organization) throw errors.notFound('Organization');

      const members = await app.db
        .selectFrom('organization_memberships')
        .innerJoin('users', 'users.id', 'organization_memberships.user_id')
        .select([
          'organization_memberships.role',
          'organization_memberships.status',
          'users.id as user_id',
          'users.email',
          'users.full_name',
        ])
        .where('organization_memberships.organization_id', '=', organization.id)
        .execute();

      return reply.send({ organization, members });
    },
  );

  /* ── Audit trail ──────────────────────────────────────────────────────── */
  app.get('/api/admin/audit-logs', { preHandler: requirePlatformCapability('view-admin') }, async (request, reply) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query ?? {});
    return reply.send({ entries: await listAuditLogs(app.db, { limit: query.limit }) });
  });
}
