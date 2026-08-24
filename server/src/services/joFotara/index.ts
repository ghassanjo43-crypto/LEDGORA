/**
 * JoFotara integration.
 *
 * ══ There is no real client here, and that is deliberate ═════════════════════
 *
 * You asked for this module to "export both real and mock". Only the mock
 * exists, because ISTD's technical specification is not in hand: the endpoint
 * URL, the authentication scheme, the request envelope, the error codes and the
 * signature requirements are all unknown. A stub named `submitToJoFotara` that
 * threw "not implemented" would be worse than its absence — it would appear in
 * autocomplete, get imported, and read as though the integration were wired up
 * and merely switched off.
 *
 * When the specification arrives, the real client goes in `client.ts` next to
 * this file and is exported from here. `contract.ts` is what both share, and is
 * the first thing to correct against the real documentation.
 *
 * ══ The secret must never reach the browser ══════════════════════════════════
 *
 * Whatever credentials ISTD issues (Client ID / Secret) stay server-side,
 * alongside `RESEND_API_KEY` in `config/env.ts`. They must not be added to any
 * `VITE_`-prefixed variable, which Vite inlines into the client bundle, and the
 * frontend must never call JoFotara directly.
 */
export {
  joFotaraMockRoutes,
  checkStructure,
  buildResponse,
  extractXml,
  resolveMode,
} from './mock.js';

export type {
  ClearanceStatus,
  ClearanceError,
  ClearanceResponse,
  MockMode,
} from './contract.js';

export { MOCK_MODES, isMockMode } from './contract.js';
