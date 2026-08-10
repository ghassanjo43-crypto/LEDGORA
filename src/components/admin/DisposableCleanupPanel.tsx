/**
 * "Clean up test/demo data" — the bulk disposal console.
 *
 * ── The shape of the interaction is the safety feature ───────────────────────
 * Preview → review → type a phrase → execute. There is deliberately no path
 * from "I see a tenant" to "it is destroyed" in one gesture, and the execute
 * button stays disabled until a fresh preview, a reason and the exact
 * confirmation phrase all exist. The server enforces every one of these
 * independently; the UI's job is to make sure a human looked.
 *
 * ── What this component is NOT allowed to decide ─────────────────────────────
 * Eligibility. Every `eligible` flag, blocker and count rendered here came from
 * the server and goes back only as an opaque digest. A bug in this file can make
 * the console show the wrong thing; it cannot make the server delete the wrong
 * thing.
 *
 * ── Why "ever activated" is shown so loudly ──────────────────────────────────
 * It is explicitly not a blocker: development tenants must be activatable to
 * exercise real workflows. But an activated tenant is one that was permitted to
 * write accounting records, and those live in the customer workspace where this
 * server cannot count them. The operator is the only control left, so the
 * warning is prominent rather than tucked into a detail row.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { purgeBusinessWorkspace } from '@/store/businessWorkspace';
import {
  cleanupApi,
  PERMANENT_DELETION_DISCLOSURE,
  type CleanupPreview,
  type CleanupResult,
  type CleanupCandidate,
  type ExternalCleanupSummary,
} from '@/services/api/cleanupApi';

const CONFIRMATION_PHRASE = 'DELETE TEST DATA PERMANENTLY';

function classificationTone(classification: string): 'green' | 'amber' | 'violet' | 'slate' {
  return classification === 'production' ? 'green' : classification === 'test' ? 'amber' : 'violet';
}

/** One reviewable tenant. Warnings come before counts: they change the decision. */
function CandidateCard({
  candidate,
  selected,
  onToggle,
}: {
  candidate: CleanupCandidate;
  selected: boolean;
  onToggle: (organizationId: string) => void;
}) {
  const nonZero = candidate.counts.filter((c) => c.count > 0);

  return (
    <li
      className={`rounded-lg border p-3 ${candidate.eligible ? 'border-slate-200' : 'border-slate-200 bg-slate-50'}`}
      data-testid={`cleanup-candidate-${candidate.organizationId}`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={selected}
          disabled={!candidate.eligible}
          onChange={() => onToggle(candidate.organizationId)}
          aria-label={`Select ${candidate.legalName} for permanent deletion`}
          data-testid={`cleanup-select-${candidate.organizationId}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{candidate.legalName}</span>
            <span data-testid={`cleanup-classification-${candidate.organizationId}`}>
              <Badge tone={classificationTone(candidate.classification)}>{candidate.classification}</Badge>
            </span>
            <Badge tone="slate">{candidate.status}</Badge>
            {candidate.eligible ? (
              <Badge tone="amber">eligible</Badge>
            ) : (
              <span data-testid={`cleanup-excluded-${candidate.organizationId}`}>
                <Badge tone="slate">excluded</Badge>
              </span>
            )}
          </div>

          {/* Blockers first for an excluded tenant: it is the whole answer. */}
          {!candidate.eligible && candidate.blockers.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-slate-600">
              {candidate.blockers.map((blocker) => (
                <li key={blocker.code}>· {blocker.message}</li>
              ))}
            </ul>
          )}

          {candidate.eligible && candidate.everActivated && (
            <div className="mt-2" data-testid={`cleanup-activated-${candidate.organizationId}`}>
              {/*
                Says what is NOT deleted. An earlier wording said the records
                "cannot be counted from here", which reads as though the
                deletion covered them and only the tally was missing. It does
                not: they are in browsers this server has never touched.
              */}
              <Alert variant="warning" title="This tenant was activated">
                It was permitted to create accounting records. Those records live in each user's browser
                workspace, <strong>not on the server</strong>: deleting this subscriber removes the account,
                its memberships and its sessions — which makes the workspace unreachable through Ledgora — but
                it cannot erase data already written to those browsers. Detailed accounting counts are
                unavailable for the same reason.
              </Alert>
            </div>
          )}

          {candidate.eligible && candidate.warnings.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-amber-700">
              {candidate.warnings.map((warning) => (
                <li key={warning}>· {warning}</li>
              ))}
            </ul>
          )}

          {nonZero.length > 0 && (
            <p className="mt-2 text-xs text-slate-500">
              {nonZero.map((c) => `${c.count} ${c.label.toLowerCase()}`).join(' · ')}
            </p>
          )}

          {candidate.storedDocumentCount > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              {candidate.storedDocumentCount} stored document(s) queued for deletion from file storage.
            </p>
          )}

          {candidate.identities.length > 0 && (
            <details className="mt-2 text-xs text-slate-600">
              <summary className="cursor-pointer">People ({candidate.identities.length})</summary>
              <ul className="mt-1 space-y-1">
                {candidate.identities.map((identity) => (
                  <li key={identity.userId}>
                    <span className="font-medium">{identity.email}</span>{' '}
                    {identity.outcome === 'deletable' ? (
                      <Badge tone="red">will be deleted</Badge>
                    ) : (
                      <Badge tone="green">retained</Badge>
                    )}
                    <span className="block text-slate-500">{identity.detail}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}

export function DisposableCleanupPanel({
  /**
   * Set when the operator arrived by pressing "Permanently delete" on one row of
   * the subscriber roster, rather than by opening this tab to browse.
   *
   * That click is itself an explicit choice of a named tenant, so carrying it
   * across is not the panel pre-selecting anything on the operator's behalf —
   * it is the panel not discarding what they already said. Browsing still
   * starts with nothing ticked, and a focused tenant that is not eligible is
   * shown without being selected.
   */
  focusOrganizationId,
}: {
  focusOrganizationId?: string;
} = {}) {
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CleanupResult | null>(null);
  /**
   * Outstanding object-storage deletions across ALL operations, including ones
   * started in a session nobody is looking at any more.
   *
   * The ledger exists precisely so a crash between deleting rows and deleting
   * files is recoverable. That guarantee is worth nothing if the leftover work
   * is only visible to whoever happened to be on screen when it failed, so the
   * panel asks on load rather than only reporting the operation it just ran.
   */
  const [outstandingFiles, setOutstandingFiles] = useState<ExternalCleanupSummary | null>(null);

  /**
   * `keepResult` exists because the refresh that follows a deletion must not
   * erase the report of that deletion. The operator needs to read what happened
   * — especially a partial failure or an outstanding file cleanup — and the
   * refresh is there to update the roster underneath it, not to replace it.
   */
  const loadPreview = useCallback(async (keepResult = false, focus?: string) => {
    setBusy(true);
    setError(null);
    if (!keepResult) setResult(null);
    try {
      const fresh = await cleanupApi.previewAllDisposable();
      setPreview(fresh);
      /*
       * Nothing is pre-selected. Selection is the operator's deliberate act —
       * the one exception being a tenant they explicitly named on the way in,
       * and only if the server still reports it eligible.
       */
      const focused =
        focus && fresh.candidates.some((c) => c.organizationId === focus && c.eligible) ? [focus] : [];
      setSelected(focused);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the preview.');
    } finally {
      setBusy(false);
    }

    /*
     * Separate from the preview and deliberately not fatal to it. Not knowing
     * whether files are outstanding is a worse reason to hide the roster than
     * it is to leave one line unrendered.
     */
    try {
      setOutstandingFiles(await cleanupApi.fileStatus());
    } catch {
      setOutstandingFiles(null);
    }
  }, []);

  useEffect(() => {
    void loadPreview(false, focusOrganizationId);
  }, [loadPreview, focusOrganizationId]);

  /** Nullish-guarded: a summary that failed to load must read as "nothing known", not NaN. */
  const outstandingFileCount = (outstandingFiles?.pending ?? 0) + (outstandingFiles?.failed ?? 0);

  const eligible = useMemo(() => preview?.candidates.filter((c) => c.eligible) ?? [], [preview]);
  const excluded = useMemo(() => preview?.candidates.filter((c) => !c.eligible) ?? [], [preview]);

  const toggle = (organizationId: string) =>
    setSelected((current) =>
      current.includes(organizationId)
        ? current.filter((id) => id !== organizationId)
        : [...current, organizationId],
    );

  const canExecute =
    !busy &&
    preview !== null &&
    selected.length > 0 &&
    reason.trim().length >= 10 &&
    confirmation === CONFIRMATION_PHRASE;

  const execute = async () => {
    if (!preview || !canExecute) return;
    setBusy(true);
    setError(null);
    try {
      /*
       * Generated per attempt. A double-submitted request carries the same id,
       * so the server replays the first result rather than deleting twice.
       */
      const operationId = crypto.randomUUID();

      const outcome = await cleanupApi.execute({
        organizationIds: selected,
        /*
         * The whole roster that was reviewed, not just the ticked rows. The
         * digest covers all of it, so the server recomputes over the same set
         * and a change to ANY previewed tenant — including one not selected —
         * sends the operator back for a fresh look.
         */
        previewedOrganizationIds: preview.candidates.map((c) => c.organizationId),
        previewDigest: preview.digest,
        previewedAt: preview.previewedAt,
        reason: reason.trim(),
        confirmation,
        operationId,
      });

      /*
       * Remove the purged tenants' books from THIS browser.
       *
       * The server cannot do this: Ledgora's accounting records live in browser
       * storage, so the only machine that can delete a given copy is the one
       * holding it. An operator who used subscriber-view accumulates tenant
       * workspaces locally, and those would otherwise outlive the tenant.
       *
       * Driven strictly by `deleted === true` from the server response — ids it
       * confirmed it destroyed. Never by the selection, which is what the
       * operator ASKED to delete and includes anything that failed.
       */
      for (const organization of outcome.organizations) {
        if (!organization.deleted) continue;
        purgeBusinessWorkspace({ kind: 'tenant', organizationId: organization.organizationId });
      }

      setResult(outcome);
      setConfirmation('');
      setReason('');
      // The preview describes a world that no longer exists. Replace it,
      // but keep the outcome on screen.
      await loadPreview(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The cleanup could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * `operationId` omitted means "everything still outstanding", which is what
   * the standing notice needs: the operation that left those files behind may
   * belong to a session that ended long ago.
   */
  const retryFiles = async (operationId?: string) => {
    setBusy(true);
    try {
      const summary = await cleanupApi.retryFiles(operationId);
      if (operationId) {
        setResult((current) => (current ? { ...current, externalCleanup: summary } : current));
      }
      setOutstandingFiles(await cleanupApi.fileStatus());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The retry failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="disposable-cleanup-panel">
      <CardHeader
        title="Clean up test/demo data"
        description="Permanently delete disposable subscribers from Ledgora’s platform. Production subscribers can only be archived."
      />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadPreview()} disabled={busy}>
            Refresh preview
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || eligible.length === 0}
            onClick={() => setSelected(eligible.map((c) => c.organizationId))}
            data-testid="cleanup-select-all"
          >
            Select all eligible ({eligible.length})
          </Button>
          {selected.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setSelected([])} disabled={busy}>
              Clear selection
            </Button>
          )}
        </div>

        {error && (
          <div data-testid="cleanup-error">
            <Alert variant="error" title="Cleanup could not proceed">
              {error}
            </Alert>
          </div>
        )}

        {result && (
          <div data-testid="cleanup-result">
            <Alert
              variant={result.outcome === 'completed' ? 'success' : result.outcome === 'failed' ? 'error' : 'warning'}
              title={
                result.outcome === 'completed'
                  ? 'Cleanup completed'
                  : result.outcome === 'failed'
                    ? 'Cleanup did not complete'
                    : 'Completed, with file cleanup outstanding'
              }
            >
              {/*
                Database and external state are reported SEPARATELY and always.
                Folding them into one "done" would let a failed object deletion
                hide behind a successful row deletion.
              */}
              <p>
                Database: {result.databaseDeletion.succeeded} deleted, {result.databaseDeletion.failed} failed.
              </p>
              <p>
                Files: {result.externalCleanup.completed} removed, {result.externalCleanup.pending} pending,{' '}
                {result.externalCleanup.failed} failed.
              </p>
              {/*
                The third layer, stated rather than left to inference. Reporting
                only database and files would let a reader conclude the books
                were covered by one of them.
              */}
              <p data-testid="cleanup-workspace-state">
                Accounting workspaces: not deleted by the server.{' '}
                {result.workspaceDeletion?.detail ??
                  'Records live in each user’s browser workspace, not on the server.'}{' '}
                Local copies held by this browser have been removed.
              </p>
              {result.organizations
                .filter((o) => !o.deleted)
                .map((o) => (
                  <p key={o.organizationId} className="text-sm">
                    {o.legalName}: {o.error}
                  </p>
                ))}
              {result.externalCleanup.pending > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void retryFiles(result.operationId)}
                  disabled={busy}
                >
                  Retry file cleanup
                </Button>
              )}
            </Alert>
          </div>
        )}

        {/*
          Leftover object deletions from ANY operation, shown whether or not
          this session caused them. The database rows are already gone; these
          files are what is left of a tenant that is otherwise deleted, so the
          notice stays until the ledger is actually clear.
        */}
        {outstandingFileCount > 0 && (
          <div data-testid="cleanup-outstanding-files">
            <Alert variant="warning" title="File cleanup is outstanding">
              <p>
                {outstandingFiles?.pending ?? 0} stored file(s) pending and {outstandingFiles?.failed ?? 0}{' '}
                failed from earlier deletions. The database rows are already gone; these objects are not.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void retryFiles()}
                disabled={busy}
                data-testid="cleanup-retry-all-files"
              >
                Retry file cleanup
              </Button>
            </Alert>
          </div>
        )}

        {preview && (
          <>
            <section>
              <h3 className="text-sm font-semibold">Eligible ({eligible.length})</h3>
              {eligible.length === 0 ? (
                <p className="mt-1 text-sm text-slate-500">
                  No disposable subscribers are currently eligible for permanent deletion.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {eligible.map((candidate) => (
                    <CandidateCard
                      key={candidate.organizationId}
                      candidate={candidate}
                      selected={selected.includes(candidate.organizationId)}
                      onToggle={toggle}
                    />
                  ))}
                </ul>
              )}
            </section>

            {excluded.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold">Excluded ({excluded.length})</h3>
                <p className="mt-1 text-xs text-slate-500">
                  These cannot be deleted. The reason is shown against each one.
                </p>
                <ul className="mt-2 space-y-2">
                  {excluded.map((candidate) => (
                    <CandidateCard
                      key={candidate.organizationId}
                      candidate={candidate}
                      selected={false}
                      onToggle={toggle}
                    />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        {selected.length > 0 && (
          <section className="rounded-lg border border-red-200 bg-red-50 p-3">
            <h3 className="text-sm font-semibold text-red-900">
              Permanently delete {selected.length} subscriber{selected.length === 1 ? '' : 's'} from Ledgora’s
              platform
            </h3>
            <p className="mt-1 text-xs text-red-800" data-testid="cleanup-disclosure">
              {PERMANENT_DELETION_DISCLOSURE}
            </p>
            <p className="mt-1 text-xs text-red-800">
              This cannot be undone. People who belong to other organizations keep their accounts.
            </p>

            <label className="mt-3 block text-xs font-medium text-slate-700">
              Reason (recorded in the deletion record)
              <textarea
                className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                data-testid="cleanup-reason"
              />
            </label>

            <label className="mt-2 block text-xs font-medium text-slate-700">
              Type <span className="font-mono">{CONFIRMATION_PHRASE}</span> to confirm
              <input
                className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                data-testid="cleanup-confirmation"
              />
            </label>

            <Button
              className="mt-3"
              variant="danger"
              size="sm"
              disabled={!canExecute}
              onClick={() => void execute()}
              data-testid="cleanup-execute"
            >
              {busy ? 'Deleting…' : 'Permanently delete selected'}
            </Button>
          </section>
        )}
      </div>
    </Card>
  );
}
