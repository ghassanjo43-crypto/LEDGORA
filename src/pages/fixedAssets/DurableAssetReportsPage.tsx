/**
 * Fixed-asset reports a durable subscriber can actually rely on.
 *
 * ══ Why there is no reconciliation here ══════════════════════════════════════
 *
 * The browser module's headline report reconciles the register to the general
 * ledger. That comparison needs a registered cost and a posted balance, and this
 * release has neither — so the report would compare nothing to nothing and
 * announce that the books balance. A green tick nobody earned is worse than an
 * absent report, because somebody signs under it.
 *
 * ══ Counts, never money ══════════════════════════════════════════════════════
 *
 * Every figure below is a count of records. There is no acquisition-cost total,
 * because there is no acquisition cost. A money column here would be compared to
 * a balance sheet, and it would agree with nothing.
 */
import { useEffect } from 'react';
import {
  loadRegisterReport,
  useServerFixedAssets,
} from '@/services/fixedAssets/fixedAssetsBackend';
import { useFixedAssetRegister } from '@/services/fixedAssets/useFixedAssetRegister';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { emptyRow, Table } from './FixedAssetsShared';
import { DeferredAccountingPanel } from './DeferredAccounting';

export function DurableAssetReportsPage() {
  const { report, capabilities } = useFixedAssetRegister();
  const reportState = useServerFixedAssets((s) => s.reportState);

  useEffect(() => {
    if (reportState === 'idle') void loadRegisterReport();
  }, [reportState]);

  return (
    <div className="space-y-4">
      <Alert variant="info" title="Register figures, not ledger balances">
        {report?.note
          ?? 'These are counts of records somebody has entered. They are not general-ledger '
            + 'balances and do not reconcile to one: this release records no acquisition cost and '
            + 'posts no journal.'}
      </Alert>

      {reportState === 'unavailable' && (
        <Alert variant="error" title="The report could not be loaded">
          Nothing is shown rather than a figure from this browser.{' '}
          <Button size="sm" variant="outline" onClick={() => void loadRegisterReport()}>
            Try again
          </Button>
        </Alert>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Categories" value={String(report.totals.categories)} />
            <Stat label="Assets registered" value={String(report.totals.draftAssets)} />
            <Stat label="Assets archived" value={String(report.totals.archivedAssets)} />
            <Stat label="Units" value={String(report.totals.totalUnits)} />
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Register by category</h3>
            <Table
              head={['Code', 'Category', 'Status', 'Registered', 'Archived', 'Total', 'Units', 'Mappings']}
              minWidth={860}
            >
              {report.byCategory.map((row) => (
                <tr key={row.categoryId} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2 font-medium">{row.categoryCode}</td>
                  <td className="px-4 py-2">{row.categoryName}</td>
                  <td className="px-4 py-2">
                    <Badge tone={row.categoryStatus === 'active' ? 'green' : 'slate'}>
                      {row.categoryStatus}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.draftAssets}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.archivedAssets}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.totalAssets}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.totalUnits}</td>
                  <td className="px-4 py-2">
                    {row.mappingComplete
                      ? <Badge tone="green">complete</Badge>
                      : <Badge tone="amber">incomplete</Badge>}
                  </td>
                </tr>
              ))}
              {report.byCategory.length === 0 && emptyRow(8, 'No asset categories yet.')}
            </Table>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Configuration that would stop depreciation</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Depreciation posting will be refused for anything listed here. Finding it now is the
              point of this report — the alternative is finding it one asset at a time on the day
              the first run is attempted.
            </p>
            <Table head={['What', 'Code', 'Name', 'Problem']} minWidth={760}>
              {report.configurationIssues.map((issue) => (
                <tr
                  key={`${issue.subjectType}-${issue.subjectId}`}
                  className="border-t border-slate-100 dark:border-slate-800"
                >
                  <td className="px-4 py-2 text-slate-500">{issue.subjectType}</td>
                  <td className="px-4 py-2 font-medium">{issue.code}</td>
                  <td className="px-4 py-2">{issue.name}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{issue.detail}</td>
                </tr>
              ))}
              {report.configurationIssues.length === 0 && emptyRow(
                4, 'Nothing is missing — every category maps the accounts it needs.',
              )}
            </Table>
          </section>
        </>
      )}

      <DeferredAccountingPanel
        capabilities={capabilities}
        heading="Reports that need postings first"
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardBody className="py-3">
        <div className="text-[11px] uppercase text-slate-400">{label}</div>
        <div className="text-lg font-semibold tabular-nums">{value}</div>
      </CardBody>
    </Card>
  );
}
