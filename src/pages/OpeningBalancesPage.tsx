import { Fragment, useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { useStore } from '@/store/useStore';
import { useMonetaryPrecision } from '@/lib/useMonetaryPrecision';
import { openingBalancesApi, type OpeningBalanceAccount, type OpeningBalanceLine, type OpeningBalanceRecord } from '@/services/api/openingBalancesApi';

type DraftLine = OpeningBalanceLine & { precisionError?: string | null };
const priorDay = (iso: string): string => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const emptyLine = (accountId: string): DraftLine => ({ accountId, debit: '', credit: '', memo: '' });

export function OpeningBalancesPage() {
  const settings = useStore((s) => s.settings);
  const decimals = useMonetaryPrecision(settings.baseCurrency);
  const [record, setRecord] = useState<OpeningBalanceRecord | null>(null);
  const [accounts, setAccounts] = useState<OpeningBalanceAccount[]>([]);
  const [restrictions, setRestrictions] = useState<string[]>([]);
  const [lines, setLines] = useState<Record<string, DraftLine>>({});
  const [startDate, setStartDate] = useState(settings.booksStartDate);
  const [openingDate, setOpeningDate] = useState(priorDay(settings.booksStartDate));
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('Initial migration opening balances');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | 'asset' | 'liability' | 'equity'>('all');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadRecord = (next: OpeningBalanceRecord | null): void => {
    setRecord(next);
    if (!next) return;
    setStartDate(next.bookkeepingStartDate); setOpeningDate(next.openingBalanceDate);
    setReference(next.reference); setDescription(next.description);
    setLines(Object.fromEntries(next.journal.lines.map((line) => [line.accountId, { accountId: line.accountId, debit: Number(line.debit) ? line.debit : '', credit: Number(line.credit) ? line.credit : '', memo: line.memo }])));
    setDirty(false);
  };

  useEffect(() => { void Promise.all([openingBalancesApi.current(), openingBalancesApi.accounts()]).then(([current, catalogue]) => {
    setAccounts(catalogue.accounts); setRestrictions(catalogue.restrictions); loadRecord(current);
  }).catch((e: Error) => setError(e.message)); }, []);
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);

  const populated = Object.values(lines).filter((line) => Number(line.debit) || Number(line.credit));
  const totals = useMemo(() => {
    const round = (n: number) => Number(n.toFixed(decimals));
    const debit = round(populated.reduce((sum, line) => sum + (Number(line.debit) || 0), 0));
    const credit = round(populated.reduce((sum, line) => sum + (Number(line.credit) || 0), 0));
    return { debit, credit, difference: round(debit - credit), balanced: populated.length >= 2 && debit === credit && debit > 0 };
  }, [populated, decimals]);
  const precisionInvalid = populated.some((line) => Boolean(line.precisionError));
  const editable = !record || record.status === 'draft';
  const filtered = accounts.filter((a) => (category === 'all' || a.type === category) && `${a.code} ${a.name}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => ['asset', 'liability', 'equity'].indexOf(a.type) - ['asset', 'liability', 'equity'].indexOf(b.type) || a.code.localeCompare(b.code));

  const setAmount = (accountId: string, side: 'debit' | 'credit', value: string, precisionError?: string | null): void => {
    setLines((current) => { const line = current[accountId] ?? emptyLine(accountId); return { ...current, [accountId]: { ...line, [side]: value, [side === 'debit' ? 'credit' : 'debit']: value ? '' : line[side === 'debit' ? 'credit' : 'debit'], precisionError } }; });
    setDirty(true);
  };
  const payload = () => ({ bookkeepingStartDate: startDate, openingBalanceDate: openingDate, reference, description,
    lines: populated.map(({ precisionError: _ignored, ...line }) => line), expectedVersion: record?.version });
  const run = async (action: () => Promise<OpeningBalanceRecord>): Promise<void> => { setBusy(true); setError(''); try { loadRecord(await action()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const save = () => run(() => record ? openingBalancesApi.update(record.id, payload()) : openingBalancesApi.create(payload()));
  const transition = (kind: 'submit' | 'approve' | 'post') => record && run(() => openingBalancesApi[kind](record.id, record.version));
  const reverse = () => {
    if (!record) return;
    const reason = window.prompt('Reason for reversing these posted opening balances:')?.trim();
    if (reason) void run(() => openingBalancesApi.reverse(record.id, record.version, reason));
  };
  const replace = () => record && run(() => openingBalancesApi.replacement(record.id, payload()));
  const categoryLabel = (type: OpeningBalanceAccount['type']) => type === 'asset' ? 'Assets' : type === 'liability' ? 'Liabilities' : 'Owners equity';

  return <div className="space-y-4 pb-28">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-2xl font-semibold text-slate-900 dark:text-white">Opening Balances</h1><p className="text-sm text-slate-500">Initial migration balances posted through Ledgora’s double-entry journal.</p></div>
      <Badge tone={record?.status === 'posted' ? 'green' : record?.status === 'approved' ? 'blue' : 'slate'}>{record?.status ?? 'New draft'}</Badge>
    </div>
    {error && <Alert variant="error" onClose={() => setError('')}>{error}</Alert>}
    {restrictions.length > 0 && <Alert variant="warning"><strong>Controlled subledgers are protected.</strong><ul className="mt-1 list-disc pl-5">{restrictions.map((item) => <li key={item}>{item}</li>)}</ul></Alert>}
    <Card><CardHeader title="Migration information" description="The journal defaults to the day immediately before normal bookkeeping begins."/><CardBody className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Field label="Company/entity"><Input value={settings.companyName} disabled /></Field>
      <Field label="Base currency"><Input value={settings.baseCurrency} disabled /></Field>
      <Field label="Bookkeeping start date" required><Input type="date" value={startDate} disabled={!editable} onChange={(e) => { setStartDate(e.target.value); setOpeningDate(priorDay(e.target.value)); setDirty(true); }} /></Field>
      <Field label="Opening-balance date" required><Input type="date" value={openingDate} disabled={!editable} onChange={(e) => { setOpeningDate(e.target.value); setDirty(true); }} /></Field>
      <Field label="Reference"><Input value={reference} disabled={!editable} onChange={(e) => { setReference(e.target.value); setDirty(true); }} /></Field>
      <Field label="Prepared by"><Input value={record?.preparedBy ?? 'Current authorized user'} disabled /></Field>
      <Field label="Approved by"><Input value={record?.approvedBy ?? 'Not approved'} disabled /></Field>
      <Field label="Journal"><Input value={record?.journal.journalNumber ?? 'Created when draft is saved'} disabled /></Field>
      <Field label="Migration notes" className="md:col-span-2 xl:col-span-4"><Textarea value={description} disabled={!editable} onChange={(e) => { setDescription(e.target.value); setDirty(true); }} /></Field>
    </CardBody></Card>
    <Card><CardHeader title="Balance-sheet accounts" description="Assets, liabilities and owners’ equity only. Enter either debit or credit per account." actions={<div className="flex gap-2"><Input aria-label="Search accounts" placeholder="Search code or name" value={search} onChange={(e) => setSearch(e.target.value)} /><select aria-label="Account category" className="rounded-lg border px-3 text-sm dark:bg-slate-900" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}><option value="all">All categories</option><option value="asset">Assets</option><option value="liability">Liabilities</option><option value="equity">Owners equity</option></select></div>} />
      <div className="max-h-[55vh] overflow-auto"><table className="w-full min-w-[850px] text-sm"><thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-800"><tr><th className="px-4 py-3">Account</th><th>Classification</th><th className="w-44">Debit</th><th className="w-44">Credit</th><th className="w-64">Description</th></tr></thead><tbody>
        {filtered.map((account, index) => { const line = lines[account.id] ?? emptyLine(account.id); const heading = index === 0 || filtered[index - 1]?.type !== account.type; return <Fragment key={account.id}>{heading && <tr className="border-t bg-slate-50/80 dark:bg-slate-800/70"><th colSpan={5} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">{categoryLabel(account.type)}</th></tr>}<tr className="border-t dark:border-slate-800"><td className="px-4 py-2"><span className="font-mono text-xs text-slate-500">{account.code}</span><span className="ml-2 font-medium">{account.name}</span></td><td className="capitalize text-slate-500">{account.type}{account.subtype ? ` · ${account.subtype}` : ''}</td><td className="pr-2"><MoneyInput aria-label={`${account.code} debit`} value={line.debit} disabled={!editable || Boolean(line.credit)} currencyCode={settings.baseCurrency} onPrecisionError={(p) => setAmount(account.id, 'debit', line.debit, p)} onChange={(v) => setAmount(account.id, 'debit', v, line.precisionError)} /></td><td className="pr-2"><MoneyInput aria-label={`${account.code} credit`} value={line.credit} disabled={!editable || Boolean(line.debit)} currencyCode={settings.baseCurrency} onPrecisionError={(p) => setAmount(account.id, 'credit', line.credit, p)} onChange={(v) => setAmount(account.id, 'credit', v, line.precisionError)} /></td><td className="pr-4"><Input aria-label={`${account.code} description`} value={line.memo ?? ''} disabled={!editable} onChange={(e) => { setLines((x) => ({ ...x, [account.id]: { ...line, memo: e.target.value } })); setDirty(true); }} /></td></tr></Fragment>; })}
      </tbody></table></div>
    </Card>
    <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-white/95 p-4 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
      <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm md:grid-cols-5"><Stat label="Total debits" value={totals.debit.toFixed(decimals)} /><Stat label="Total credits" value={totals.credit.toFixed(decimals)} /><Stat label="Difference" value={totals.difference.toFixed(decimals)} /><Stat label="Accounts" value={String(populated.length)} /><Stat label="Readiness" value={totals.balanced && !precisionInvalid ? 'Balanced' : 'Not ready'} /></div>
      <div className="flex flex-wrap gap-2">{editable && <Button variant="secondary" disabled={busy || precisionInvalid} onClick={() => void save()}>Save Draft</Button>}{record?.status === 'draft' && <Button disabled={busy || dirty || !totals.balanced || precisionInvalid} onClick={() => void transition('submit')}>Submit</Button>}{record?.status === 'submitted' && <Button disabled={busy} onClick={() => void transition('approve')}>Approve</Button>}{record?.status === 'approved' && <Button disabled={busy} onClick={() => void transition('post')}>Post</Button>}{record?.status === 'posted' && <Button variant="secondary" disabled={busy} onClick={reverse}>Reverse</Button>}{record?.status === 'reversed' && <Button disabled={busy || !totals.balanced || precisionInvalid} onClick={() => void replace()}>Create corrected replacement</Button>}</div>
    </div>
  </div>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div><div className="text-[11px] uppercase text-slate-400">{label}</div><div className="font-semibold tabular-nums">{value}</div></div>; }
