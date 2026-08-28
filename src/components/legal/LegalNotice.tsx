/**
 * The one-line legal notice shown under a sign-in or registration form.
 *
 * ── Why it can render nothing ────────────────────────────────────────────────
 *
 * A link to a document that has not been published leads to "not yet
 * published", which is a worse experience than no link and reads as a broken
 * product. So the notice appears only when the legal surface is live — every
 * document approved, dated, versioned, hash-pinned and published — and until
 * then this component renders `null`.
 *
 * That is also why there is no Privacy Policy link: Ledgora has no Privacy
 * Policy. Not a draft, not a placeholder — none. A link to one would be a dead
 * link asserting a document that does not exist, and the wording changes rather
 * than pointing at nothing. When a Privacy Policy exists, `privacyPolicyExists`
 * becomes true and the fuller sentence appears.
 *
 * ── Not consent ──────────────────────────────────────────────────────────────
 *
 * This notice acknowledges; it does not record. Nothing here creates an
 * acceptance, and reading a page or signing in is never treated as agreement —
 * acceptance is a separate, deliberate act on the review screen.
 */
import { ROUTES } from '@/lib/accessControl';
import { legalSurfaceIsLive } from '@/lib/legalDocuments';
import { useRouterStore } from '@/store/routerStore';

/**
 * Ledgora has no Privacy Policy yet.
 *
 * A single named constant rather than a scattered condition, so the day one is
 * written there is exactly one place to change — and so this file states the
 * fact rather than leaving a reader to infer it from an absent link.
 */
export const privacyPolicyExists = false;

export function LegalNotice({ className }: { className?: string }) {
  const navigate = useRouterStore((s) => s.navigate);
  if (!legalSurfaceIsLive()) return null;

  const termsLink = (
    <a
      href={ROUTES.terms}
      onClick={(e) => { e.preventDefault(); navigate(ROUTES.terms); }}
      className="focus-ring rounded font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
    >
      Terms and Conditions
    </a>
  );

  return (
    <p
      data-testid="legal-notice"
      className={className ?? 'mt-4 text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400'}
    >
      {privacyPolicyExists ? (
        <>By using Ledgora, you acknowledge our {termsLink} and Privacy Policy.</>
      ) : (
        /* No Privacy Policy exists, so the sentence does not claim one. */
        <>Review the Ledgora {termsLink}.</>
      )}
    </p>
  );
}
