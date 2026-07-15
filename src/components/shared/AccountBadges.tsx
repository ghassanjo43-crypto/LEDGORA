import type { Account } from '@/types';
import { Badge } from '@/components/ui/Badge';
import { ACCOUNT_TYPE_META, IFRS_STATEMENT_META } from '@/data/ifrsOptions';

export function TypeBadge({ type }: { type: Account['type'] }) {
  const meta = ACCOUNT_TYPE_META[type];
  return (
    <Badge tone={meta.accent} title={`Account type: ${meta.label}`}>
      {meta.label}
    </Badge>
  );
}

export function StatementBadge({ statement }: { statement: Account['ifrsStatement'] }) {
  const meta = IFRS_STATEMENT_META[statement];
  return (
    <Badge tone={meta.tone} title={meta.label}>
      {meta.short}
    </Badge>
  );
}

export function KindBadge({ isPosting }: { isPosting: boolean }) {
  return isPosting ? (
    <Badge tone="indigo" title="Leaf account that can receive journal postings">
      Posting
    </Badge>
  ) : (
    <Badge tone="slate" title="Grouping account that rolls up its children">
      Header
    </Badge>
  );
}

export function StatusBadge({ isActive }: { isActive: boolean }) {
  return isActive ? (
    <Badge tone="green">Active</Badge>
  ) : (
    <Badge tone="red">Inactive</Badge>
  );
}

export function BalanceBadge({ normalBalance }: { normalBalance: Account['normalBalance'] }) {
  return (
    <Badge tone={normalBalance === 'DEBIT' ? 'blue' : 'amber'}>
      {normalBalance === 'DEBIT' ? 'Dr' : 'Cr'}
    </Badge>
  );
}
