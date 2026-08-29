/**
 * Every chart of accounts mutation, whichever engine the books are on.
 *
 * ══ Why the screens call THIS and not the store ══════════════════════════════
 *
 * A screen that calls `useStore.addAccount` writes to the browser. That was
 * correct while the browser held the books and is now the bug: for a subscriber
 * it produces an account that exists on their screen, in their cache, and
 * nowhere in their books. The gateway is the one door, and the stores refuse a
 * direct write while the server owns the books — so a screen that forgets gets
 * a refusal rather than a silent local save.
 *
 * ══ On the server engine, a failure is a FAILURE ═════════════════════════════
 *
 * There is no local fallback. Offline, refused, conflicted — the result says so
 * and nothing is written anywhere. Writing to the cache "so the user does not
 * lose their work" would show a saved account that the next hydration silently
 * deletes, which is worse than the error it was avoiding.
 */
import type { AccountType } from '@/types';
import type { AccountFormValues } from '@/lib/validation';
import { accountingApi } from '@/services/api/accountingApi';
import { ApiError } from '@/services/api/client';
import { useStore, type ActionResult } from '@/store/useStore';
import { booksEngine } from './booksEngine';
import { refreshBooks } from './booksHydration';
import { ledgerTypeFor, toServerAccountInput } from './accountMapping';

/** An API failure as the result shape every caller already handles. */
function failure(error: unknown, fallback: string): ActionResult {
  if (error instanceof ApiError) {
    /*
     * A conflict is the interesting one: a duplicate code, or an account with
     * postings behind it. The server's message names which, and it is the
     * message the bookkeeper needs — not a generic "could not save".
     */
    return { ok: false, error: error.message || fallback };
  }
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

export async function createAccount(
  values: AccountFormValues,
  parentId: string | null,
  options: { cashClassification?: string } = {},
): Promise<ActionResult> {
  if (booksEngine() !== 'server') {
    return useStore.getState().addAccount(values, parentId);
  }
  try {
    const account = await accountingApi.create(
      toServerAccountInput(values, { parentId, cashClassification: options.cashClassification }),
    );
    await refreshBooks();
    return { ok: true, id: account.id };
  } catch (error) {
    return failure(error, 'Could not create the account.');
  }
}

export async function updateAccount(
  id: string,
  values: AccountFormValues,
  options: { cashClassification?: string } = {},
): Promise<ActionResult> {
  if (booksEngine() !== 'server') {
    return useStore.getState().updateAccount(id, values);
  }
  try {
    /*
     * `parentId` is deliberately part of the patch: the form offers a parent,
     * and omitting it would make re-parenting silently impossible while
     * appearing to succeed.
     */
    await accountingApi.updateAccount(
      id,
      toServerAccountInput(values, {
        parentId: values.parentId,
        cashClassification: options.cashClassification,
      }),
    );
    await refreshBooks();
    return { ok: true, id };
  } catch (error) {
    return failure(error, 'Could not save the account.');
  }
}

/**
 * Deactivate or reactivate. Never a delete.
 *
 * The distinction is the server's and it is enforced there; this is the path a
 * screen takes when it means "stop offering this account", which is what the
 * overwhelming majority of "delete this account" clicks actually want.
 */
export async function setAccountActive(id: string, isActive: boolean): Promise<ActionResult> {
  if (booksEngine() !== 'server') {
    useStore.getState().setActive(id, isActive);
    return { ok: true, id };
  }
  try {
    await accountingApi.updateAccount(id, { active: isActive });
    await refreshBooks();
    return { ok: true, id };
  } catch (error) {
    return failure(error, 'Could not change the account.');
  }
}

/**
 * Delete an account that has never been used.
 *
 * The server refuses the moment a journal line references it and says to
 * deactivate instead. That refusal is passed through verbatim: it is the
 * correct answer and it explains the alternative.
 */
export async function deleteAccount(id: string): Promise<ActionResult> {
  if (booksEngine() !== 'server') {
    return useStore.getState().deleteAccount(id, false);
  }
  try {
    await accountingApi.deleteAccount(id);
    await refreshBooks();
    return { ok: true, id };
  } catch (error) {
    return failure(error, 'Could not delete the account.');
  }
}

/**
 * Put one parent's children in a given order.
 *
 * The whole sequence travels, so a retry reproduces the same chart instead of
 * performing a second swap. The sequence is worked out from the chart being
 * DISPLAYED, which is the chart the server last returned.
 *
 * Not exported: the two ways a person actually reorders — the arrows and a drag
 * — are below, and both have to resolve the intent against the visible order
 * first. An exported "set this sequence" would be an invitation to send one
 * built from something else.
 */
async function reorderSiblings(
  parentId: string | null,
  orderedIds: readonly string[],
): Promise<ActionResult> {
  if (booksEngine() !== 'server') {
    /* The browser store reorders by dragging one account onto another. */
    return { ok: true };
  }
  try {
    await accountingApi.reorderAccounts(parentId, orderedIds);
    await refreshBooks();
    return { ok: true };
  } catch (error) {
    return failure(error, 'Could not reorder the accounts.');
  }
}

/**
 * Move an account one place among its siblings.
 *
 * Resolved into a full ordering here rather than sent as a direction, because
 * "up" is only meaningful against a particular arrangement — and the one the
 * user is looking at is the one that must be preserved.
 */
export async function moveAccount(id: string, direction: 'up' | 'down'): Promise<ActionResult> {
  if (booksEngine() !== 'server') {
    useStore.getState().moveAccount(id, direction);
    return { ok: true, id };
  }
  const chart = useStore.getState().accounts;
  const account = chart.find((candidate) => candidate.id === id);
  if (!account) return { ok: false, error: 'That account is no longer in the chart.' };

  const siblings = chart
    .filter((candidate) => candidate.parentId === account.parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));

  const index = siblings.findIndex((candidate) => candidate.id === id);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= siblings.length) return { ok: true, id };

  const ordered = siblings.map((candidate) => candidate.id);
  [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
  return reorderSiblings(account.parentId, ordered);
}

/**
 * Drag-and-drop reordering: put `draggedId` where `targetId` currently sits.
 *
 * The browser store did this with its own sibling arithmetic. Here the new
 * sequence is worked out from the chart ON SCREEN and sent whole, because that
 * arrangement is the one the user was looking at when they dropped — deriving
 * it server-side from two ids would need the server to guess the same order the
 * screen happened to show.
 */
export async function reorderByDrop(draggedId: string, targetId: string): Promise<ActionResult> {
  const chart = useStore.getState().accounts;
  const dragged = chart.find((account) => account.id === draggedId);
  const target = chart.find((account) => account.id === targetId);
  if (!dragged || !target) return { ok: false, error: 'Account not found.' };
  if (dragged.parentId !== target.parentId) {
    return { ok: false, error: 'Drag-reordering is only supported between siblings.' };
  }

  if (booksEngine() !== 'server') {
    return useStore.getState().reorderSibling(draggedId, targetId);
  }

  const siblings = chart
    .filter((account) => account.parentId === dragged.parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));

  const without = siblings.filter((account) => account.id !== draggedId).map((a) => a.id);
  const at = without.indexOf(targetId);
  if (at < 0) return { ok: false, error: 'Account not found.' };
  without.splice(at, 0, draggedId);
  return reorderSiblings(dragged.parentId, without);
}

/**
 * The inline edit on a chart row: code, name and presentation class.
 *
 * A partial patch rather than a whole form, because that is what the row
 * offers. Sending the untouched fields back as well would mean an inline rename
 * could silently revert an IFRS category somebody had changed in the drawer
 * since the row was rendered.
 */
export async function renameAccount(
  id: string,
  patch: { code?: string; name?: string; type?: AccountType },
): Promise<ActionResult> {
  if (booksEngine() !== 'server') {
    return useStore.getState().quickUpdate(id, {
      ...(patch.code !== undefined ? { code: patch.code } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
    });
  }
  try {
    await accountingApi.updateAccount(id, {
      ...(patch.code !== undefined ? { accountCode: patch.code } : {}),
      ...(patch.name !== undefined ? { accountName: patch.name } : {}),
      /* Both classifications move together: the ledger type decides the sign of
       * every balance, and letting the presentation change alone would leave an
       * account presented as a finance cost and posted as income. */
      ...(patch.type !== undefined
        ? { accountType: ledgerTypeFor(patch.type), presentationType: patch.type }
        : {}),
    });
    await refreshBooks();
    return { ok: true, id };
  } catch (error) {
    return failure(error, 'Could not save the account.');
  }
}

/**
 * Copy an account as a new sibling.
 *
 * The code is the one thing that CANNOT be copied — it is unique within the
 * company — so a free one is found by incrementing, exactly as the browser
 * store did. The server refuses a clash anyway; this is what stops the user
 * meeting that refusal for a button whose whole purpose is to succeed.
 */
export async function duplicateAccount(id: string): Promise<ActionResult> {
  if (booksEngine() !== 'server') return useStore.getState().duplicateAccount(id);

  const chart = useStore.getState().accounts;
  const source = chart.find((account) => account.id === id);
  if (!source) return { ok: false, error: 'Account not found.' };

  const used = new Set(chart.map((account) => account.code));
  let candidate = source.code;
  const numeric = Number(source.code);
  if (Number.isNaN(numeric)) {
    candidate = `${source.code}-copy`;
  } else {
    let next = numeric;
    do { next += 1; candidate = String(next); } while (used.has(candidate));
  }

  try {
    const created = await accountingApi.create({
      accountCode: candidate,
      accountName: `${source.name} (copy)`,
      accountType: ledgerTypeFor(source.type),
      presentationType: source.type,
      normalBalance: source.normalBalance.toLowerCase() as 'debit' | 'credit',
      parentAccountId: source.parentId,
      ifrsStatement: source.ifrsStatement,
      ifrsCategory: source.ifrsCategory,
      ifrsSubcategory: source.ifrsSubcategory,
      cashFlowCategory: source.cashFlowCategory,
      description: source.description,
      industryTag: source.industryTag,
      /* A copy is a leaf: it has no children, whatever the source had. */
      isPostable: true,
      active: source.isActive,
      /*
       * The cash classification is deliberately NOT copied. Two accounts both
       * classified as cash would count the same balance twice the moment the
       * copy was posted to, and a duplicate is a new account that nobody has
       * yet decided anything about.
       */
    });
    await refreshBooks();
    return { ok: true, id: created.id };
  } catch (error) {
    return failure(error, 'Could not duplicate the account.');
  }
}
