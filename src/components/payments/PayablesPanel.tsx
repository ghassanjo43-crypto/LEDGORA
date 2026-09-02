/**
 * What is owed, and to whom — entirely as the server computed it.
 *
 * ══ Nothing on this screen is derived here ═══════════════════════════════════
 *
 * The outstanding amounts, the ageing buckets, the running balance and the
 * reconciliation verdict all arrive resolved. There is no netting, no bucketing
 * and no summing in this file beyond rendering what came back, because a second
 * answer computed in the browser would disagree with the ledger the moment a
 * reallocation landed — and the disagreement would be invisible, since a wrong
 * number still looks like a number.
 *
 * The reconciliation line is shown rather than hidden. The server compares the
 * statement's running balance against the sum of outstanding bills by two
 * different routes; a user who is about to act on this figure is entitled to
 * know the two agree.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import type {
  ServerAgedPayables, ServerOutstandingBill, ServerSupplierStatement,
} from '@/services/api/paymentsApi';
import { paymentsApi } from '@/services/api/paymentsApi';
import { useServerPayments } from '@/services/payments/paymentBackend';
import { useSuppliers } from '@/services/parties/useSuppliers';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { Input, Field } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { Banknote } from 'lucide-react';

const NUM = 'whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums';

const today = (): string => new Date().toISOString().slice(0, 10);

export function PayablesPanel({ currency }: { currency: string }) {
  const outstanding = useServerPayments((s) => s.outstanding);
  const aging = useServerPayments((s) => s.aging);
  const state = useServerPayments((s) => s.state);
  const { suppliers } = useSuppliers();

  const [supplierId, setSupplierId] = useState('');
  const [periodStart, setPeriodStart] = useState(`${today().slice(0, 4)}-01-01`);
  const [periodEnd, setPeriodEnd] = useState(today());

  const [statement, setStatement] = useState<ServerSupplierStatement | null>(null);
  const [statementError, setStatementError] = useState<string | null>(null);
  const [loadingStatement, setLoadingStatement] = useState(false);

  /*
   * The statement is fetched on demand rather than cached with the directory:
   * it is a report over a chosen period, and a stale one shown beside a fresh
   * balance would be two answers to the same question.
   */
  useEffect(() => {
    if (!supplierId) { setStatement(null); setStatementError(null); return; }
    let cancelled = false;
    setLoadingStatement(true);
    setStatementError(null);
    paymentsApi.statement({ supplierId, periodStart, periodEnd })
      .then((result) => { if (!cancelled) setStatement(result); })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setStatement(null);
        setStatementError(cause instanceof Error ? cause.message : 'Could not load the statement.');
      })
      .finally(() => { if (!cancelled) setLoadingStatement(false); });
    return () => { cancelled = true; };
  }, [supplierId, periodStart, periodEnd]);

  const money = (value: string | number, code = currency): string =>
    formatCurrency(Number(value), code);

  return (
    <div className="space-y-4" data-testid="payables-panel">
      <AgeingCard aging={aging} loading={state === 'loading'} money={money} />
      <OutstandingCard rows={outstanding} money={money} />

      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <Field label="Supplier statement">
                <Select
                  aria-label="Statement supplier"
                  options={[
                    { value: '', label: 'Choose a supplier…' },
                    ...suppliers.map((s) => ({ value: s.id, label: s.legalName })),
                  ]}
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                />
              </Field>
            </div>
            <Field label="From">
              <Input aria-label="Statement from" type="date" value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)} />
            </Field>
            <Field label="To">
              <Input aria-label="Statement to" type="date" value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)} />
            </Field>
          </div>

          {loadingStatement && (
            <p role="status" className="flex items-center gap-2 text-sm text-slate-500">
              <RefreshCw className="h-4 w-4 animate-spin" /> Reading the statement from the server…
            </p>
          )}

          {statementError && (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {statementError}
            </p>
          )}

          {statement && <Statement statement={statement} money={money} />}

          {!supplierId && !loadingStatement && (
            <p className="text-xs text-slate-500">
              Choose a supplier to see every bill, payment and reversal on their account, with the
              balance the server ran forward.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function AgeingCard({ aging, loading, money }: {
  aging: ServerAgedPayables | null;
  loading: boolean;
  money: (value: string | number, code?: string) => string;
}) {
  if (loading && !aging) {
    return (
      <Card><CardBody>
        <p role="status" className="flex items-center gap-2 text-sm text-slate-500">
          <RefreshCw className="h-4 w-4 animate-spin" /> Reading what is owed from the server…
        </p>
      </CardBody></Card>
    );
  }
  if (!aging) return null;

  return (
    <Card>
      <CardBody>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Accounts payable ageing
          </h3>
          <p className="text-xs text-slate-500">
            As of {aging.asOfDate} · aged by due date on what is still owed
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm" data-testid="ap-ageing">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400">
              <tr>
                {aging.buckets.map((bucket) => (
                  <th key={bucket.id} className="px-3 py-2 text-right font-semibold">{bucket.label}</th>
                ))}
                <th className="px-3 py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                {aging.buckets.map((bucket) => (
                  <td key={bucket.id} className={NUM} data-testid={`ageing-${bucket.id}`}>
                    {money(bucket.amount, aging.currency)}
                  </td>
                ))}
                <td className={cx(NUM, 'font-semibold')} data-testid="ageing-total">
                  {money(aging.total, aging.currency)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}

function OutstandingCard({ rows, money }: {
  rows: ServerOutstandingBill[];
  money: (value: string | number, code?: string) => string;
}) {
  if (rows.length === 0) {
    return (
      <Card><CardBody>
        <EmptyState icon={Banknote} title="Nothing outstanding"
          description="Every posted bill in these books has been settled in full." />
      </CardBody></Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm" data-testid="outstanding-schedule">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400">
            <tr>
              {['Bill', 'Supplier', 'Due', 'Total', 'Paid', 'Outstanding', 'Overdue', 'Bucket'].map((h) => (
                <th key={h} className={cx('px-3 py-2 font-semibold', ['Total', 'Paid', 'Outstanding', 'Overdue'].includes(h) ? 'text-right' : 'text-left')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => (
              <tr key={row.billId} data-testid="outstanding-row">
                <td className="px-3 py-2 font-mono text-xs font-semibold">{row.billNumber}</td>
                <td className="px-3 py-2">{row.supplierName}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{row.dueDate}</td>
                <td className={NUM}>{money(row.total, row.currency)}</td>
                <td className={cx(NUM, 'text-slate-500')}>{money(row.paid, row.currency)}</td>
                <td className={cx(NUM, 'font-semibold')} data-testid={`outstanding-${row.billNumber}`}>
                  {money(row.outstanding, row.currency)}
                </td>
                <td className={cx(NUM, 'text-slate-500')}>{row.daysOverdue > 0 ? `${row.daysOverdue}d` : '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{row.agingBucket}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Statement({ statement, money }: {
  statement: ServerSupplierStatement;
  money: (value: string | number, code?: string) => string;
}) {
  return (
    <div className="space-y-3" data-testid="supplier-statement">
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
        <span className="font-medium">{statement.supplierName}</span>
        <span className="text-slate-500">{statement.periodStart} → {statement.periodEnd}</span>
        <span>Opening <strong className="font-mono tabular-nums">{money(statement.openingBalance, statement.currency)}</strong></span>
        <span>Charges <strong className="font-mono tabular-nums">{money(statement.periodCharges, statement.currency)}</strong></span>
        <span>Paid <strong className="font-mono tabular-nums">{money(statement.periodPayments, statement.currency)}</strong></span>
        <span>
          Closing{' '}
          <strong className="font-mono tabular-nums" data-testid="statement-closing">
            {money(statement.closingBalance, statement.currency)}
          </strong>
        </span>
        {/* Two independent routes to the same figure. Shown, not hidden: a
            reader about to act on this balance is entitled to know they agree. */}
        <span data-testid="statement-reconciled">
          {statement.isReconciled ? (
            <Badge tone="green">
              <CheckCircle2 className="h-3 w-3" /> Reconciled with the bill subledger
            </Badge>
          ) : (
            <Badge tone="red">
              <AlertTriangle className="h-3 w-3" /> Out by {money(statement.reconciliationDifference, statement.currency)}
            </Badge>
          )}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/40">
            <tr>
              <th className="px-2 py-2 text-left">Date</th>
              <th className="px-2 py-2 text-left">Document</th>
              <th className="px-2 py-2 text-left">Description</th>
              <th className="px-2 py-2 text-right">Charged</th>
              <th className="px-2 py-2 text-right">Paid</th>
              <th className="px-2 py-2 text-right">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {statement.lines.map((line) => (
              <tr key={line.id} data-testid="statement-line">
                <td className="px-2 py-1.5 text-slate-500">{line.date}</td>
                <td className="px-2 py-1.5 font-mono">{line.documentNumber || '—'}</td>
                <td className="px-2 py-1.5">{line.description}</td>
                <td className={NUM}>{Number(line.credit) ? money(line.credit, statement.currency) : ''}</td>
                <td className={NUM}>{Number(line.debit) ? money(line.debit, statement.currency) : ''}</td>
                <td className={cx(NUM, 'font-semibold')}>{money(line.runningBalance, statement.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
