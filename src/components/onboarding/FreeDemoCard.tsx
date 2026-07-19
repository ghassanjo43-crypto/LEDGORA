/**
 * The Free Demo option shown alongside the paid packages: $0, no payment, no
 * permanent storage. Selecting it always goes through the confirmation dialog.
 */
import { useState } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { FREE_DEMO_COPY, FREE_DEMO_LIMITS } from '@/config/freeDemo';
import { FreeDemoConfirmDialog } from './FreeDemoConfirmDialog';

const INCLUDED = ['Journals and the general ledger', 'Invoices, bills, receipts and payments', 'Trial balance and IFRS statements'];

export function FreeDemoCard({ onChoosePackage }: { onChoosePackage: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <section
        aria-labelledby="free-demo-heading"
        className="rounded-2xl border border-brand-200 bg-brand-50/40 p-5 dark:border-brand-500/30 dark:bg-brand-500/5"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand-600 dark:text-brand-400" aria-hidden />
              <h2 id="free-demo-heading" className="text-base font-semibold text-slate-900 dark:text-slate-50">
                {FREE_DEMO_COPY.title}
              </h2>
              <Badge tone="green">$0</Badge>
            </div>
            <p className="mt-1.5 max-w-xl text-sm text-slate-600 dark:text-slate-300">
              {FREE_DEMO_COPY.description}
            </p>
          </div>
          <Button onClick={() => setOpen(true)}>{FREE_DEMO_COPY.cta}</Button>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <ul className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300">
            {INCLUDED.map((item) => (
              <li key={item} className="flex items-start gap-1.5">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
          <ul className="space-y-1.5 text-xs text-slate-500 dark:text-slate-400">
            {FREE_DEMO_LIMITS.map((item) => (
              <li key={item} className="flex items-start gap-1.5">
                <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <FreeDemoConfirmDialog
        open={open}
        onCancel={() => setOpen(false)}
        onChoosePackage={() => {
          setOpen(false);
          onChoosePackage();
        }}
      />
    </>
  );
}
