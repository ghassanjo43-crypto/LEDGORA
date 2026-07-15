import { useRef, useState, type ReactNode } from 'react';
import type { Account } from '@/types';
import { accountColor } from '@/lib/accountDisplay';
import { accountTypeLabel, IFRS_STATEMENT_META } from '@/data/ifrsOptions';
import { humanize, cn } from '@/lib/utils';

/** Small solid colour indicator for an account family. */
export function AccountDot({ type, className }: { type?: Account['type']; className?: string }) {
  return (
    <span
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', accountColor(type).dot, className)}
      aria-hidden
    />
  );
}

interface AccountChipProps {
  /** Live account, when available — enables the family colour + hover card. */
  account?: Account | undefined;
  /** Snapshot code (used when the live account is unavailable). */
  code: string;
  /** Snapshot name. */
  name: string;
  /** Stack code over name (default) or render inline. */
  inline?: boolean;
  className?: string;
}

/**
 * Canonical way to display an account across the app: a family colour dot, the
 * code, the name and — on hover — a rich card with IFRS mapping and posting
 * details so users never have to open the account to understand it.
 */
export function AccountChip({ account, code, name, inline, className }: AccountChipProps) {
  const color = accountColor(account?.type);
  const body = (
    <span className={cn('flex min-w-0 items-start gap-2', className)}>
      {inline ? (
        <span className="flex min-w-0 items-center truncate">
          <AccountDot type={account?.type} className="mr-2" />
          <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{code}</span>
          <span className="ml-2 text-sm text-slate-700 dark:text-slate-200">{name}</span>
        </span>
      ) : (
        <span className="min-w-0">
          <span className="block font-mono text-[11px] font-medium text-slate-400">{code || '—'}</span>
          <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100">
            {name || <span className="text-red-500">No account</span>}
          </span>
          {account && (
            <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-300">
              <span className={cn('h-1.5 w-1.5 rounded-full', color.dot)} />
              {color.family}
            </span>
          )}
        </span>
      )}
    </span>
  );

  if (!account) return body;
  return <AccountHoverCard account={account}>{body}</AccountHoverCard>;
}

/** Hover popover with hierarchy / IFRS mapping / normal balance / posting. */
export function AccountHoverCard({
  account,
  children,
}: {
  account: Account;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const color = accountColor(account.type);
  const stmt = IFRS_STATEMENT_META[account.ifrsStatement];

  const show = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 250);
  };
  const hide = (): void => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <span className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {open && (
        <span className="absolute left-0 top-full z-50 mt-1.5 block w-72 animate-fade-in rounded-xl border border-slate-200 bg-white p-3 text-left shadow-dropdown dark:border-slate-700 dark:bg-slate-900">
          <span className="mb-2 flex items-center gap-2">
            <span className={cn('inline-block h-2.5 w-2.5 rounded-full', color.dot)} />
            <span className="font-mono text-xs text-slate-400">{account.code}</span>
            <span className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
              {account.name}
            </span>
          </span>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 text-xs">
            <HoverRow label="Type" value={`${accountTypeLabel(account.type)} · ${color.family}`} />
            <HoverRow label="Statement" value={stmt.label} />
            <HoverRow label="Category" value={account.ifrsCategory || '—'} />
            {account.ifrsSubcategory && <HoverRow label="Subcategory" value={account.ifrsSubcategory} />}
            <HoverRow label="Normal balance" value={account.normalBalance === 'DEBIT' ? 'Debit' : 'Credit'} />
            <HoverRow label="Posting" value={account.isPostingAccount ? 'Posting account' : 'Header account'} />
            <HoverRow label="Cash flow" value={humanize(account.cashFlowCategory)} />
            <HoverRow label="Status" value={account.isActive ? 'Active' : 'Inactive'} />
          </dl>
          {account.description && (
            <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
              {account.description}
            </p>
          )}
        </span>
      )}
    </span>
  );
}

function HoverRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-slate-400">{label}</dt>
      <dd className="truncate font-medium text-slate-700 dark:text-slate-200">{value}</dd>
    </>
  );
}
