import { useMemo } from 'react';
import type { Account, IFRSStatement } from '@/types';
import { useStore } from '@/store/useStore';
import { IFRS_STATEMENT_META } from '@/data/ifrsOptions';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import {
  BalanceBadge,
  StatusBadge,
  TypeBadge,
} from '@/components/shared/AccountBadges';
import { AccountDot } from '@/components/shared/AccountChip';
import { humanize, cn } from '@/lib/utils';

/** Order in which statements are presented. */
const STATEMENT_ORDER: IFRSStatement[] = [
  'STATEMENT_OF_FINANCIAL_POSITION',
  'PROFIT_OR_LOSS',
  'OCI',
  'STATEMENT_OF_CHANGES_IN_EQUITY',
  'CASH_FLOW',
  'CONTROL',
  'NOTES',
];

interface CategoryGroup {
  category: string;
  accounts: Account[];
}

interface StatementGroup {
  statement: IFRSStatement;
  categories: CategoryGroup[];
  total: number;
}

export function IFRSMappingTable() {
  const accounts = useStore((s) => s.accounts);
  const presentationMode = useStore((s) => s.settings.presentationMode);

  const groups = useMemo<StatementGroup[]>(() => {
    const byStatement = new Map<IFRSStatement, Account[]>();
    for (const acc of accounts) {
      const list = byStatement.get(acc.ifrsStatement) ?? [];
      list.push(acc);
      byStatement.set(acc.ifrsStatement, list);
    }

    return STATEMENT_ORDER.filter((s) => byStatement.has(s)).map((statement) => {
      const list = (byStatement.get(statement) ?? []).sort((a, b) =>
        a.code.localeCompare(b.code),
      );
      const byCategory = new Map<string, Account[]>();
      for (const acc of list) {
        const key = acc.ifrsCategory || 'Uncategorised';
        const cat = byCategory.get(key) ?? [];
        cat.push(acc);
        byCategory.set(key, cat);
      }
      const categories = [...byCategory.entries()]
        .map(([category, accs]) => ({ category, accounts: accs }))
        .sort((a, b) => a.category.localeCompare(b.category));
      return { statement, categories, total: list.length };
    });
  }, [accounts]);

  return (
    <div className="space-y-6">
      {groups.map((group) => {
        const meta = IFRS_STATEMENT_META[group.statement];
        return (
          <Card key={group.statement}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <Badge tone={meta.tone}>{meta.short}</Badge>
                  {meta.label}
                </span>
              }
              description={`${group.total} account${group.total === 1 ? '' : 's'} mapped to this statement`}
            />
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {group.categories.map((cat) => (
                <div key={cat.category} className="px-5 py-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {cat.category}
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-sm">
                      <thead>
                        <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:border-slate-800">
                          <th className="pb-2 pr-4">Code</th>
                          <th className="pb-2 pr-4">Account</th>
                          <th className="pb-2 pr-4">Subcategory</th>
                          <th className="pb-2 pr-4">Type</th>
                          <th className="pb-2 pr-4">Cash flow</th>
                          {presentationMode === 'IFRS_18' && (
                            <th className="pb-2 pr-4">P&L (IFRS 18)</th>
                          )}
                          <th className="pb-2">Balance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50 dark:divide-slate-800/50">
                        {cat.accounts.map((acc) => (
                          <tr
                            key={acc.id}
                            className={cn(
                              'transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-800/30',
                              !acc.isActive && 'opacity-50',
                            )}
                          >
                            <td className="py-2 pr-4 font-mono text-xs text-slate-500">{acc.code}</td>
                            <td className="py-2 pr-4">
                              <span className="flex items-center gap-2">
                                <AccountDot type={acc.type} />
                                <span
                                  className={
                                    acc.isPostingAccount
                                      ? 'text-slate-700 dark:text-slate-200'
                                      : 'font-semibold text-slate-900 dark:text-slate-100'
                                  }
                                >
                                  {acc.name}
                                </span>
                                {!acc.isActive && <StatusBadge isActive={false} />}
                              </span>
                            </td>
                            <td className="py-2 pr-4 text-slate-500 dark:text-slate-400">
                              {acc.ifrsSubcategory || '—'}
                            </td>
                            <td className="py-2 pr-4">
                              <TypeBadge type={acc.type} />
                            </td>
                            <td className="py-2 pr-4 text-slate-500 dark:text-slate-400">
                              {humanize(acc.cashFlowCategory)}
                            </td>
                            {presentationMode === 'IFRS_18' && (
                              <td className="py-2 pr-4 text-slate-500 dark:text-slate-400">
                                {acc.profitOrLossCategory && acc.profitOrLossCategory !== 'NOT_APPLICABLE'
                                  ? humanize(acc.profitOrLossCategory)
                                  : '—'}
                              </td>
                            )}
                            <td className="py-2">
                              <BalanceBadge normalBalance={acc.normalBalance} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
