/**
 * Forced password change.
 *
 * A bootstrap administrator is provisioned from `BOOTSTRAP_ADMIN_PASSWORD`, a
 * value that by definition has been typed into a deploy dashboard and may sit in
 * its configuration history; an administrator-issued temporary credential has
 * the same problem for a different reason. The backend marks such accounts
 * `must_change_password`, and this page is the only surface reachable until the
 * credential has actually been exchanged — see `resolvePostLoginRoute` and the
 * server's `guards/passwordChange`.
 *
 * ── Same form, same endpoint, different wording ──────────────────────────────
 * This is NOT a second password-change implementation. It mounts the one
 * `ChangePasswordForm`, which posts to the one endpoint, which derives the user
 * from the session. The only things this page adds are the framing (you were
 * given a temporary password) and what happens afterwards: re-resolve where the
 * person belongs and send them there, since the whole point is that they were
 * being held here.
 */
import { CenteredCard } from '@/components/onboarding/OnboardingChrome';
import { ChangePasswordForm } from '@/components/account/ChangePasswordForm';
import { useRouterStore } from '@/store/routerStore';
import { resolvePostLoginRoute } from '@/lib/accessControl';
import { readAccessContext } from '@/lib/accessContext';

export function ChangePasswordPage() {
  const navigate = useRouterStore((s) => s.navigate);

  return (
    <CenteredCard
      title="Choose a new password"
      subtitle="Your account was created with a temporary password. Set your own before continuing."
    >
      <ChangePasswordForm
        currentPasswordLabel="Current (temporary) password"
        submitLabel="Set new password"
        busyLabel="Saving…"
        /*
         * No inline confirmation: the form has already refreshed the session by
         * the time this runs, so `mustChangePassword` is cleared and the shell
         * is about to replace this screen. A success banner would only flash.
         */
        successMessage={null}
        onSuccess={() => {
          navigate(resolvePostLoginRoute(readAccessContext()), { replace: true });
        }}
      />
    </CenteredCard>
  );
}
