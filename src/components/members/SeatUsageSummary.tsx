/**
 * Seat usage, as the backend counts it.
 *
 * Every number here comes from the server — the same arithmetic the invitation
 * path enforces under its row lock, so the screen and the enforcement cannot
 * disagree. The browser never recomputes the limit and never enforces it: a
 * seat can be taken by another administrator between this render and the next
 * invitation, which is why the invite dialog still has to handle a 409.
 */
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import type { SeatUsage } from '@/services/api/memberApi';

export function SeatUsageSummary({ seats }: { seats: SeatUsage }) {
  const unlimited = seats.seatLimit === null;

  return (
    <div
      className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
      data-testid="seat-usage"
    >
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <Stat label="Seats included" value={unlimited ? 'Unlimited' : String(seats.seatLimit)} testId="seat-limit" />
        <Stat label="Seats consumed" value={String(seats.seatsUsed)} testId="seats-used" />
        <Stat label="Pending invitations" value={String(seats.pendingInvitations)} testId="seats-pending" />
        <Stat
          label="Seats remaining"
          value={unlimited ? 'Unlimited' : String(seats.seatsRemaining)}
          testId="seats-remaining"
          tone={seats.atLimit ? 'red' : 'green'}
        />
      </div>

      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400" data-testid="seat-rule">
        Active members and pending invitations each reserve a seat. Suspending or removing a member
        releases theirs.
      </p>

      {seats.atLimit && (
        <div data-testid="seat-limit-reached">
          <Alert variant="warning" className="mt-2">
            Every seat on this plan is in use. Free one by suspending or removing a member or cancelling a
            pending invitation, or upgrade the package to add more.
          </Alert>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  testId,
  tone = 'slate',
}: {
  label: string;
  value: string;
  testId: string;
  tone?: 'slate' | 'green' | 'red';
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5">
        <Badge tone={tone}>
          <span data-testid={testId}>{value}</span>
        </Badge>
      </div>
    </div>
  );
}
