/**
 * The `Amend posted document` menu entry.
 *
 * One component rather than a block copied into four screens, so the action's
 * wording, its disabled reasons and the drawer it opens cannot drift apart
 * between Invoices, Bills and Credit Notes.
 *
 * ── The reason lives INSIDE the item ─────────────────────────────────────────
 * It used to be a sibling paragraph after the item. That is how a disabled
 * action ended up with its explanation somewhere else — and in a menu that
 * scrolls, sometimes nowhere the reader would look. The reason is part of the
 * control now: same element, plus a `title` so a pointer gets it as a tooltip
 * too. An explanation that can be separated from the thing it explains will be.
 *
 * ── The drawer is NOT rendered here ──────────────────────────────────────────
 * It cannot be. This item sits inside a dropdown panel that closes — and
 * unmounts — on any click within it, so a drawer owned here would be destroyed
 * by the very click that opened it. The request goes to
 * `store/amendmentDrawerStore` and the page's `AmendmentDrawerHost` renders it.
 */
import { FileEdit } from 'lucide-react';
import type { AmendableDocumentType } from '@/types/documentAmendment';
import { MenuItem } from '@/components/ui/Dropdown';
import { useAmendmentDrawerStore } from '@/store/amendmentDrawerStore';
import { useAmendmentAction } from './useAmendmentAction';

interface Props {
  documentType: AmendableDocumentType;
  documentId: string;
}

export function AmendMenuItem({ documentType, documentId }: Props) {
  const action = useAmendmentAction(documentType, documentId);
  const requestOpen = useAmendmentDrawerStore((s) => s.requestOpen);

  if (!action.visible) return null;

  return (
    <MenuItem
      icon={FileEdit}
      disabled={action.disabled}
      title={action.disabled ? action.reason : undefined}
      onClick={() => { if (!action.disabled) requestOpen(documentType, documentId); }}
    >
      <span className="block">Amend posted document</span>
      {action.disabled && (
        <span
          data-testid="amend-disabled-reason"
          className="mt-0.5 block whitespace-normal text-[11px] font-normal leading-snug text-amber-600 dark:text-amber-300"
        >
          {action.reason}
        </span>
      )}
    </MenuItem>
  );
}
