/**
 * Open a project without leaving the document you are writing.
 *
 * ── What it is NOT ───────────────────────────────────────────────────────────
 * It is not a second project model. It writes through
 * `useProjectStore.createProject` — the same canonical action the Projects page
 * uses, with the same defaults, the same audit trail and the same permission
 * gate — and the code it proposes is checked with the canonical
 * `checkDuplicateProjectCode`. Anything it does not ask for comes from the
 * store's own `defaultProject`, so the record can be opened and completed on
 * the Projects page afterwards.
 *
 * ── Status ───────────────────────────────────────────────────────────────────
 * The new project is left in the store's default `planning` status rather than
 * being force-activated. `isProjectActiveOnDate` treats `planning` as usable on
 * a transaction, so it is immediately selectable — and claiming an activation
 * the user never performed would put a project into a state the Projects page
 * has its own validation for.
 *
 * ── Layering ─────────────────────────────────────────────────────────────────
 * Rendered in a portal ABOVE the host drawer, and it never submits or closes
 * that drawer: keyboard events are stopped at its own boundary, so Enter and
 * Escape reach this form and nothing behind it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Project } from '@/types/project';
import { checkDuplicateProjectCode } from '@/lib/projectValidation';
import { useProjectStore } from '@/store/projectStore';
import { PRIMARY_ENTITY_ID } from '@/data/projectSeed';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';

export interface QuickProjectDialogProps {
  open: boolean;
  /** Text the user had typed in the picker's search, seeded as the name. */
  initialName?: string;
  onCancel: () => void;
  /** Fires with the created project; the caller selects it on its own line. */
  onCreated: (project: Project) => void;
}

/** A unique, readable code derived from the name — never asked for mid-entry. */
export function suggestProjectCode(projects: readonly Project[], name: string, entityId: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const stem = `PRJ-${(letters.slice(0, 6) || 'NEW').padEnd(3, 'X')}`;
  if (!checkDuplicateProjectCode([...projects], stem, entityId)) return stem;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem}-${n}`;
    if (!checkDuplicateProjectCode([...projects], candidate, entityId)) return candidate;
  }
  return `${stem}-${Date.now()}`;
}

export function QuickProjectDialog({ open, initialName = '', onCancel, onCreated }: QuickProjectDialogProps) {
  const projects = useProjectStore((s) => s.projects);
  const createProject = useProjectStore((s) => s.createProject);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const entityId = PRIMARY_ENTITY_ID;
  const suggested = useMemo(() => suggestProjectCode(projects, name, entityId), [projects, name, entityId]);

  useEffect(() => {
    if (!open) return;
    setName(initialName.trim());
    setCode('');
    setCodeTouched(false);
    setError(null);
    const t = window.setTimeout(() => nameRef.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(t);
  }, [open, initialName]);

  const effectiveCode = codeTouched ? code : suggested;

  const submit = (): void => {
    const trimmedName = name.trim();
    const trimmedCode = effectiveCode.trim();
    if (!trimmedName) {
      setError('A project name is required.');
      return;
    }
    if (!trimmedCode) {
      setError('A project code is required.');
      return;
    }
    if (checkDuplicateProjectCode(projects, trimmedCode, entityId)) {
      setError(`Project code "${trimmedCode}" already exists in this entity.`);
      return;
    }

    const result = createProject({ entityId, code: trimmedCode, name: trimmedName });
    if (!result.ok || !result.id) {
      // Covers the permission refusal too — the store is the authority.
      setError(result.error ?? 'Could not create the project.');
      return;
    }
    const created = useProjectStore.getState().projects.find((p) => p.id === result.id);
    if (created) onCreated(created);
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[1100] flex items-start justify-center overflow-y-auto p-4 pt-24"
      role="dialog"
      aria-modal="true"
      aria-label="Add new project"
      /*
       * z-[1100] is deliberately ABOVE the portalled picker panels (z-[1000]):
       * this dialog is opened from one of them and must sit on top of it.
       *
       * Keys are contained here. Without this, Escape reaches the host drawer's
       * window listener and tears down the whole voucher, and Enter submits the
       * form behind — both of which discard the work this dialog exists to
       * avoid interrupting.
       */
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onCancel} aria-hidden />

      <div className="relative w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Add new project</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Saved to the shared project register. You can complete its budget and dates there later.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="focus-ring rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            submit();
          }}
          className="space-y-3 px-5 py-4"
        >
          <Field label="Project name" required htmlFor="quick-project-name">
            <Input
              id="quick-project-name"
              ref={nameRef}
              placeholder="e.g. Amman Office Development"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
            />
          </Field>

          <Field label="Project code" required htmlFor="quick-project-code" hint="Suggested from the name">
            <Input
              id="quick-project-code"
              className="font-mono"
              value={effectiveCode}
              onChange={(e) => {
                setCodeTouched(true);
                setCode(e.target.value);
                if (error) setError(null);
              }}
            />
          </Field>

          {error && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || !effectiveCode.trim()}>
              Save project
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
