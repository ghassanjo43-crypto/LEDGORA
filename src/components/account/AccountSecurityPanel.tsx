/**
 * "Change password" as a self-contained settings section.
 *
 * The card, the wording and the explanation of what a password change does to
 * your other sessions — mounted identically in the platform console (super
 * administrator), in-app Settings (subscriber owner and member) and on the
 * standalone `/account/security` page. Only `ChangePasswordForm` talks to the
 * API; this is presentation around it.
 *
 * ── Deliberately not permission-gated ────────────────────────────────────────
 * Nothing here consults an entitlement, a module or a bookkeeping permission
 * such as `general_journal`. Changing your own password is an account-security
 * operation that belongs to every authenticated person by virtue of being
 * signed in, and gating it would mean a user has to ask an administrator to do
 * something only they should ever be able to do.
 */
import { KeyRound } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ChangePasswordForm } from './ChangePasswordForm';
import { useBackendSessionStore } from '@/store/backendSessionStore';

export interface AccountSecurityPanelProps {
  /** Heading override for surfaces that already say "Security" above it. */
  title?: string;
  className?: string;
}

export function AccountSecurityPanel({ title = 'Change password', className }: AccountSecurityPanelProps) {
  const user = useBackendSessionStore((s) => s.user);

  return (
    <Card className={className}>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-slate-400" aria-hidden />
            {title}
          </span>
        }
        description={
          user
            ? `Update the password for ${user.email}. You will stay signed in here; any other device signed in as you is signed out.`
            : 'Update your own account password. You will stay signed in here; any other device signed in as you is signed out.'
        }
      />
      <CardBody className="max-w-md">
        <ChangePasswordForm />
      </CardBody>
    </Card>
  );
}
