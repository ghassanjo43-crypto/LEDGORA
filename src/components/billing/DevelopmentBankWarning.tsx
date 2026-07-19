/**
 * Warning shown next to bank-remittance details while they are still the shipped
 * placeholders. Driven by the structured `isPlaceholder` flag (with a heuristic
 * fallback for legacy settings) — never by matching display text — so it
 * disappears automatically once real account information is configured.
 */
import { AlertTriangle } from 'lucide-react';
import type { BankDetails } from '@/types/billing';
import { isPlaceholderBankConfig } from '@/lib/bankDetails';

export const DEVELOPMENT_BANK_WARNING =
  'Development environment — Do not transfer real money. The bank information displayed below is for testing only.';

export function DevelopmentBankWarning({ bank, className }: { bank: BankDetails | null | undefined; className?: string }) {
  if (!isPlaceholderBankConfig(bank)) return null;

  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200 ${className ?? ''}`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>{DEVELOPMENT_BANK_WARNING}</p>
    </div>
  );
}
