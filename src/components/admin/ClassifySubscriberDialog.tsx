/**
 * "Classify existing subscriber" — reconciling the 008 migration's blanket default.
 *
 * ── What this dialog is actually for ─────────────────────────────────────────
 * No subscriber is unclassified: `data_classification` is NOT NULL DEFAULT
 * 'production', so migration 008 gave every pre-existing row `production`
 * without anybody looking at it. That default records an absence of a decision
 * while reading exactly like a decision, and this dialog is where a human
 * converts one into the other.
 *
 * ── Why Production is the only outcome ───────────────────────────────────────
 * Marking an EXISTING account disposable is a retention override, not a
 * classification. It moves data out of production protection, which is why it
 * lives in a development-only CLI that cannot run against a production database
 * — Platform Super Admin authority is deliberately not sufficient for it. So the
 * radio group offers all three types, because an operator arrives wanting to
 * pick one, and the server refuses Demo/Test with the evidence and a pointer to
 * the CLI. Hiding the options would leave them wondering where they went; the
 * refusal explains.
 *
 * The evidence panel is not decoration. Confirming production is irreversible in
 * the sense that matters — it is the state that can never be walked back to
 * disposable — so the operator sees the billing, payment and activation history
 * in the same dialog where they accept it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Field, Textarea } from '@/components/ui/Input';
import { ApiError } from '@/services/api/client';
import {
  classificationEvidence,
  classifySubscriber,
  type ClassificationEvidence,
} from '@/services/api/closureApi';

export const DISPOSABLE_RECONCILIATION_ACKNOWLEDGEMENT =
  'I confirm this is not a real production customer and may be treated as a disposable account subject to Ledgora’s deletion policy.';

export interface ClassifySubscriberDialogProps {
  open: boolean;
  organizationId: string;
  legalName: string;
  onClose: () => void;
  /** Classification succeeded; the caller reloads its roster. */
  onClassified: (message: string) => void;
}

const CHOICES: { value: 'production' | 'demo' | 'test'; label: string; description: string }[] = [
  {
    value: 'production',
    label: 'Production',
    description: 'Real customer account. Protected by the retention and archive policy.',
  },
  {
    value: 'demo',
    label: 'Demo',
    description: 'Temporary demonstration account.',
  },
  {
    value: 'test',
    label: 'Test',
    description: 'Internal testing/QA account.',
  },
];

export function ClassifySubscriberDialog({
  open,
  organizationId,
  legalName,
  onClose,
  onClassified,
}: ClassifySubscriberDialogProps) {
  const [evidence, setEvidence] = useState<ClassificationEvidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Production by default. A reconciliation decision defaults to protection. */
  const [choice, setChoice] = useState<'production' | 'demo' | 'test'>('production');
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await classificationEvidence(organizationId, signal);
        setEvidence(result.evidence);
      } catch (caught) {
        if ((caught as { name?: string }).name === 'AbortError') return;
        setLoadError(
          caught instanceof ApiError ? caught.message : 'The evidence summary could not be loaded.',
        );
      } finally {
        setLoading(false);
      }
    },
    [organizationId],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    // Reset per opening: a previous subscriber's answers must not carry over.
    setChoice('production');
    setAcknowledged(false);
    setReason('');
    setError(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

  if (!open) return null;

  const disposable = choice !== 'production';
  const canSubmit = !busy && !loading && reason.trim().length >= 10 && (!disposable || acknowledged);

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await classifySubscriber(organizationId, {
        classification: choice,
        reason: reason.trim(),
      });
      onClassified(
        `${legalName} classified ${result.classification.classification.toUpperCase()}.`,
      );
      onClose();
    } catch (caught) {
      /*
       * The server's own refusal, verbatim. For a Demo/Test request this is the
       * sentence naming the evidence and pointing at the CLI — the component
       * must not paraphrase it into something vaguer.
       */
      setError(
        caught instanceof ApiError ? caught.message : 'The classification could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Classify existing subscriber"
      data-testid="classify-dialog"
    >
      <div className="w-full max-w-xl rounded-xl bg-white p-5 shadow-xl dark:bg-slate-900">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">
          Classify existing subscriber
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          This account was classified by a data migration, not by a person. Confirm what it actually is.
        </p>

        <div className="mt-4 max-h-[55vh] space-y-4 overflow-y-auto">
          {loading && <p className="text-sm text-slate-500">Loading the evidence summary…</p>}

          {loadError && (
            <Alert variant="error" title="The evidence could not be loaded">
              {loadError} Classification is not offered until it succeeds — deciding without the history
              is exactly the mistake this dialog exists to prevent.
            </Alert>
          )}

          {evidence && (
            <>
              {/* ── The record ───────────────────────────────────────────── */}
              <dl
                className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700"
                data-testid="classify-evidence"
              >
                <dt className="text-slate-500">Organization</dt>
                <dd className="font-medium">{evidence.legalName}</dd>
                <dt className="text-slate-500">Owner</dt>
                <dd>{evidence.ownerEmail ?? '—'}</dd>
                <dt className="text-slate-500">Created</dt>
                <dd>{new Date(evidence.createdAt).toLocaleDateString()}</dd>
                <dt className="text-slate-500">Status</dt>
                <dd>{evidence.organizationStatus}</dd>
                <dt className="text-slate-500">Subscriptions</dt>
                <dd>{evidence.subscriptionCount}</dd>
                <dt className="text-slate-500">Paid invoices</dt>
                <dd>{evidence.paidInvoiceCount}</dd>
                <dt className="text-slate-500">Approved proofs</dt>
                <dd>{evidence.approvedProofCount}</dd>
                <dt className="text-slate-500">Ever activated</dt>
                <dd>{evidence.everActivated ? 'Yes' : 'No'}</dd>
                <dt className="text-slate-500">Legal hold</dt>
                <dd>{evidence.legalHold ? 'Yes' : 'No'}</dd>
                <dt className="text-slate-500">Current</dt>
                <dd>
                  <Badge tone="green">{evidence.currentClassification.toUpperCase()}</Badge>{' '}
                  <span className="text-xs text-slate-500">(migration default, unreviewed)</span>
                </dd>
              </dl>

              <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300" data-testid="classify-findings">
                {evidence.findings.map((finding) => (
                  <li key={finding}>· {finding}</li>
                ))}
              </ul>

              {/* ── The choice ───────────────────────────────────────────── */}
              <div className="space-y-2" role="radiogroup" aria-label="Classification">
                {CHOICES.map((option) => (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                      choice === option.value
                        ? 'border-indigo-400 bg-indigo-50/60 dark:bg-indigo-500/10'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                    data-testid={`classify-choice-${option.value}`}
                  >
                    <input
                      type="radio"
                      name="classify-classification"
                      className="mt-1"
                      value={option.value}
                      checked={choice === option.value}
                      onChange={() => {
                        setChoice(option.value);
                        setAcknowledged(false);
                        setError(null);
                      }}
                    />
                    <span className="text-sm">
                      <span className="font-medium text-slate-800 dark:text-slate-100">{option.label}</span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>

              {disposable && (
                <>
                  <Alert variant="warning" title="Marking an existing account disposable">
                    This is a retention override rather than a classification, and the server will refuse it
                    here. It is available only through the development CLI, against a development database.
                  </Alert>
                  <label className="flex items-start gap-2 text-sm" data-testid="classify-acknowledgement">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={acknowledged}
                      onChange={(event) => setAcknowledged(event.target.checked)}
                    />
                    <span className="text-slate-700 dark:text-slate-200">
                      {DISPOSABLE_RECONCILIATION_ACKNOWLEDGEMENT}
                    </span>
                  </label>
                </>
              )}

              {error && (
                <div data-testid="classify-error">
                  <Alert variant="error" title="Classification refused">
                    {error}
                  </Alert>
                </div>
              )}

              <Field
                label="Reason"
                required
                hint="Recorded against the account permanently, with the evidence summary."
              >
                <Textarea
                  rows={2}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="What establishes what this account is?"
                  aria-label="Reason"
                  data-testid="classify-reason"
                />
              </Field>
            </>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!canSubmit}
            data-testid="classify-submit"
          >
            {busy ? 'Saving…' : 'Classify subscriber'}
          </Button>
        </div>
      </div>
    </div>
  );
}
