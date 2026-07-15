import { useMemo } from 'react';
import { FileText } from 'lucide-react';
import { useInvoices } from '@/store/billingHooks';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { InvoiceStatusBadge } from './SubscriptionInvoicePanel';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';

/** Full subscription-invoice history (newest first). */
export function InvoiceHistoryList() {
  const invoices = useInvoices();
  const ordered = useMemo(() => [...invoices].reverse(), [invoices]);

  if (ordered.length === 0) {
    return <EmptyState icon={FileText} title="No invoices yet" description="Subscription invoices appear here once you select a package." />;
  }

  return (
    <Card>
      <CardHeader title="Subscription invoices" description="Every subscription invoice, its period and payment status." />
      <CardBody className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
                <th className="px-4 py-2 font-medium">Invoice</th>
                <th className="px-4 py-2 font-medium">Package</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Period</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((inv) => (
                <tr key={inv.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-600 dark:text-slate-300">{inv.number}</td>
                  <td className="px-4 py-2.5 text-slate-700 dark:text-slate-200">{inv.planName}</td>
                  <td className="px-4 py-2.5 capitalize text-slate-500">{inv.changeType}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">{formatCurrency(inv.amount, inv.currency)}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{formatDate(inv.periodStart)} → {formatDate(inv.periodEnd)}</td>
                  <td className="px-4 py-2.5"><InvoiceStatusBadge status={inv.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}
