/**
 * The JoFotara mock as its own process, on its own port.
 *
 * Run it when you want to point a client at a clearance endpoint without
 * starting the API, its database or its migrations:
 *
 *     npm run mock:jofotara            # port 4000
 *     MOCK_JOFOTARA_PORT=4100 npm run mock:jofotara
 *
 * It shares `mock.ts` with the in-app route, so there is one implementation and
 * no chance of the two drifting into disagreeing about what a rejection looks
 * like.
 *
 * ── No auth, no database, no state ───────────────────────────────────────────
 * Deliberately. It binds LOOPBACK ONLY (127.0.0.1) because an unauthenticated
 * service that answers "CLEARED" should not be reachable from the network, and
 * the default of 0.0.0.0 that the main API uses would make it so.
 */
import Fastify from 'fastify';
import { joFotaraMockRoutes } from './mock.js';

const PORT = Number(process.env.MOCK_JOFOTARA_PORT ?? 4000);
const HOST = '127.0.0.1';

export async function startStandaloneMock(port = PORT): Promise<{ close: () => Promise<void>; port: number }> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(joFotaraMockRoutes);
  await app.listen({ port, host: HOST });

  app.log.warn(
    { mock: 'jofotara' },
    'Standalone JoFotara MOCK listening. Every verdict it returns is fabricated.',
  );
  app.log.info(
    `POST http://${HOST}:${port}/api/mock/jofotara/submit  ·  GET http://${HOST}:${port}/api/mock/jofotara/health`,
  );

  return { close: async () => app.close(), port };
}

/*
 * Run only when executed directly, never on import — importing this from a test
 * should not bind a port.
 */
const invokedDirectly = process.argv[1]?.includes('standalone');
if (invokedDirectly) {
  startStandaloneMock().catch((error: unknown) => {
    console.error('Could not start the JoFotara mock:', error);
    process.exit(1);
  });
}
