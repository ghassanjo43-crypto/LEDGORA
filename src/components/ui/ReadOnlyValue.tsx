/**
 * A value the user may read but not change.
 *
 * ── Why not a disabled input ────────────────────────────────────────────────
 * A disabled `<input>` looks like a control that is temporarily unavailable —
 * it invites the user to look for the thing that would enable it. These values
 * are not unavailable, they are simply not decisions: an ordinary transaction's
 * currency comes from the company, and no amount of clicking will change it
 * here. Rendering plain text says that, and a disabled field does not.
 *
 * It also removes the control from the form entirely. A disabled input is still
 * an input — re-enabled with one devtools attribute change — so a form built
 * from these has nothing for that trick to re-enable.
 */
import type { ReactNode } from 'react';

export interface ReadOnlyValueProps {
  children: ReactNode;
  /** Optional short note, e.g. why the value cannot be changed. */
  hint?: string;
  'data-testid'?: string;
}

export function ReadOnlyValue({ children, hint, ...rest }: ReadOnlyValueProps) {
  return (
    <div>
      <div
        // Matches the height and padding of Input so a mixed row stays aligned.
        className="rounded-lg border border-transparent bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900 dark:bg-slate-800/60 dark:text-slate-100"
        data-testid={rest['data-testid']}
      >
        {children}
      </div>
      {hint && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}
