/**
 * Who may see a legal document that is still a DRAFT.
 *
 * ══ Why drafts are not public ════════════════════════════════════════════════
 *
 * A public `/terms` page carrying "[UNRESOLVED — governing Emirate and
 * competent court]" is worse than a missing page. A reader has no way to know
 * it is not the deal, a competitor reads the commercial terms before they are
 * settled, and a customer could later argue they relied on it. So the public
 * production route serves only documents that pass every publication condition,
 * and says plainly that the rest are not yet published.
 *
 * ══ Who may preview, and why those two ═══════════════════════════════════════
 *
 *   · a LOCAL DEVELOPMENT build — the person running the code is the person
 *     drafting it, and `platformAdminToolsAllowed` is the existing, explicit
 *     opt-in this codebase already uses for exactly that judgement;
 *   · a verified platform SUPER ADMIN — the operator who has to review the text
 *     before approving it. This reuses `effectivePlatformRole`, which is
 *     backend-verified in production, so a tenant planting a value in browser
 *     storage resolves to `'none'` and sees nothing.
 *
 * A preview is READ-ONLY by construction: this module grants sight of text and
 * nothing else. It cannot create an acceptance record and it cannot affect
 * whether the acceptance gate blocks anybody, because neither of those consults
 * it — `evaluateAcceptance` keys off `publicationReadiness`, which a preview
 * does not change.
 */
import { effectivePlatformRole, platformAdminToolsAllowed } from '@/lib/platformAccess';
import { platformRoleHasCapability } from '@/types/roles';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';

/**
 * May the current viewer see unpublished drafts?
 *
 * Fail-closed: anything other than a development build or a verified
 * super-admin gets `false`, including an ordinary signed-in subscriber owner.
 */
export function canPreviewLegalDrafts(): boolean {
  if (platformAdminToolsAllowed()) return true;
  const role = effectivePlatformRole(
    useSessionStore.getState().platformRole,
    useBackendSessionStore.getState().platformRoles,
  );
  return platformRoleHasCapability(role, 'manage-any-organization');
}

/** The banner a preview MUST carry, so a draft can never be mistaken for terms. */
export const DRAFT_PREVIEW_NOTICE =
  'DRAFT — NOT IN FORCE. This text has not been approved by counsel or approved for publication, '
  + 'it contains unresolved items, and it binds nobody. It is shown for review only. '
  + 'No acceptance is recorded from this screen.';
