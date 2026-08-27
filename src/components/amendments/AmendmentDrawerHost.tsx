/**
 * The one place the amendment drawer is actually rendered on a page.
 *
 * Mounted OUTSIDE the table and its Actions dropdowns, so closing a menu cannot
 * take the drawer with it. See `store/amendmentDrawerStore` for why that
 * matters — it is the defect that made the workflow unreachable from every list
 * page.
 *
 * The assessment is re-read here rather than carried from the menu: between the
 * click and the drawer opening the document may have been settled or amended in
 * another tab, and the drawer must open against what is true now. If it has
 * become ineligible in that window, the host closes rather than opening a
 * workflow that would be refused at the end of it.
 */
import { useEffect } from 'react';
import { useAmendmentDrawerStore } from '@/store/amendmentDrawerStore';
import { useAmendmentAction } from './useAmendmentAction';
import { AmendDocumentDrawer } from './AmendDocumentDrawer';

export function AmendmentDrawerHost() {
  const target = useAmendmentDrawerStore((s) => s.target);
  const close = useAmendmentDrawerStore((s) => s.close);
  const action = useAmendmentAction(target?.documentType ?? 'invoice', target?.documentId);

  /*
   * A target that is no longer amendable is dropped rather than rendered as an
   * empty drawer. Effect rather than render-time so the state update is not a
   * write during another component's render.
   */
  useEffect(() => {
    if (target && (!action.assessment || action.disabled)) close();
  }, [target, action.assessment, action.disabled, close]);

  if (!target || !action.assessment || action.disabled) return null;

  return (
    <AmendDocumentDrawer
      open
      documentType={target.documentType}
      documentId={target.documentId}
      assessment={action.assessment}
      onClose={close}
    />
  );
}
