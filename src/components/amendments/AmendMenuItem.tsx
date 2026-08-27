/**
 * The `Amend posted document` menu entry, and the drawer it opens.
 *
 * One component rather than a block copied into four screens, so the action's
 * wording, its disabled reasons and the drawer it opens cannot drift apart
 * between Invoices, Bills and Credit Notes.
 *
 * A disabled entry is DRAWN, with the reason, rather than hidden. "Why can I
 * not correct this?" is the question an operator actually has, and a menu that
 * simply omits the action answers it with silence — sending them to void the
 * document instead, which is usually the wrong correction.
 */
import { useState } from 'react';
import { FileEdit } from 'lucide-react';
import type { AmendableDocumentType } from '@/types/documentAmendment';
import { MenuItem } from '@/components/ui/Dropdown';
import { useAmendmentAction } from './useAmendmentAction';
import { AmendDocumentDrawer } from './AmendDocumentDrawer';

interface Props {
  documentType: AmendableDocumentType;
  documentId: string;
  onAmended?: (replacementId: string) => void;
}

export function AmendMenuItem({ documentType, documentId, onAmended }: Props) {
  const action = useAmendmentAction(documentType, documentId);
  const [open, setOpen] = useState(false);

  if (!action.visible) return null;

  return (
    <>
      <MenuItem
        icon={FileEdit}
        onClick={() => { if (!action.disabled) setOpen(true); }}
        disabled={action.disabled}
      >
        Amend posted document
      </MenuItem>
      {action.disabled && action.reason && (
        <p className="px-2.5 pb-1.5 text-[11px] leading-snug text-amber-600 dark:text-amber-300">
          {action.reason}
        </p>
      )}
      {open && action.assessment && (
        <AmendDocumentDrawer
          open
          documentType={documentType}
          documentId={documentId}
          assessment={action.assessment}
          onClose={() => setOpen(false)}
          onAmended={onAmended}
        />
      )}
    </>
  );
}
