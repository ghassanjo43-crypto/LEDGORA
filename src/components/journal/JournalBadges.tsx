import type { JournalStatus } from '@/types/journal';
import { Badge } from '@/components/ui/Badge';
import type { BadgeTone } from '@/data/ifrsOptions';

const STATUS_META: Record<JournalStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'amber' },
  posted: { label: 'Posted', tone: 'green' },
  void: { label: 'Void', tone: 'red' },
};

export function JournalStatusBadge({ status }: { status: JournalStatus }) {
  const meta = STATUS_META[status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/** Derived display status shown in the dense table (adds Pending Approval). */
export type DisplayStatus = 'posted' | 'pending' | 'draft' | 'void' | 'reversed';

const DISPLAY_META: Record<DisplayStatus, { label: string; tone: BadgeTone }> = {
  posted: { label: 'Posted', tone: 'green' },
  pending: { label: 'Pending', tone: 'violet' },
  draft: { label: 'Draft', tone: 'amber' },
  void: { label: 'Void', tone: 'red' },
  reversed: { label: 'Reversed', tone: 'slate' },
};

export function DisplayStatusBadge({ status }: { status: DisplayStatus }) {
  const meta = DISPLAY_META[status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/** Small green/red pill showing whether an entry balances. */
export function BalanceBadge({ difference }: { difference: number }) {
  const balanced = Math.abs(difference) < 0.005;
  return (
    <Badge tone={balanced ? 'green' : 'red'}>
      {balanced ? 'Balanced' : `Off by ${Math.abs(difference).toFixed(2)}`}
    </Badge>
  );
}
