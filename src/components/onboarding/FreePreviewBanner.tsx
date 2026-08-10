/**
 * Persistent Free Preview banner shown inside the accounting application.
 *
 * It carries the two facts a preview customer needs at all times: their work is
 * temporary, and their subscription is being verified. Both actions lead OUT of
 * the preview and toward activation — the payment surfaces that the old lockout
 * made the only destination are still one click away, they are simply no longer
 * a place the customer cannot leave.
 */
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { FREE_PREVIEW_COPY } from '@/lib/freePreview';
import { useIsFreePreview } from '@/store/freePreviewAccess';
import { useOrganizationStore } from '@/store/organizationStore';
import { useRouterStore } from '@/store/routerStore';
import { ROUTES } from '@/lib/accessControl';

export function FreePreviewBanner() {
  const isPreview = useIsFreePreview();
  const status = useOrganizationStore((s) => s.subscription?.status ?? null);
  const navigate = useRouterStore((s) => s.navigate);

  if (!isPreview) return null;

  return (
    <div
      role="status"
      data-testid="free-preview-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-brand-200 bg-brand-50 px-4 py-2 text-xs text-brand-900 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-100"
    >
      <Info className="h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">{FREE_PREVIEW_COPY.banner}</p>
      {status === 'pending_verification' && (
        <Badge tone="amber">{FREE_PREVIEW_COPY.pendingVerification}</Badge>
      )}
      {/*
        The payment funnel must stay one click away. Package confirmation now
        lands the customer on the dashboard, so this is where they come back for
        the bank details and the payment reference: the remittance page while
        payment is still due, the review status once proof is in.
      */}
      <Button
        size="sm"
        onClick={() =>
          navigate(status === 'pending_payment' ? ROUTES.billingPayment : ROUTES.subscriptionStatus)
        }
      >
        {FREE_PREVIEW_COPY.paymentStatus}
      </Button>
    </div>
  );
}
