/**
 * The closure impact report.
 *
 * ── The distinction this component exists to preserve ────────────────────────
 * `serverVerifiable: false` means the account service CANNOT COUNT a category —
 * not that the category is empty. Ledgora's accounting records live in the
 * customer's browser workspace, so journal entries, business documents and
 * locked periods are genuinely invisible from the server.
 *
 * Rendering those as `0` would tell an operator "this subscriber has no
 * accounting data" on the screen where they decide whether to destroy it. So
 * they are rendered as "cannot be verified here", in a distinct tone, with the
 * server's own note attached — and the limitation is stated once more in plain
 * language beneath the table.
 *
 * Everything shown here comes from the server's assessment, recomputed on every
 * call. This component performs no eligibility logic of its own; it has no
 * opinion about whether deletion is permitted and simply renders the verdict.
 */
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import type { DeletionImpact } from '@/services/api/closureApi';

export function ClosureImpactReport({ impact }: { impact: DeletionImpact }) {
  const unverifiable = impact.counts.filter((c) => !c.serverVerifiable);

  return (
    <div className="space-y-3" data-testid="closure-impact">
      {/* ── The verdict ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Permanent deletion
        </span>
        <span data-testid="impact-verdict">
          {impact.deletionPermitted ? (
            /*
              A clean disposable tenant has nothing for a recovery window to
              protect, so saying only "Eligible" would leave an operator
              expecting the 30-day wait that no longer applies to it.
            */
            impact.immediatePurgeEligible ? (
              <Badge tone="green">Eligible for immediate permanent deletion</Badge>
            ) : (
              <Badge tone="green">Eligible</Badge>
            )
          ) : (
            <Badge tone="red">Not eligible</Badge>
          )}
        </span>
        <span className="text-xs text-slate-400">
          assessed {new Date(impact.assessedAt).toLocaleString()}
        </span>
      </div>

      {/* ── Every blocker the server returned ───────────────────────────── */}
      {impact.blockingReasons.length > 0 && (
        <div
          className="rounded-lg border border-red-200 bg-red-50/60 p-3 dark:border-red-500/30 dark:bg-red-500/10"
          data-testid="impact-blockers"
        >
          <h4 className="text-xs font-semibold uppercase tracking-wide text-red-700 dark:text-red-300">
            Why deletion is blocked
          </h4>
          <ul className="mt-2 space-y-1.5 text-sm text-red-800 dark:text-red-200">
            {impact.blockingReasons.map((blocker) => (
              <li key={blocker.code} data-testid={`blocker-${blocker.code}`} className="flex gap-2">
                <span aria-hidden>·</span>
                <span>{blocker.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── People, one line each ───────────────────────────────────────── */}
      {impact.people && impact.people.length > 0 && (
        <div
          className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
          data-testid="impact-people"
        >
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">People</h4>
          <ul className="mt-2 space-y-2 text-sm">
            {impact.people.map((person) => (
              <li key={person.userId} data-testid={`impact-person-${person.userId}`}>
                <span className="font-medium">{person.email}</span>{' '}
                {/*
                  Disposable and retained are visually distinct because this is
                  the line that answers "will deleting this tenant delete my
                  colleague's login?" — a question a generic "members will be
                  anonymised" summary cannot answer at all.
                */}
                {person.outcome === 'disposable' ? (
                  <Badge tone="red">disposable — will be deleted</Badge>
                ) : (
                  <Badge tone="green">retained — membership removed</Badge>
                )}
                <span className="block text-xs text-slate-500 dark:text-slate-400">{person.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Why the shortcut is unavailable ─────────────────────────────── */}
      {impact.deletionPermitted &&
        !impact.immediatePurgeEligible &&
        (impact.immediatePurgeBlockers?.length ?? 0) > 0 && (
          <div
            className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs dark:border-amber-500/30 dark:bg-amber-500/10"
            data-testid="impact-recovery-window"
          >
            <p className="font-semibold text-amber-800 dark:text-amber-200">
              A recovery window applies before the purge can run
            </p>
            <ul className="mt-1 space-y-1 text-amber-800 dark:text-amber-200">
              {impact.immediatePurgeBlockers!.map((blocker) => (
                <li key={blocker}>· {blocker}</li>
              ))}
            </ul>
          </div>
        )}

      {/* ── Counts ──────────────────────────────────────────────────────── */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800">
            <tr>
              <th className="px-3 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">
                Data held
              </th>
              <th className="px-3 py-2 text-right font-semibold text-slate-600 dark:text-slate-300">
                Found by the server
              </th>
            </tr>
          </thead>
          <tbody>
            {impact.counts.map((row) => (
              <tr
                key={row.key}
                className="border-t border-slate-100 dark:border-slate-800"
                data-testid={`impact-count-${row.key}`}
              >
                <td className="px-3 py-1.5">
                  <span className={row.serverVerifiable ? '' : 'text-amber-700 dark:text-amber-300'}>
                    {row.label}
                  </span>
                  {row.note && (
                    <span className="block text-[11px] text-slate-400 dark:text-slate-500">{row.note}</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right">
                  {row.serverVerifiable ? (
                    <span className="font-medium tabular-nums">{row.count}</span>
                  ) : (
                    /*
                     * Never a zero. "Cannot be verified" and "there is none" are
                     * different facts, and only one of them is true here.
                     */
                    <span data-testid={`unverifiable-${row.key}`}>
                      <Badge tone="amber">cannot be verified here</Badge>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── The architectural limitation, in plain language ─────────────── */}
      {unverifiable.length > 0 && (
        <Alert variant="warning" title="Accounting data is not visible to the account service">
          <p data-testid="browser-storage-limitation">
            Ledgora keeps the ledger, business documents and locked periods in the customer&rsquo;s browser
            workspace, not on the server. The {unverifiable.length} categor
            {unverifiable.length === 1 ? 'y' : 'ies'} marked above cannot be counted from here, and a blank
            count is <span className="font-semibold">not</span> evidence that the subscriber has none.
          </p>
          <p className="mt-1.5">
            They are also not included in a server-generated export, and are not removed by a server-side
            purge. Export them from inside the subscriber&rsquo;s workspace before closing the account.
          </p>
        </Alert>
      )}

      {/* ── Retained vs removed ─────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Section title="Always retained" tone="slate" items={impact.willBeRetained} testId="will-retain" />
        {impact.willBeAnonymized.length > 0 && (
          <Section
            title="Anonymised in place"
            tone="amber"
            items={impact.willBeAnonymized}
            testId="will-anonymize"
          />
        )}
        {impact.willBePermanentlyDeleted.length > 0 && (
          <Section
            title="Permanently deleted"
            tone="red"
            items={impact.willBePermanentlyDeleted}
            testId="will-delete"
          />
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  tone,
  items,
  testId,
}: {
  title: string;
  tone: 'slate' | 'amber' | 'red';
  items: string[];
  testId: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700" data-testid={testId}>
      <div className="mb-1.5">
        <Badge tone={tone}>{title}</Badge>
      </div>
      <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
        {items.map((item) => (
          <li key={item} className="flex gap-1.5">
            <span aria-hidden>·</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
