/**
 * A bill's supplier debit notes, with the amendment action on each.
 *
 * A debit note is a posted document with its own number and its own journal
 * entry, but it is not a top-level record in Ledgora — it lives on the bill it
 * corrects (`BillSupplierCredit`). There is therefore no list page to hang the
 * action off, so the bill's own view is where it belongs.
 */
import { FileEdit } from 'lucide-react';
import type { Bill } from '@/types/bill';
import { documentVersion } from '@/types/documentAmendment';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatCurrency } from '@/lib/money';
import { useAmendmentDrawerStore } from '@/store/amendmentDrawerStore';
import { useAmendmentAction } from './useAmendmentAction';

export function SupplierDebitNotesPanel({ bill }: { bill: Bill }) {
  if ((bill.supplierCredits ?? []).length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Supplier debit notes
      </p>
      <ul className="space-y-1">
        {bill.supplierCredits.map((credit) => (
          <DebitNoteRow key={credit.id} bill={bill} creditId={credit.id} />
        ))}
      </ul>
    </div>
  );
}

function DebitNoteRow({ bill, creditId }: { bill: Bill; creditId: string }) {
  const action = useAmendmentAction('supplier-debit-note', creditId);
  /* Through the store, like every other amendment entry point — the drawer is
     rendered once by the page's `AmendmentDrawerHost`, never by a row. */
  const requestOpen = useAmendmentDrawerStore((s) => s.requestOpen);
  const credit = bill.supplierCredits.find((c) => c.id === creditId);
  if (!credit) return null;

  return (
    <li className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-mono font-semibold">{credit.creditNumber}</span>
      <span className="text-slate-400">{credit.date}</span>
      <span className="font-mono">{formatCurrency(credit.amount, bill.currency)}</span>
      {documentVersion(credit) > 1 && <Badge tone="slate">v{documentVersion(credit)}</Badge>}
      {credit.supersededByDocumentId ? (
        <Badge tone="slate">superseded by {credit.supersededByDocumentNumber || '—'}</Badge>
      ) : action.visible ? (
        <Button
          size="sm"
          variant="outline"
          disabled={action.disabled}
          title={action.reason || undefined}
          onClick={() => requestOpen('supplier-debit-note', creditId)}
        >
          <FileEdit className="h-3.5 w-3.5" /> Amend
        </Button>
      ) : null}
      {action.disabled && (
        <span data-testid="amend-disabled-reason" className="w-full text-[11px] text-amber-600 dark:text-amber-300">
          {action.reason}
        </span>
      )}
    </li>
  );
}
