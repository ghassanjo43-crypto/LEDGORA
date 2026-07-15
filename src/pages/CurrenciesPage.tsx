import { useMemo, useState } from 'react';
import { Plus, ChevronDown, Pencil, Power, Archive, Coins, Star } from 'lucide-react';
import type { Currency } from '@/types/currency';
import { useStore } from '@/store/useStore';
import { useCurrencyStore } from '@/store/currencyStore';
import { formatCurrencyAmount } from '@/lib/currencyFormatting';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import type { BadgeTone } from '@/data/ifrsOptions';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { useToast } from '@/components/ui/Toast';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { Field } from '@/components/ui/Input';
import { CurrencyEditor } from '@/components/currencies/CurrencyEditor';
import { CurrencySelector } from '@/components/currencies/CurrencySelector';

const STATUS_TONE: Record<Currency['status'], BadgeTone> = { active: 'green', inactive: 'slate', archived: 'red' };

export function CurrenciesPage() {
  const accounts = useStore((s) => s.accounts);
  const currencies = useCurrencyStore((s) => s.currencies);
  const config = useCurrencyStore((s) => s.getConfig());
  const store = useCurrencyStore();
  const { notify } = useToast();
  const [editorId, setEditorId] = useState<string | null>(null);

  const rows = useMemo(() => [...currencies].sort((a, b) => a.code.localeCompare(b.code)), [currencies]);
  const act = (fn: () => { ok: boolean; error?: string }, ok: string): void => { const r = fn(); if (r.ok) notify(ok, 'success'); else notify(r.error ?? 'Action failed.', 'error'); };
  const onNew = (): void => { const r = store.createCurrency(); if (r.ok && r.id) setEditorId(r.id); };
  const toggleEnabled = (code: string): void => {
    if (config.allowedCurrencyCodes.includes(code)) act(() => store.disableCurrency(config.entityId, code), `${code} disabled for entity.`);
    else act(() => store.enableCurrency(config.entityId, code), `${code} enabled for entity.`);
  };

  return (
    <>
      <PageActions><Button onClick={onNew}><Plus className="h-4 w-4" /> New currency</Button></PageActions>

      {/* Entity currency configuration */}
      <Card className="mb-4"><CardBody>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Entity currency settings</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <Field label="Base currency">
            <CurrencySelector value={config.baseCurrencyCode} currencies={currencies} onChange={(code) => act(() => store.updateEntityConfig(config.entityId, { baseCurrencyCode: code }), `Base currency set to ${code}.`)} />
          </Field>
          <Field label="Realized FX gain account" className="sm:col-span-1"><AccountSelect value={config.realizedFxGainAccountId} accounts={accounts} onChange={(a) => store.updateEntityConfig(config.entityId, { realizedFxGainAccountId: a.id })} /></Field>
          <Field label="Realized FX loss account"><AccountSelect value={config.realizedFxLossAccountId} accounts={accounts} onChange={(a) => store.updateEntityConfig(config.entityId, { realizedFxLossAccountId: a.id })} /></Field>
          <Field label="Unrealized FX account"><AccountSelect value={config.unrealizedFxGainAccountId ?? ''} accounts={accounts} onChange={(a) => store.updateEntityConfig(config.entityId, { unrealizedFxGainAccountId: a.id, unrealizedFxLossAccountId: a.id })} /></Field>
        </div>
        <p className="mt-2 text-xs text-slate-500">Base currency is always rate 1.0 and cannot be disabled. Convention: <span className="font-mono">1 foreign = rate × base</span>.</p>
      </CardBody></Card>

      <Card className="overflow-hidden"><div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
            {['Code', 'Name', 'Symbol', 'Decimals', 'Sample', 'Enabled', 'Status', ''].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', h === 'Decimals' ? 'text-right' : 'text-left')}>{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((c) => {
              const isBase = c.code === config.baseCurrencyCode;
              const enabled = isBase || config.allowedCurrencyCodes.includes(c.code);
              return (
                <tr key={c.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                  <td className="px-3 py-2 font-mono text-xs font-semibold">{c.code} {isBase && <Star className="inline h-3 w-3 text-amber-500" />}</td>
                  <td className="px-3 py-2">{c.name}</td>
                  <td className="px-3 py-2">{c.symbol}</td>
                  <td className="px-3 py-2 text-right font-mono">{c.decimalPlaces}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{formatCurrencyAmount(1234.5, c)}</td>
                  <td className="px-3 py-2">
                    <button onClick={() => !isBase && toggleEnabled(c.code)} disabled={isBase} className={cx('rounded-md px-2 py-0.5 text-xs', enabled ? 'bg-green-50 text-green-700 dark:bg-green-500/10' : 'bg-slate-100 text-slate-500 dark:bg-slate-800', isBase && 'cursor-default')}>{enabled ? 'Enabled' : 'Disabled'}</button>
                  </td>
                  <td className="px-3 py-2"><Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge></td>
                  <td className="px-3 py-2 text-right">
                    <Dropdown label="Actions" align="right" trigger={(o) => (<span className={cx('inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300', o && 'bg-slate-50')}>Actions <ChevronDown className="h-3 w-3" /></span>)}>
                      <MenuItem onClick={() => setEditorId(c.id)}><Pencil className="h-4 w-4" /> {c.status === 'archived' ? 'View' : 'Edit'}</MenuItem>
                      {c.status === 'active' ? <MenuItem onClick={() => act(() => store.setCurrencyStatus(c.id, 'inactive'), 'Currency deactivated.')}><Power className="h-4 w-4" /> Deactivate</MenuItem> : c.status === 'inactive' ? <MenuItem onClick={() => act(() => store.setCurrencyStatus(c.id, 'active'), 'Currency activated.')}><Power className="h-4 w-4" /> Activate</MenuItem> : null}
                      {c.status !== 'archived' && !isBase && <MenuItem onClick={() => act(() => store.setCurrencyStatus(c.id, 'archived'), 'Currency archived.')}><Archive className="h-4 w-4" /> Archive</MenuItem>}
                    </Dropdown>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div></Card>

      {rows.length === 0 && <Card className="mt-4"><CardBody><div className="flex flex-col items-center py-8 text-center text-sm text-slate-400"><Coins className="mb-2 h-8 w-8" />No currencies defined yet.</div></CardBody></Card>}

      {editorId && <CurrencyEditor currencyId={editorId} onClose={() => setEditorId(null)} />}
    </>
  );
}
