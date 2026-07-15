import { ChevronLeft, ChevronRight } from 'lucide-react';
import { pageNumbers } from '@/lib/journalWorkspace';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/utils';

export function JournalPagination({
  page,
  totalPages,
  from,
  to,
  total,
  rowsPerPage,
  onPage,
  onRowsPerPage,
}: {
  page: number;
  totalPages: number;
  from: number;
  to: number;
  total: number;
  rowsPerPage: number;
  onPage: (p: number) => void;
  onRowsPerPage: (n: number) => void;
}) {
  const nums = pageNumbers(page, totalPages);
  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 dark:border-slate-800 sm:flex-row">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Showing <span className="font-medium text-slate-700 dark:text-slate-200">{from}</span> to{' '}
        <span className="font-medium text-slate-700 dark:text-slate-200">{to}</span> of{' '}
        <span className="font-medium text-slate-700 dark:text-slate-200">{total}</span> entries
      </p>

      <div className="flex items-center gap-1">
        <PageBtn label="Previous" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" />
        </PageBtn>
        {nums.map((n, i) =>
          n === '…' ? (
            <span key={`e${i}`} className="px-1.5 text-sm text-slate-400">…</span>
          ) : (
            <button
              key={n}
              type="button"
              onClick={() => onPage(n)}
              aria-current={n === page ? 'page' : undefined}
              className={cn(
                'focus-ring flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm font-medium transition-colors',
                n === page ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
              )}
            >
              {n}
            </button>
          ),
        )}
        <PageBtn label="Next" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          <ChevronRight className="h-4 w-4" />
        </PageBtn>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500 dark:text-slate-400">Rows per page</span>
        <Select
          className="h-8 w-auto"
          options={[
            { value: '20', label: '20' },
            { value: '50', label: '50' },
            { value: '100', label: '100' },
          ]}
          value={String(rowsPerPage)}
          onChange={(e) => onRowsPerPage(Number(e.target.value))}
          aria-label="Rows per page"
        />
      </div>
    </div>
  );
}

function PageBtn({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800"
    >
      {children}
    </button>
  );
}
