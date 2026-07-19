/**
 * Development-tool switch.
 *
 * There is exactly ONE gate for development tooling, and it is
 * `platformAdminToolsAllowed()` in `lib/platformAccess`: a local dev server
 * (`import.meta.env.DEV`) plus an explicit, uncommitted
 * `VITE_LEDGORA_DEV_TOOLS=true` in `.env.local`.
 *
 * ⚠ A `localStorage` key is NOT an authorization mechanism and is deliberately
 * not consulted here — storage is entirely under the visitor's control, so in a
 * deployed build it could be set by anyone. The previous localStorage opt-in has
 * been removed for that reason.
 */
export { platformAdminToolsAllowed } from './platformAccess';
export { platformAdminToolsAllowed as devToolsEnabled } from './platformAccess';
