/**
 * The "Amend posted document" workflow.
 *
 * ── Why it is four steps and not a form ──────────────────────────────────────
 * The operator is not editing a record. They are withdrawing a posting the
 * business has already acted on and issuing a corrected one in its place, and
 * everything about the screen has to say so:
 *
 *   1. Review    what this document is, what it has already touched, and what
 *                the amendment will do to each of those things
 *   2. Revise    the fields the accounting rules allow to change
 *   3. Compare   the original beside the revision, field by field
 *   4. Confirm   one last, explicit act
 *
 * It is deliberately not labelled "Edit". A user who thinks they are editing a
 * document will not read a warning about reversals, and this workflow's whole
 * purpose is that they do.
 *
 * ── Which fields this screen offers ──────────────────────────────────────────
 * A practical subset of what `amendableFields` permits: the counterparty, the
 * dates, the references and the line figures — the corrections operators
 * actually raise. Everything else on the original carries across untouched.
 * The allow-list in `lib/documentAmendment` is the authority, and it is applied
 * again in the service, so what this screen offers can never widen what the
 * amendment may change.
 */
import { useMemo, useState } from 'react';
import type { AmendableDocumentType, AmendmentAssessment, DocumentFieldChange } from '@/types/documentAmendment';
import { DOCUMENT_TYPE_LABELS } from '@/types/documentAmendment';
import { amendPostedDocument, amendmentFingerprint } from '@/services/documentAmendmentService';
import { diffDocuments, validateAmendmentReason } from '@/lib/documentAmendment';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useBillStore } from '@/store/billStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useJournalStore } from '@/store/journalStore';
import { calculateInvoiceLine } from '@/lib/invoiceCalculations';
import { formatCurrency } from '@/lib/money';
import { generateId } from '@/lib/utils';
import { Drawer } from '@/components/ui/Drawer';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { AmendmentHistoryPanel } from './AmendmentHistoryPanel';
import { cn } from '@/lib/utils';

/* ── The document, in one shape the drawer can edit ───────────────────────── */

interface EditableLine {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
}

interface Draft {
  counterpartyId: string;
  primaryDate: string;
  secondaryDate: string;
  reference: string;
  notes: string;
  lines: EditableLine[];
  /** Supplier debit notes carry amounts rather than lines. */
  netAmount: number;
  taxAmount: number;
}

interface Shape {
  counterpartyLabel: string;
  counterpartyField: 'customerId' | 'supplierId';
  counterpartyKinds: string[];
  primaryDateLabel: string;
  primaryDateField: string;
  secondaryDateLabel?: string;
  secondaryDateField?: string;
  referenceLabel?: string;
  referenceField?: string;
  hasLines: boolean;
}

const SHAPES: Record<AmendableDocumentType, Shape> = {
  invoice: {
    counterpartyLabel: 'Customer', counterpartyField: 'customerId', counterpartyKinds: ['customer', 'both'],
    primaryDateLabel: 'Issue date', primaryDateField: 'issueDate',
    secondaryDateLabel: 'Due date', secondaryDateField: 'dueDate',
    referenceLabel: 'Customer reference', referenceField: 'customerReference',
    hasLines: true,
  },
  bill: {
    counterpartyLabel: 'Supplier', counterpartyField: 'supplierId', counterpartyKinds: ['supplier', 'both'],
    primaryDateLabel: 'Bill date', primaryDateField: 'billDate',
    secondaryDateLabel: 'Due date', secondaryDateField: 'dueDate',
    referenceLabel: 'Supplier invoice no.', referenceField: 'supplierInvoiceNumber',
    hasLines: true,
  },
  'credit-note': {
    counterpartyLabel: 'Customer', counterpartyField: 'customerId', counterpartyKinds: ['customer', 'both'],
    primaryDateLabel: 'Issue date', primaryDateField: 'issueDate',
    referenceLabel: 'Reason', referenceField: 'reasonDescription',
    hasLines: true,
  },
  'supplier-debit-note': {
    counterpartyLabel: 'Supplier', counterpartyField: 'supplierId', counterpartyKinds: ['supplier', 'both'],
    primaryDateLabel: 'Date', primaryDateField: 'date',
    referenceLabel: 'Reason', referenceField: 'reason',
    hasLines: false,
  },
};

type Loaded = { record: Record<string, unknown>; currency: string; number: string } | null;

function loadDocument(type: AmendableDocumentType, id: string): Loaded {
  if (type === 'invoice') {
    const invoice = useInvoiceStore.getState().invoices.find((i) => i.id === id);
    return invoice ? { record: invoice as unknown as Record<string, unknown>, currency: invoice.currency, number: invoice.invoiceNumber } : null;
  }
  if (type === 'bill') {
    const bill = useBillStore.getState().bills.find((b) => b.id === id);
    return bill ? { record: bill as unknown as Record<string, unknown>, currency: bill.currency, number: bill.billNumber } : null;
  }
  if (type === 'credit-note') {
    const note = useCreditNoteStore.getState().creditNotes.find((c) => c.id === id);
    return note ? { record: note as unknown as Record<string, unknown>, currency: note.currency, number: note.creditNoteNumber } : null;
  }
  for (const bill of useBillStore.getState().bills) {
    const credit = (bill.supplierCredits ?? []).find((c) => c.id === id);
    if (credit) {
      return { record: { ...credit, supplierId: bill.supplierId } as unknown as Record<string, unknown>, currency: bill.currency, number: credit.creditNumber };
    }
  }
  return null;
}

function toDraft(type: AmendableDocumentType, record: Record<string, unknown>): Draft {
  const shape = SHAPES[type];
  const rawLines = Array.isArray(record.lines) ? (record.lines as Record<string, unknown>[]) : [];
  return {
    counterpartyId: String(record[shape.counterpartyField] ?? ''),
    primaryDate: String(record[shape.primaryDateField] ?? ''),
    secondaryDate: shape.secondaryDateField ? String(record[shape.secondaryDateField] ?? '') : '',
    reference: shape.referenceField ? String(record[shape.referenceField] ?? '') : '',
    notes: String(record.notes ?? ''),
    lines: rawLines.map((l) => ({
      id: String(l.id ?? generateId('ln')),
      description: String(l.description ?? ''),
      quantity: Number(l.quantity ?? 0),
      unitPrice: Number(l.unitPrice ?? 0),
      taxRate: Number(l.taxRate ?? 0),
    })),
    netAmount: Number(record.netAmount ?? 0),
    taxAmount: Number(record.taxAmount ?? 0),
  };
}

/**
 * The corrected values, in the shape the service expects.
 *
 * Lines keep their ORIGINAL identity and every field the drawer does not offer
 * — the posting account, the project, the cost centre, the inventory item and
 * warehouse. An amendment that silently dropped an inventory line's warehouse
 * because the screen had no box for it would repost the stock somewhere else.
 */
function toPatch(type: AmendableDocumentType, record: Record<string, unknown>, draft: Draft): Record<string, unknown> {
  const shape = SHAPES[type];
  const patch: Record<string, unknown> = {
    [shape.counterpartyField]: draft.counterpartyId,
    [shape.primaryDateField]: draft.primaryDate,
    notes: draft.notes,
  };
  if (shape.secondaryDateField) patch[shape.secondaryDateField] = draft.secondaryDate;
  if (shape.referenceField) patch[shape.referenceField] = draft.reference;

  if (!shape.hasLines) {
    patch.netAmount = draft.netAmount;
    patch.taxAmount = draft.taxAmount;
    return patch;
  }

  const original = Array.isArray(record.lines) ? (record.lines as Record<string, unknown>[]) : [];
  patch.lines = draft.lines.map((line, index) => {
    const source = original.find((l) => l.id === line.id) ?? original[index] ?? {};
    return {
      ...source,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      taxRate: line.taxRate,
    };
  });
  return patch;
}

/** A preview of the revised document, for the comparison step. */
function preview(record: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...record, ...patch };
  const lines = Array.isArray(merged.lines) ? (merged.lines as Record<string, unknown>[]) : [];
  const recalculated = lines.map((l) => {
    const c = calculateInvoiceLine(l as never);
    return { ...l, taxAmount: c.taxAmount, lineTotal: c.lineTotal, lineSubtotal: c.taxableAmount };
  });
  const subtotal = recalculated.reduce((sum, l) => sum + Number(l.lineSubtotal ?? 0), 0);
  const taxTotal = recalculated.reduce((sum, l) => sum + Number(l.taxAmount ?? 0), 0);
  const grandTotal = recalculated.reduce((sum, l) => sum + Number(l.lineTotal ?? 0), 0);
  if (recalculated.length === 0) {
    const net = Number(merged.netAmount ?? 0);
    const tax = Number(merged.taxAmount ?? 0);
    return { ...merged, amount: net + tax };
  }
  return { ...merged, lines: recalculated, subtotal, taxTotal, grandTotal };
}

/* ── The drawer ───────────────────────────────────────────────────────────── */

type Step = 'review' | 'revise' | 'compare' | 'confirm';

const STEP_ORDER: Step[] = ['review', 'revise', 'compare', 'confirm'];
const STEP_LABELS: Record<Step, string> = {
  review: 'Review',
  revise: 'Revise',
  compare: 'Compare',
  confirm: 'Confirm',
};

export interface AmendDocumentDrawerProps {
  open: boolean;
  documentType: AmendableDocumentType;
  documentId: string;
  assessment: AmendmentAssessment;
  onClose: () => void;
  onAmended?: (replacementId: string) => void;
}

export function AmendDocumentDrawer({
  open, documentType, documentId, assessment, onClose, onAmended,
}: AmendDocumentDrawerProps) {
  const { notify } = useToast();
  const entities = useEntityStore((s) => s.entities);
  const entries = useJournalStore((s) => s.entries);

  const loaded = useMemo(() => loadDocument(documentType, documentId), [documentType, documentId]);
  const [step, setStep] = useState<Step>('review');
  const [reason, setReason] = useState('');
  const [draft, setDraft] = useState<Draft | null>(() => (loaded ? toDraft(documentType, loaded.record) : null));
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Minted once, when the drawer opens, and echoed back on confirmation. A
   * double-clicked Confirm, or a retry after a slow network, replays the first
   * attempt's result instead of posting a second reversal.
   */
  const [correlationId] = useState(() => generateId('amdreq'));
  /* What the document looked like when this drawer read it. */
  const [fingerprint] = useState(() => amendmentFingerprint(documentType, documentId));

  if (!loaded || !draft) return null;

  const shape = SHAPES[documentType];
  const label = DOCUMENT_TYPE_LABELS[documentType];
  const money = (n: number): string => formatCurrency(n, loaded.currency);
  const patch = toPatch(documentType, loaded.record, draft);
  const revised = preview(loaded.record, patch);
  const changes: DocumentFieldChange[] = diffDocuments(
    documentType,
    loaded.record,
    revised,
    { entityName: (id) => entities.find((e) => e.id === id)?.legalName ?? String(id ?? '—') },
  );
  const reasonCheck = validateAmendmentReason(reason);
  const entryNumber = (id: string | undefined): string =>
    (id ? entries.find((e) => e.id === id)?.entryNumber : undefined) ?? '—';

  const counterpartyOptions = entities
    .filter((e) => shape.counterpartyKinds.includes(e.entityType))
    .map((e) => ({ value: e.id, label: e.legalName }));

  const setLine = (index: number, patchLine: Partial<EditableLine>): void => {
    setDraft({ ...draft, lines: draft.lines.map((l, i) => (i === index ? { ...l, ...patchLine } : l)) });
  };

  const canLeaveReview = reasonCheck.ok && acknowledged;
  const canConfirm = canLeaveReview && changes.length > 0 && !busy;

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await amendPostedDocument({
      documentType,
      documentId,
      reason,
      expectedVersion: assessment.version,
      expectedFingerprint: fingerprint,
      correlationId,
      patch,
      confirmed: true,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'The amendment could not be completed.');
      return;
    }
    notify(
      result.idempotentReplay
        ? `This amendment had already been applied — ${result.replacementNumber} is the current version.`
        : `${loaded.number} amended. ${result.replacementNumber} is now the current version; the original and its reversal are kept in the history.`,
      'success',
    );
    onAmended?.(result.replacementId!);
    onClose();
  };

  const stepIndex = STEP_ORDER.indexOf(step);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      widthClassName="max-w-4xl"
      title={<>Amend posted {label.toLowerCase()} <span className="font-mono">{loaded.number}</span></>}
      description="The original document and its posting are kept. This creates a reversal and a corrected replacement."
      footer={(
        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {/* Closing without confirming changes nothing at all. */}
            Cancel
          </Button>
          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <Button variant="outline" onClick={() => setStep(STEP_ORDER[stepIndex - 1]!)} disabled={busy}>
                Back
              </Button>
            )}
            {step !== 'confirm' ? (
              <Button
                onClick={() => setStep(STEP_ORDER[stepIndex + 1]!)}
                disabled={step === 'review' && !canLeaveReview}
              >
                Continue
              </Button>
            ) : (
              <Button variant="danger" onClick={() => void confirm()} disabled={!canConfirm}>
                {busy ? 'Amending…' : 'Reverse and repost'}
              </Button>
            )}
          </div>
        </div>
      )}
    >
      <div className="space-y-5">
        {/* Step indicator */}
        <ol className="flex flex-wrap gap-1 text-[11px]">
          {STEP_ORDER.map((s, i) => (
            <li
              key={s}
              className={cn(
                'rounded-full px-2.5 py-1 font-medium',
                i === stepIndex
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : i < stepIndex
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                    : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
              )}
            >
              {i + 1}. {STEP_LABELS[s]}
            </li>
          ))}
        </ol>

        {error && <Alert variant="error" title="The amendment was not applied">{error}</Alert>}

        {/* ── 1. Review ──────────────────────────────────────────────────── */}
        {step === 'review' && (
          <div className="space-y-4">
            <Alert variant="warning" title="The original posting stays in the books">
              {loaded.number} keeps its number, its lines, its taxes and its journal entry, and remains
              readable for ever. Ledgora posts a reversal of it and then posts a corrected replacement
              with its own number. Nothing is overwritten and nothing is deleted.
            </Alert>

            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
              <Fact label="Document">{loaded.number}</Fact>
              <Fact label="Version">v{assessment.version}</Fact>
              <Fact label="Posting date">{assessment.documentDate}</Fact>
              <Fact label="Journal entry">{entryNumber(assessment.impact.originalJournalEntryId)}</Fact>
              <Fact label="Tax period">
                {assessment.impact.tax.periodLabel
                  ? `${assessment.impact.tax.periodLabel} (${assessment.impact.tax.periodStatus})`
                  : 'No tax period covers this date'}
              </Fact>
              <Fact label="e-invoice">{assessment.impact.tax.externalSubmission ?? 'Not submitted externally'}</Fact>
              <Fact label="Document total">{money(assessment.impact.settlement.grandTotal)}</Fact>
              <Fact label="Settled">{money(assessment.impact.settlement.amountSettled)}</Fact>
              <Fact label="Balance">{money(assessment.impact.settlement.balanceDue)}</Fact>
            </dl>

            {assessment.impact.settlement.transferable.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Settlement carried across</h4>
                <ul className="mt-1.5 space-y-1 text-xs text-slate-600 dark:text-slate-300">
                  {assessment.impact.settlement.transferable.map((s) => (
                    <li key={s.id} className="flex justify-between gap-4">
                      <span>{s.label}</span>
                      <span className="font-mono">{money(s.amount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {assessment.confirmations.map((finding, i) => (
              <Alert key={`${finding.kind}-${i}`} variant="info" title={finding.sourceLabel}>
                {finding.message}
              </Alert>
            ))}

            <div>
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-200" htmlFor="amend-reason">
                Why is this document being amended? <span className="text-red-500">*</span>
              </label>
              <Input
                id="amend-reason"
                className="mt-1.5"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. The quantity delivered was six, not four"
                autoFocus
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Recorded permanently in the document’s history and in the amendment audit trail.
                {!reasonCheck.ok && reason.length > 0 && <span className="text-red-500"> {reasonCheck.error}</span>}
              </p>
            </div>

            <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              I understand this reverses the original posting and issues a corrected replacement document.
            </label>

            <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
              <AmendmentHistoryPanel documentType={documentType} documentId={documentId} currency={loaded.currency} compact />
            </div>
          </div>
        )}

        {/* ── 2. Revise ──────────────────────────────────────────────────── */}
        {step === 'revise' && (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">
              Only the fields the accounting rules can safely amend are offered. Everything else — the
              posting accounts, projects, cost centres, warehouses and inventory items on each line —
              carries across from the original untouched.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={shape.counterpartyLabel}>
                <Select
                  options={counterpartyOptions}
                  value={draft.counterpartyId}
                  onChange={(e) => setDraft({ ...draft, counterpartyId: e.target.value })}
                />
              </Field>
              <Field label={shape.primaryDateLabel}>
                <Input type="date" value={draft.primaryDate} onChange={(e) => setDraft({ ...draft, primaryDate: e.target.value })} />
              </Field>
              {shape.secondaryDateLabel && (
                <Field label={shape.secondaryDateLabel}>
                  <Input type="date" value={draft.secondaryDate} onChange={(e) => setDraft({ ...draft, secondaryDate: e.target.value })} />
                </Field>
              )}
              {shape.referenceLabel && (
                <Field label={shape.referenceLabel}>
                  <Input value={draft.reference} onChange={(e) => setDraft({ ...draft, reference: e.target.value })} />
                </Field>
              )}
              {!shape.hasLines && (
                <>
                  <Field label="Net amount">
                    <Input type="number" value={draft.netAmount} onChange={(e) => setDraft({ ...draft, netAmount: Number(e.target.value) })} />
                  </Field>
                  <Field label="Tax amount">
                    <Input type="number" value={draft.taxAmount} onChange={(e) => setDraft({ ...draft, taxAmount: Number(e.target.value) })} />
                  </Field>
                </>
              )}
              <Field label="Notes" className="sm:col-span-2">
                <Input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
              </Field>
            </div>

            {shape.hasLines && (
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="text-[11px] uppercase tracking-wide text-slate-400">
                    <tr>
                      {['Description', 'Qty', 'Unit price', 'Tax %', 'Line total'].map((h) => (
                        <th key={h} className={cn('px-2 py-1 text-left font-semibold', h !== 'Description' && 'text-right')}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {draft.lines.map((line, index) => {
                      const computed = calculateInvoiceLine({ ...line, lineSubtotal: 0, lineTotal: 0, taxAmount: 0 } as never);
                      return (
                        <tr key={line.id}>
                          <td className="px-2 py-1.5">
                            <Input className="h-8" value={line.description} onChange={(e) => setLine(index, { description: e.target.value })} />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input className="h-8 text-right" type="number" value={line.quantity} onChange={(e) => setLine(index, { quantity: Number(e.target.value) })} />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input className="h-8 text-right" type="number" value={line.unitPrice} onChange={(e) => setLine(index, { unitPrice: Number(e.target.value) })} />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input className="h-8 text-right" type="number" value={line.taxRate} onChange={(e) => setLine(index, { taxRate: Number(e.target.value) })} />
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">{money(computed.lineTotal)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── 3. Compare ─────────────────────────────────────────────────── */}
        {step === 'compare' && (
          <div className="space-y-4">
            {changes.length === 0 ? (
              <Alert variant="warning" title="Nothing has changed">
                The revision is identical to the original, so there is nothing to amend. Go back and make
                the correction, or cancel — the original is untouched either way.
              </Alert>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="text-[11px] uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-2 py-1 text-left font-semibold">Field</th>
                      <th className="px-2 py-1 text-left font-semibold">Original {loaded.number}</th>
                      <th className="px-2 py-1 text-left font-semibold">Revised</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {changes.map((change) => (
                      <tr key={change.field}>
                        <td className="px-2 py-1.5 text-slate-500">{change.label}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-400 line-through">{change.before}</td>
                        <td className="px-2 py-1.5 font-mono font-semibold text-slate-800 dark:text-slate-100">{change.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── 4. Confirm ─────────────────────────────────────────────────── */}
        {step === 'confirm' && (
          <div className="space-y-4">
            <Alert variant="warning" title="This posts to the ledger">
              Confirming reverses {loaded.number}’s journal entry and posts a corrected replacement, in one
              step. Both succeed or neither does.
            </Alert>
            <ul className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300">
              <li>· <strong>{loaded.number}</strong> becomes <Badge tone="slate">superseded</Badge> and keeps everything it has.</li>
              <li>· A reversal of journal entry {entryNumber(assessment.impact.originalJournalEntryId)} is posted, dated {assessment.documentDate}.</li>
              <li>· A replacement {label.toLowerCase()} is posted with a new number from the same sequence.</li>
              {assessment.impact.settlement.transferable.length > 0 && (
                <li>· {assessment.impact.settlement.transferable.length} settlement record(s) move to the replacement. Each keeps its own number and bank posting.</li>
              )}
              {assessment.impact.inventory.movementCount > 0 && (
                <li>· {assessment.impact.inventory.movementCount} stock movement(s) are reversed at their original cost and reposted from the corrected document.</li>
              )}
              <li>· The amendment, your name, the reason and every changed value are recorded in the audit trail.</li>
            </ul>
            <div className="rounded-lg border border-slate-200 px-3 py-2 text-xs dark:border-slate-800">
              <span className="text-slate-500">Reason:</span> <span className="font-medium">{reason}</span>
            </div>
            <p className="text-[11px] text-slate-500">
              {changes.length} field{changes.length === 1 ? '' : 's'} will differ from the original.
            </p>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="font-medium text-slate-700 dark:text-slate-200">{children}</dd>
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
