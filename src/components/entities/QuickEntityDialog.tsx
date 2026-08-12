/**
 * Create a counterparty without leaving the document you are writing.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * An accountant mid-journal-entry who finds the supplier missing had two
 * options: abandon the entry and go to the directory, or type the name into a
 * memo and move on. The first loses work; the second loses the counterparty
 * from every report that groups by entity. Neither is a real choice, so the
 * create action comes to them.
 *
 * ── What it is NOT ───────────────────────────────────────────────────────────
 * It is not a second entity model. It writes an ordinary `EntityFormValues`
 * through `useEntityStore.addEntity` — the same canonical service the directory
 * uses, with the same uniqueness rules and the same permission gate — and the
 * fields it collects are `.pick`ed from `entityFormSchema` rather than restated.
 * Anything it does not ask for comes from `makeDefaultEntityValues`, so the
 * record can be opened and completed in the directory afterwards.
 *
 * ── Layering ─────────────────────────────────────────────────────────────────
 * Rendered in a portal ABOVE the host drawer, and it never unmounts or submits
 * that drawer: it stops Enter, Escape and click events at its own boundary, so
 * a keystroke meant for this form cannot reach the journal form behind it and
 * submit an entry the user was still writing.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { X } from 'lucide-react';
import type { BusinessEntity, EntityType } from '@/types';
import {
  quickEntityFormSchema,
  type QuickEntityFormValues,
} from '@/lib/entityValidation';
import {
  makeDefaultEntityValues,
  suggestEntityCode,
  useEntityStore,
} from '@/store/useEntityStore';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

/** Only the entity types Ledgora's model actually has. Nothing is invented. */
const ENTITY_TYPE_OPTIONS: Array<{ value: EntityType; label: string }> = [
  { value: 'customer', label: 'Customer' },
  { value: 'supplier', label: 'Supplier' },
  { value: 'both', label: 'Customer & supplier' },
];

export interface QuickEntityDialogProps {
  open: boolean;
  /** Text the user had typed in the picker's search, seeded as the name. */
  initialName?: string;
  onCancel: () => void;
  /** Fires with the created entity; the caller selects it on its own line. */
  onCreated: (entity: BusinessEntity) => void;
}

export function QuickEntityDialog({ open, initialName = '', onCancel, onCreated }: QuickEntityDialogProps) {
  const entities = useEntityStore((s) => s.entities);
  const addEntity = useEntityStore((s) => s.addEntity);
  const [storeError, setStoreError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const defaults = useMemo<QuickEntityFormValues>(
    () => ({
      // The search text becomes the name — the user already typed it once.
      legalName: initialName.trim(),
      entityCode: '',
      entityType: 'customer',
      contactPerson: '',
      email: '',
      phone: '',
      taxRegistrationNumber: '',
    }),
    [initialName],
  );

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<QuickEntityFormValues>({
    resolver: zodResolver(quickEntityFormSchema),
    defaultValues: defaults,
  });

  const legalName = watch('legalName');
  const entityCode = watch('entityCode');

  useEffect(() => {
    if (open) {
      reset(defaults);
      setStoreError(null);
      const t = window.setTimeout(() => nameRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open, defaults, reset]);

  /*
   * Suggest the code from the name until the user takes it over. `entityCode`
   * is required and unique, and asking an accountant to invent one mid-entry is
   * exactly the friction this dialog removes.
   */
  useEffect(() => {
    if (!open) return;
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && el.name === 'entityCode') return;
    setValue('entityCode', suggestEntityCode(entities, legalName ?? ''), { shouldValidate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, legalName]);

  const submit = (values: QuickEntityFormValues): void => {
    /*
     * The full canonical record: defaults for everything quick-create does not
     * ask about, overlaid with what it does. `addEntity` re-checks uniqueness
     * and the create permission, so this is not a privileged path.
     */
    const result = addEntity({
      ...makeDefaultEntityValues(values.entityType),
      ...values,
      legalName: values.legalName.trim(),
      entityCode: values.entityCode.trim(),
    });

    if (!result.ok || !result.id) {
      setStoreError(result.error ?? 'Could not create the entity.');
      return;
    }
    const created = useEntityStore.getState().entities.find((e) => e.id === result.id);
    if (created) onCreated(created);
  };

  if (!open) return null;

  return createPortal(
    /*
     * z-[60]: above the host drawer's z-50, so this is genuinely on top rather
     * than merely later in the DOM.
     */
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4 pt-24"
      role="dialog"
      aria-modal="true"
      aria-label="Add new entity"
      /*
       * Every keystroke is contained here. Without this, Enter reaches the
       * journal form behind and submits a half-written entry, and Escape closes
       * the drawer instead of this dialog — both of which lose the user's work.
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

      <div className="relative w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Add new entity</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Saved to the shared directory. You can complete the rest of its details there later.
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

        {/*
          A real <form>, but its submit NEVER bubbles: the journal drawer's own
          form is an ancestor in the React tree even though this renders through
          a portal, and React replays events along that tree.
        */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void handleSubmit(submit)(e);
          }}
          className="space-y-3 px-5 py-4"
        >
          <Field label="Entity type" required htmlFor="quick-entity-type">
            <Select id="quick-entity-type" options={ENTITY_TYPE_OPTIONS} {...register('entityType')} />
          </Field>

          <Field label="Legal name" required error={errors.legalName?.message} htmlFor="quick-entity-name">
            <Input
              id="quick-entity-name"
              placeholder="e.g. ABC Properties"
              hasError={!!errors.legalName}
              {...register('legalName')}
              ref={(el) => {
                register('legalName').ref(el);
                nameRef.current = el;
              }}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Code" required error={errors.entityCode?.message} htmlFor="quick-entity-code" hint="Suggested from the name">
              <Input id="quick-entity-code" className="font-mono" hasError={!!errors.entityCode} {...register('entityCode')} />
            </Field>
            <Field label="Contact person" error={errors.contactPerson?.message} htmlFor="quick-entity-contact">
              <Input id="quick-entity-contact" {...register('contactPerson')} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Email" error={errors.email?.message} htmlFor="quick-entity-email" hint="Optional">
              <Input id="quick-entity-email" type="email" hasError={!!errors.email} {...register('email')} />
            </Field>
            <Field label="Phone" error={errors.phone?.message} htmlFor="quick-entity-phone">
              <Input id="quick-entity-phone" {...register('phone')} />
            </Field>
          </div>

          <Field label="Tax registration number" error={errors.taxRegistrationNumber?.message} htmlFor="quick-entity-tax">
            <Input id="quick-entity-tax" {...register('taxRegistrationNumber')} />
          </Field>

          {storeError && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
              {storeError}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
            <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !legalName?.trim() || !entityCode?.trim()}>
              Save entity
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
