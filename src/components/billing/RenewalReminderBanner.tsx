import { BellRing, ArrowRight } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useRenewalReminder } from '@/store/billingHooks';
import { cn } from '@/lib/utils';

const TONES = {
  info: 'border-brand-200 bg-brand-50 text-brand-800 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-200',
  warning: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
  error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
};

/**
 * Renewal reminder shown 7 / 3 / 0 days before expiry, during the grace period,
 * and once the grace period ends. Never rendered when nothing is due.
 */
export function RenewalReminderBanner() {
  const reminder = useRenewalReminder();
  const setActiveView = useStore((s) => s.setActiveView);
  if (!reminder) return null;

  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm print:hidden', TONES[reminder.severity])}>
      <BellRing className="h-4 w-4 shrink-0" />
      <span className="font-medium">{reminder.title}.</span>
      <span className="opacity-90">{reminder.message}</span>
      <button
        type="button"
        onClick={() => setActiveView('subscription')}
        className="focus-ring ml-auto inline-flex items-center gap-1 rounded font-medium underline-offset-2 hover:underline"
      >
        Renew now <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
