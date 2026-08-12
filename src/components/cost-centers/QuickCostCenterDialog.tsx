/**
 * Open a cost center without leaving the document you are writing.
 *
 * ── What it is NOT ───────────────────────────────────────────────────────────
 * Not a second cost-center model. It writes through
 * `useCostCenterStore.createCostCenter` and then `activateCostCenter` — the
 * same canonical actions the Cost Centers page uses, with the same hierarchy
 * recomputation, the same audit trail and the same permission gate.
 *
 * ── Why it activates, when the project dialog does not ──────────────────────
 * The two modules disagree about what a fresh record is for, and the pickers
 * follow them: a `planning` project is already usable on a transaction, but
 * `CostCenterPicker` only offers ACTIVE centers. A cost center left at the
 * store's default `inactive` would therefore be created and then be unselectable
 * — the picker would refuse the thing the user just made. So creation is
 * followed by the canonical `activateCostCenter`, which runs
 * `validateCostCenterForActivation` rather than writing the status directly; if
 * that validation refuses, the refusal is shown instead of a half-made record
 * being silently left behind.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { CostCenter, CostCenterType } from '@/types/costCenter';
import { checkDuplicateCostCenterCode } from '@/lib/costCenterHierarchy';
import { useCostCenterStore } from '@/store/costCenterStore';
import { PRIMARY_ENTITY_ID } from '@/data/costCenterSeed';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

/** Only the types the canonical model already has. Nothing is invented. */
const TYPE_OPTIONS: Array<{ value: CostCenterType; label: string }> = [
  { value: 'operating', label: 'Operating' },
  { value: 'administrative', label: 'Administrative' },
  { value: 'sales', label: 'Sales' },
  { value: 'production', label: 'Production' },
  { value: 'service', label: 'Service' },
  { value: 'support', label: 'Support' },
  { value: 'shared', label: 'Shared' },
  { value: 'corporate', label: 'Corporate' },
];

export interface QuickCostCenterDialogProps {
  open: boolean;
  initialName?: string;
  onCancel: () => void;
  onCreated: (costCenter: CostCenter) => void;
}

export function suggestCostCenterCode(centers: readonly CostCenter[], name: string, entityId: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const stem = `CC-${(letters.slice(0, 6) || 'NEW').padEnd(3, 'X')}`;
  if (!checkDuplicateCostCenterCode([...centers], stem, entityId)) return stem;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem}-${n}`;
    if (!checkDuplicateCostCenterCode([...centers], candidate, entityId)) return candidate;
  }
  return `${stem}-${Date.now()}`;
}

export function QuickCostCenterDialog({ open, initialName = '', onCancel, onCreated }: QuickCostCenterDialogProps) {
  const costCenters = useCostCenterStore((s) => s.costCenters);
  const createCostCenter = useCostCenterStore((s) => s.createCostCenter);
  const activateCostCenter = useCostCenterStore((s) => s.activateCostCenter);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [type, setType] = useState<CostCenterType>('operating');
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const entityId = PRIMARY_ENTITY_ID;
  const suggested = useMemo(() => suggestCostCenterCode(costCenters, name, entityId), [costCenters, name, entityId]);

  useEffect(() => {
    if (!open) return;
    setName(initialName.trim());
    setCode('');
    setCodeTouched(false);
    setType('operating');
    setError(null);
    const t = window.setTimeout(() => nameRef.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(t);
  }, [open, initialName]);

  const effectiveCode = codeTouched ? code : suggested;

  const submit = (): void => {
    const trimmedName = name.trim();
    const trimmedCode = effectiveCode.trim();
    if (!trimmedName) return setError('A cost-center name is required.');
    if (!trimmedCode) return setError('A cost-center code is required.');
    if (checkDuplicateCostCenterCode(costCenters, trimmedCode, entityId)) {
      return setError(`Cost-center code "${trimmedCode}" already exists in this entity.`);
    }

    const created = createCostCenter({ entityId, code: trimmedCode, name: trimmedName, type });
    if (!created.ok || !created.id) {
      // Covers the permission refusal — the store is the authority.
      return setError(created.error ?? 'Could not create the cost center.');
    }

    // Canonical activation, so the picker can actually offer what was made.
    const activated = activateCostCenter(created.id);
    if (!activated.ok) return setError(activated.error ?? 'The cost center was created but could not be activated.');

    const record = useCostCenterStore.getState().costCenters.find((c) => c.id === created.id);
    if (record) onCreated(record);
    return undefined;
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[1100] flex items-start justify-center overflow-y-auto p-4 pt-24"
      role="dialog"
      aria-modal="true"
      aria-label="Add new cost center"
      /* Above the z-[1000] picker panel that opened it; keys contained here. */
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
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Add new cost center</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Saved to the shared hierarchy and activated so it can be used straight away.
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
          <Field label="Cost-center name" required htmlFor="quick-cc-name">
            <Input
              id="quick-cc-name"
              ref={nameRef}
              placeholder="e.g. Amman Marketing"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Code" required htmlFor="quick-cc-code" hint="Suggested from the name">
              <Input
                id="quick-cc-code"
                className="font-mono"
                value={effectiveCode}
                onChange={(e) => {
                  setCodeTouched(true);
                  setCode(e.target.value);
                  if (error) setError(null);
                }}
              />
            </Field>
            <Field label="Type" required htmlFor="quick-cc-type">
              <Select
                id="quick-cc-type"
                options={TYPE_OPTIONS}
                value={type}
                onChange={(e) => setType(e.target.value as CostCenterType)}
              />
            </Field>
          </div>

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
              Save cost center
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
