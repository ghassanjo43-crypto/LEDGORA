import { Check } from 'lucide-react';
import type { LedgoraEdition } from '@/types/entitlements';
import { EDITION_INFO_LIST } from '@/config/editionCommercialInfo';
import { cn } from '@/lib/utils';

/**
 * Edition selection cards. Used both in the subscription settings page and as
 * the onboarding "Which Ledgora edition fits your business?" step.
 */
export function EditionSelector({
  value,
  onSelect,
}: {
  value: LedgoraEdition;
  onSelect: (edition: LedgoraEdition) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {EDITION_INFO_LIST.map((info) => {
        const active = info.edition === value;
        return (
          <button
            key={info.edition}
            type="button"
            onClick={() => onSelect(info.edition)}
            className={cn(
              'focus-ring flex flex-col rounded-xl border p-4 text-left transition-colors',
              active
                ? 'border-brand-400 bg-brand-50/60 ring-1 ring-brand-400 dark:border-brand-500/50 dark:bg-brand-500/10'
                : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50',
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {info.name}
              </span>
              {active && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white">
                  <Check className="h-3.5 w-3.5" />
                </span>
              )}
            </div>
            <span className="mt-0.5 text-xs font-medium text-brand-600 dark:text-brand-300">
              {info.tagline}
            </span>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {info.description}
            </p>
            <ul className="mt-3 space-y-1">
              {info.highlights.map((h) => (
                <li key={h} className="flex items-start gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          </button>
        );
      })}
    </div>
  );
}
