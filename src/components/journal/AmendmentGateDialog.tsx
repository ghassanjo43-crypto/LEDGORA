/**
 * What stands between "Edit" and the editor, when a posted entry has
 * dependencies.
 *
 * ── Why this is a dialog and not a disabled button ───────────────────────────
 * A greyed-out Edit action tells the accountant nothing except that the
 * software has an opinion. The useful answer is which record depends on this
 * entry and what to do instead — so every dependency the assessor found is
 * listed by name, and the one available route out is offered as a button.
 *
 * Two shapes:
 *   reverse_and_replace  →  explains, and offers "Reverse & edit".
 *   blocked              →  explains, offers nothing here, and where the
 *                           correction does belong, says so.
 */
import { AlertTriangle, ArrowRight, Ban } from 'lucide-react';
import type { AmendmentAssessment } from '@/lib/journalAmendment';
import { Button } from '@/components/ui/Button';

export interface AmendmentGateDialogProps {
  assessment: AmendmentAssessment | null;
  onCancel: () => void;
  /** Proceed with reverse-and-replace. Absent when the entry is blocked. */
  onReverseAndEdit: (entryId: string) => void;
}

export function AmendmentGateDialog({ assessment, onCancel, onReverseAndEdit }: AmendmentGateDialogProps) {
  if (!assessment) return null;
  const blocked = assessment.mode === 'blocked';

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4 pt-24" role="dialog" aria-modal="true" aria-label="Correct journal entry">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onCancel} aria-hidden />

      <div className="relative w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-start gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          {blocked ? (
            <Ban className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
          ) : (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          )}
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {blocked ? `${assessment.entryNumber} cannot be corrected here` : `${assessment.entryNumber} has dependencies`}
            </h2>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{assessment.explanation}</p>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          {assessment.dependencies.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                What depends on this entry ({assessment.dependencies.length})
              </p>
              <ul className="mt-1.5 space-y-1.5">
                {assessment.dependencies.map((dependency) => (
                  <li
                    key={`${dependency.kind}-${dependency.sourceId}`}
                    className="rounded-lg border border-slate-200 px-2.5 py-2 text-xs dark:border-slate-700"
                  >
                    <span className="font-medium text-slate-700 dark:text-slate-200">{dependency.sourceLabel}</span>
                    <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      {dependency.severity === 'blocks' ? 'blocks' : 'needs reversal'}
                    </span>
                    <p className="mt-0.5 text-slate-500 dark:text-slate-400">{dependency.message}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {assessment.correctAt && (
            /* The redirect. A refusal that does not say where to go instead is
               just an obstacle. */
            <p className="flex items-start gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-2 text-xs text-brand-800 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-200">
              <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Correct this in <span className="font-semibold">{assessment.correctAt.label}</span>. The journal is
                regenerated from it, so correcting the source keeps the two in agreement.
              </span>
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">
          <Button type="button" variant="outline" onClick={onCancel}>
            {blocked ? 'Close' : 'Cancel'}
          </Button>
          {!blocked && (
            <Button type="button" onClick={() => onReverseAndEdit(assessment.entryId)}>
              Reverse &amp; edit
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
