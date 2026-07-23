import { useMemo, useState } from 'react';
import { Plus, ChevronDown, Pencil, Power, Archive, Coins, Star, Download } from 'lucide-react';
import type { Currency } from '@/types/currency';
import { currencyTypeOf, monetaryDecimalsOf, rateDecimalsOf } from '@/types/currency';
import { useStore } from '@/store/useStore';
import { useCurrencyStore, collectWorkspaceCurrencyUsage } from '@/store/currencyStore';
import { STANDARD_CURRENCY_CATALOG } from '@/data/currencyCatalog';
import { normalizeCurrencyCode } from '@/lib/currencyMaster';
import { formatCurrencyAmount } from '@/lib/currencyFormatting';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import type { BadgeTone } from '@/data/ifrsOptions';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { CurrencyEditor } from '@/components/currencies/CurrencyEditor';
import { CurrencyPicker } from '@/components/currencies/CurrencyPicker';

const STATUS_TONE: Record<Currency['status'], BadgeTone> = { active: 'green', inactive: 'slate', archived: 'red' };

type OriginFilter = 'all' | 'standard' | 'custom';
type StatusFilter = 'all' | 'active' | 'inactive' | 'archived';

export function CurrenciesPage() {
  const accounts = useStore((s) => s.accounts);
  const currencies = useCurrencyStore((s) => s.currencies);
  const config = useCurrencyStore((s) => s.getConfig());
  const store = useCurrencyStore();
  const { notify } = useToast();
  const [editorId, setEditorId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [origin, setOrigin] = useState<OriginFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');

  const usedCodes = useMemo(() => collectWorkspaceCurrencyUsage(), [currencies]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...currencies]
      .filter((c) => (origin === 'all' ? true : origin === 'standard' ? c.isIso : !c.isIso))
      .filter((c) => (status === 'all' ? true : c.status === status))
      .filter((c) => !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || (c.localizedName ?? '').toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [currencies, search, origin, status]);

  const inactiveCatalog = useMemo(
    () => STANDARD_CURRENCY_CATALOG.filter((e) => !currencies.some((c) => normalizeCurrencyCode(c.code) === e.code && c.status === 'active')),
    [currencies],
  );

  const act = (fn: () => { ok: boolean; error?: string }, ok: string): void => { const r = fn(); if (r.ok) notify(ok, 'success'); else notify(r.error ?? 'Action failed.', 'error'); };
  const onNewCustom = (): void => {
    const r = store.createCustomCurrency({ code: `CUR${currencies.length + 1}`, name: 'New custom currency', symbol: '', currencyType: 'custom', decimalPlaces: 2, status: 'inactive' });
    if (r.ok && r.id) setEditorId(r.id); else notify(r.error ?? 'Could not create currency.', 'error');
  };
  const toggleEnabled = (code: string): void => {
    if (config.allowedCurrencyCodes.includes(code)) act(() => store.disableCurrency(config.entityId, code), `${code} disabled for entity.`);
    else act(() => store.enableCurrency(config.entityId, code), `${code} enabled for entity.`);
  };

  return (
    <>
      <PageActions>
        <Dropdown label="Activate standard" align="right" trigger={(o) => (<span className={cx('inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200', o && 'bg-slate-50')}><Download className="h-4 w-4" /> Activate standard <ChevronDown className="h-3 w-3" /></span>)}>
          {inactiveCatalog.length === 0 && <MenuItem onClick={() => undefined}>All catalog currencies are active</MenuItem>}
          {inactiveCatalog.map((e) => (
            <MenuItem key={e.code} onClick={() => act(() => store.activateStandardCurrency(e.code), `${e.code} activated.`)}>
              <span className="font-mono text-xs font-semibold">{e.code}</span> {e.name}
            </MenuItem>
          ))}
        </Dropdown>
        <Button onClick={onNewCustom}><Plus className="h-4 w-4" /> Add custom currency</Button>
      </PageActions>

      {/* Entity currency configuration */}
      <Card className="mb-4"><CardBody>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Organization currency settings</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <Field label="Base currency">
            <CurrencyPicker
              value={config.baseCurrencyCode}
              currencies={currencies}
              onChange={(code) => act(() => store.setBaseCurrency(config.entityId, code), `Base currency set to ${code}.`)}
            />
          </Field>
          <Field label="Realized FX gain account" className="sm:col-span-1"><AccountSelect value={config.realizedFxGainAccountId} accounts={accounts} onChange={(a) => store.updateEntityConfig(config.entityId, { realizedFxGainAccountId: a.id })} /></Field>
          <Field label="Realized FX loss account"><AccountSelect value={config.realizedFxLossAccountId} accounts={accounts} onChange={(a) => store.updateEntityConfig(config.entityId, { realizedFxLossAccountId: a.id })} /></Field>
          <Field label="Currency rounding account"><AccountSelect value={config.currencyRoundingAccountId ?? ''} accounts={accounts} onChange={(a) => store.updateEntityConfig(config.entityId, { currencyRoundingAccountId: a.id })} /></Field>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Exactly one base currency; changing it after postings exist requires the controlled migration workflow (administrator, effective date, rate source) and never recalculates history.
          Convention: <span className="font-mono">1 foreign = rate × base</span>. Posting rounding differences go to the currency-rounding account so journals always balance.
        </p>
      </CardBody></Card>

      {/* Search + filters */}
      <Card className="mb-4"><CardBody>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Search" className="sm:col-span-2"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Code, name or symbol…" /></Field>
          <Field label="Origin"><Select options={[{ value: 'all', label: 'All' }, { value: 'standard', label: 'Standard (ISO)' }, { value: 'custom', label: 'Custom' }]} value={origin} onChange={(e) => setOrigin(e.target.value as OriginFilter)} /></Field>
          <Field label="Status"><Select options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'archived', label: 'Archived' }]} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} /></Field>
        </div>
      </CardBody></Card>

      <Card className="overflow-hidden"><div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
            {['Code', 'Name', 'Type', 'Symbol', 'Decimals', 'Rate dp', 'Sample', 'Usage', 'Enabled', 'Status', ''].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', h === 'Decimals' || h === 'Rate dp' ? 'text-right' : 'text-left')}>{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((c) => {
              const isBase = c.code === config.baseCurrencyCode;
              const enabled = isBase || config.allowedCurrencyCodes.includes(c.code);
              const inUse = usedCodes.has(normalizeCurrencyCode(c.code));
              return (
                <tr key={c.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                  <td className="px-3 py-2 font-mono text-xs font-semibold">{c.code} {isBase && <Star className="inline h-3 w-3 text-amber-500" aria-label="Base currency" />}</td>
                  <td className="px-3 py-2">{c.name}{c.localizedName ? <span className="ml-1 text-xs text-slate-400">({c.localizedName})</span> : null}</td>
                  <td className="px-3 py-2"><Badge tone={c.isIso ? 'blue' : 'violet'}>{c.isIso ? 'standard' : currencyTypeOf(c)}</Badge></td>
                  <td className="px-3 py-2">{c.symbol}</td>
                  <td className="px-3 py-2 text-right font-mono">{monetaryDecimalsOf(c)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-slate-500">{rateDecimalsOf(c)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{formatCurrencyAmount('1234.5678', c, { showCode: false })}</td>
                  <td className="px-3 py-2">{inUse ? <Badge tone="amber">used</Badge> : <span className="text-xs text-slate-400">—</span>}</td>
                  <td className="px-3 py-2">
                    <button onClick={() => !isBase && toggleEnabled(c.code)} disabled={isBase} className={cx('rounded-md px-2 py-0.5 text-xs', enabled ? 'bg-green-50 text-green-700 dark:bg-green-500/10' : 'bg-slate-100 text-slate-500 dark:bg-slate-800', isBase && 'cursor-default')}>{enabled ? 'Enabled' : 'Disabled'}</button>
                  </td>
                  <td className="px-3 py-2"><Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge></td>
                  <td className="px-3 py-2 text-right">
                    <Dropdown label="Actions" align="right" trigger={(o) => (<span className={cx('inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300', o && 'bg-slate-50')}>Actions <ChevronDown className="h-3 w-3" /></span>)}>
                      <MenuItem onClick={() => setEditorId(c.id)}><Pencil className="h-4 w-4" /> {c.status === 'archived' ? 'View' : 'Edit'}</MenuItem>
                      {c.status === 'active' ? <MenuItem onClick={() => act(() => store.setCurrencyStatus(c.id, 'inactive'), 'Currency deactivated. Historical documents remain readable.')}><Power className="h-4 w-4" /> Deactivate</MenuItem> : c.status === 'inactive' ? <MenuItem onClick={() => act(() => store.setCurrencyStatus(c.id, 'active'), 'Currency activated.')}><Power className="h-4 w-4" /> Activate</MenuItem> : null}
                      {c.status !== 'archived' && !isBase && <MenuItem onClick={() => act(() => store.setCurrencyStatus(c.id, 'archived'), 'Currency archived.')}><Archive className="h-4 w-4" /> Archive</MenuItem>}
                    </Dropdown>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div></Card>

      {rows.length === 0 && <Card className="mt-4"><CardBody><div className="flex flex-col items-center py-8 text-center text-sm text-slate-400"><Coins className="mb-2 h-8 w-8" />No currencies match the current filters.</div></CardBody></Card>}

      {editorId && <CurrencyEditor currencyId={editorId} onClose={() => setEditorId(null)} />}
    </>
  );
}
