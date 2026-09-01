/**
 * Tax codes for books the SERVER holds.
 *
 * ══ Why this is a separate screen from the browser one ═══════════════════════
 *
 * The browser tax code has forty fields — jurisdictions, reporting boxes,
 * recoverability, withholding timing, reverse-charge account pairs. The server
 * holds the subset it can actually post: five categories, two methods, one
 * output account, and effective-dated rates. Showing the full editor against a
 * server code would offer a bookkeeper controls that silently do nothing, which
 * is the same failure the whole slice exists to avoid.
 *
 * So this screen shows what is real, and says plainly what is not yet.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, Archive, Percent, History, AlertTriangle } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useTaxCodeStore } from '@/store/taxCodeStore';
import {
  useServerTaxCodeStore,
  rateOn,
} from '@/store/serverTaxCodeStore';
import type {
  ServerTaxCode, ServerTaxCategory, ServerTaxMethod, ServerTaxDirection,
} from '@/services/api/taxCodesApi';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import type { BadgeTone } from '@/data/ifrsOptions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';

const CATEGORIES: { value: ServerTaxCategory; label: string; hint: string }[] = [
  { value: 'standard', label: 'Standard-rated', hint: 'Taxable at the standard rate.' },
  { value: 'reduced', label: 'Reduced-rated', hint: 'Taxable at a lower rate.' },
  { value: 'zero-rated', label: 'Zero-rated', hint: 'Taxable at 0%. The base is still reported.' },
  { value: 'exempt', label: 'Exempt', hint: 'No tax charged. Reported separately from zero-rated.' },
  { value: 'out-of-scope', label: 'Out of scope', hint: 'Outside the tax regime. Not in the return.' },
];

/**
 * What the browser model offers and the server cannot post yet.
 *
 * Listed rather than hidden: a bookkeeper who needs reverse charge has to know
 * it is absent and why, not discover it by not finding it.
 */
const DIRECTIONS: { value: ServerTaxDirection; label: string; hint: string }[] = [
  { value: 'sales', label: 'Sales only', hint: 'Charged to customers on invoices.' },
  { value: 'purchase', label: 'Purchases only', hint: 'Reclaimed from suppliers on bills.' },
  { value: 'both', label: 'Sales and purchases', hint: 'One rate under one authority, used on both.' },
];

const NOT_YET: { label: string; reason: string }[] = [
  { label: 'Partial recoverability', reason: 'The specification asks for it but describes a posting that contradicts the fields beside it, so input tax here is fully recoverable or the code charges nothing.' },
  { label: 'Withholding directions', reason: 'Recognised at a payment or receipt stage with its own liability account, which the server does not hold.' },
  { label: 'Reverse charge', reason: 'Creates a self-assessed output and input tax at once; the account pair is not configured on the server.' },
  { label: 'Import tax', reason: 'Assessed at the border against accounts the server does not hold.' },
  { label: 'Withholding', reason: 'Recognised at a payment or receipt stage this slice does not cover.' },
  { label: 'Compound tax', reason: 'Applies each rate to the base plus the previous tax; the ordering is configuration the server does not hold.' },
  { label: 'Fixed-amount tax', reason: 'A charge per unit or per document rather than a percentage.' },
  { label: 'Document-level rounding', reason: 'Its rounding difference needs an account to post to, and none is defined.' },
];

const CATEGORY_TONE: Record<ServerTaxCategory, BadgeTone> = {
  standard: 'blue', reduced: 'cyan', 'zero-rated': 'teal', exempt: 'amber', 'out-of-scope': 'slate',
};

const today = (): string => new Date().toISOString().slice(0, 10);
const trim = (rate: string): string =>
  rate.includes('.') ? rate.replace(/0+$/, '').replace(/\.$/, '') : rate;

const chargesTax = (category: ServerTaxCategory): boolean =>
  category === 'standard' || category === 'reduced';

export function ServerTaxCodes() {
  const accounts = useStore((s) => s.accounts);
  const codes = useServerTaxCodeStore((s) => s.taxCodes);
  const loading = useServerTaxCodeStore((s) => s.loading);
  const loadError = useServerTaxCodeStore((s) => s.loadError);
  const loaded = useServerTaxCodeStore((s) => s.loaded);
  const store = useServerTaxCodeStore();
  const { notify } = useToast();

  const [creating, setCreating] = useState(false);
  const [ratingId, setRatingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!loaded) void store.load(); }, [loaded, store]);

  const accountLabel = (id: string | null): string => {
    if (!id) return '—';
    const account = accounts.find((candidate) => candidate.id === id);
    return account ? `${account.code} · ${account.name}` : 'Unknown account';
  };

  /* Only postable accounts can hold output tax, so only they are offered. */
  const postable = useMemo(
    () => accounts.filter((a) => a.isPostingAccount && a.isActive),
    [accounts],
  );

  const act = async (run: () => Promise<{ ok: boolean; error?: string }>, success: string): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await run();
      if (!result.ok) {
        notify(result.error ?? 'Something went wrong. Nothing was saved.', 'error');
        return false;
      }
      notify(success, 'success');
      return true;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <BrowserTaxCensus />

      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Tax codes</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Held in these books. An invoice charges tax by naming a code, and the rate is resolved
            from the invoice&rsquo;s own date.
          </p>
        </div>
        <Button onClick={() => setCreating(true)} disabled={busy}>
          <Plus className="h-4 w-4" /> New tax code
        </Button>
      </div>

      {loadError ? (
        <Card>
          <CardBody className="flex items-start gap-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <div>
              <p className="font-medium text-red-700 dark:text-red-400">Could not load the tax codes.</p>
              <p className="text-slate-600 dark:text-slate-400">{loadError}</p>
              {/* Deliberately no local fallback: showing seeded codes here would
                  offer codes no invoice could actually be issued against. */}
              <Button variant="secondary" className="mt-2" onClick={() => void store.load()}>Try again</Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {creating ? (
        <TaxCodeForm
          postableAccounts={postable}
          busy={busy}
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            const ok = await act(() => store.createTaxCode(input), 'Tax code created.');
            if (ok) setCreating(false);
          }}
        />
      ) : null}

      {loading && codes.length === 0 ? (
        <Card><CardBody className="text-sm text-slate-500">Loading tax codes…</CardBody></Card>
      ) : codes.length === 0 && !loadError ? (
        <EmptyState
          icon={Percent}
          title="No tax codes yet"
          description="Add one to charge tax on an invoice. Until then invoices in these books carry no tax."
        />
      ) : (
        <div className="space-y-3">
          {codes.map((code) => (
            <Card key={code.id}>
              <CardBody className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{code.code}</span>
                      <span className="text-slate-600 dark:text-slate-400">{code.name}</span>
                      <Badge tone={CATEGORY_TONE[code.category]}>{code.category}</Badge>
                      <Badge tone="slate">{code.calculationMethod}</Badge>
                      <Badge tone="violet">
                        {code.direction === 'both' ? 'sales + purchases'
                          : code.direction === 'purchase' ? 'purchases' : 'sales'}
                      </Badge>
                      {code.status !== 'active' ? <Badge tone="red">{code.status}</Badge> : null}
                    </div>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      Rate today:{' '}
                      <span className="font-medium">
                        {rateOn(code, today()) === null ? 'none in force' : `${trim(rateOn(code, today())!)}%`}
                      </span>
                      {chargesTax(code.category) ? (
                        <>
                          {code.direction !== 'purchase' ? <> · Output tax to {accountLabel(code.outputTaxAccountId)}</> : null}
                          {code.direction !== 'sales' ? <> · Input tax to {accountLabel(code.inputTaxAccountId)}</> : null}
                        </>
                      ) : (
                        <> · Charges no tax, so it posts to no account</>
                      )}
                    </p>
                    {chargesTax(code.category) && code.direction !== 'sales' && !code.inputTaxAccountId ? (
                      <p className="mt-1 flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-4 w-4" />
                        No input tax account. A bill using this code cannot be posted until one is
                        set &mdash; recoverable input tax is money owed back to the business.
                      </p>
                    ) : null}
                    {chargesTax(code.category) && code.direction !== 'purchase' && !code.outputTaxAccountId ? (
                      <p className="mt-1 flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-4 w-4" />
                        No output tax account. An invoice using this code cannot be issued until one is set —
                        tax collected is a liability, not revenue.
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <Button variant="secondary" onClick={() => setRatingId(ratingId === code.id ? null : code.id)} disabled={busy}>
                      <Percent className="h-4 w-4" /> Rates
                    </Button>
                    {code.status === 'active' ? (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void act(
                          () => store.setStatus(code.id, code.version, 'archived'),
                          'Tax code archived.',
                        )}
                      >
                        <Archive className="h-4 w-4" /> Archive
                      </Button>
                    ) : null}
                  </div>
                </div>

                {ratingId === code.id ? (
                  <RatePanel
                    code={code}
                    postableAccounts={postable}
                    busy={busy}
                    accountLabel={accountLabel}
                    onAdd={async (input) => {
                      await act(() => store.addRateVersion(code.id, code.version, input), 'Rate added.');
                    }}
                  />
                ) : null}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <UnsupportedNotice />
    </div>
  );
}

/* ══ Creation ══════════════════════════════════════════════════════════════ */

function TaxCodeForm({
  postableAccounts, busy, onSubmit, onCancel,
}: {
  postableAccounts: { id: string; code: string; name: string }[];
  busy: boolean;
  onSubmit: (input: {
    code: string; name: string; category: ServerTaxCategory;
    calculationMethod: ServerTaxMethod; direction: ServerTaxDirection; rate?: string;
    outputTaxAccountId?: string | null; inputTaxAccountId?: string | null;
    effectiveFrom: string;
  }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ServerTaxCategory>('standard');
  const [method, setMethod] = useState<ServerTaxMethod>('exclusive');
  const [direction, setDirection] = useState<ServerTaxDirection>('sales');
  const [rate, setRate] = useState('16');
  const [accountId, setAccountId] = useState('');
  const [inputAccountId, setInputAccountId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(today());

  const taxable = chargesTax(category);
  const hint = CATEGORIES.find((c) => c.value === category)?.hint ?? '';

  return (
    <Card>
      <CardBody className="space-y-3">
        <h3 className="font-semibold">New tax code</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block text-slate-600 dark:text-slate-400">Code</span>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="VAT16" />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-slate-600 dark:text-slate-400">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard-rated sales" />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-slate-600 dark:text-slate-400">Category</span>
            <Select
              value={category}
              onChange={(e) => setCategory(e.target.value as ServerTaxCategory)}
              options={CATEGORIES.map((c) => ({ value: c.value, label: c.label }))}
            />
            <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">{hint}</span>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-slate-600 dark:text-slate-400">Used on</span>
            <Select
              value={direction}
              onChange={(e) => setDirection(e.target.value as ServerTaxDirection)}
              options={DIRECTIONS.map((d) => ({ value: d.value, label: d.label }))}
            />
            <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
              {DIRECTIONS.find((d) => d.value === direction)?.hint}
            </span>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-slate-600 dark:text-slate-400">Method</span>
            <Select
              value={method}
              onChange={(e) => setMethod(e.target.value as ServerTaxMethod)}
              disabled={!taxable}
              options={[
                { value: 'exclusive', label: 'Exclusive — tax added on top' },
                { value: 'inclusive', label: 'Inclusive — tax already in the price' },
              ]}
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-slate-600 dark:text-slate-400">Rate %</span>
            <Input
              value={taxable ? rate : '0'}
              onChange={(e) => setRate(e.target.value)}
              disabled={!taxable}
              inputMode="decimal"
            />
            {!taxable ? (
              <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                This category charges nothing, so it carries no rate.
              </span>
            ) : null}
          </label>

          {direction !== 'purchase' ? (
            <label className="text-sm sm:col-span-2">
              <span className="mb-1 block text-slate-600 dark:text-slate-400">Output tax account</span>
              <Select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                disabled={!taxable}
                options={[
                  { value: '', label: taxable ? 'Choose a liability account…' : 'Not applicable' },
                  ...postableAccounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })),
                ]}
              />
              <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                {taxable
                  ? 'Where tax collected is held. It is a liability owed to an authority, never revenue.'
                  : 'A category that charges nothing posts to no account.'}
              </span>
            </label>
          ) : null}

          {direction !== 'sales' ? (
            <label className="text-sm sm:col-span-2">
              <span className="mb-1 block text-slate-600 dark:text-slate-400">Input tax account</span>
              <Select
                value={inputAccountId}
                onChange={(e) => setInputAccountId(e.target.value)}
                disabled={!taxable}
                options={[
                  { value: '', label: taxable ? 'Choose an asset account…' : 'Not applicable' },
                  ...postableAccounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })),
                ]}
              />
              <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                {taxable
                  ? 'Where recoverable input tax is reclaimed. It is money the business expects back from an authority, so it is an asset — never a bank account.'
                  : 'A category that charges nothing posts to no account.'}
              </span>
            </label>
          ) : null}

          <label className="text-sm">
            <span className="mb-1 block text-slate-600 dark:text-slate-400">Effective from</span>
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </label>
        </div>

        <div className="flex gap-2">
          <Button
            disabled={busy || !code.trim() || !name.trim()}
            onClick={() => void onSubmit({
              code: code.trim(),
              name: name.trim(),
              category,
              calculationMethod: taxable ? method : 'exclusive',
              direction,
              rate: taxable ? rate : '0',
              outputTaxAccountId: taxable && direction !== 'purchase' ? (accountId || null) : null,
              inputTaxAccountId: taxable && direction !== 'sales' ? (inputAccountId || null) : null,
              effectiveFrom,
            })}
          >
            Create
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </CardBody>
    </Card>
  );
}

/* ══ Effective-dated rates ═════════════════════════════════════════════════ */

function RatePanel({
  code, postableAccounts, busy, accountLabel, onAdd,
}: {
  code: ServerTaxCode;
  postableAccounts: { id: string; code: string; name: string }[];
  busy: boolean;
  accountLabel: (id: string | null) => string;
  onAdd: (input: { rate?: string; effectiveFrom: string; outputTaxAccountId?: string | null }) => void | Promise<void>;
}) {
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState(today());
  const [accountId, setAccountId] = useState('');
  const taxable = chargesTax(code.category);

  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <History className="h-4 w-4" /> Rate history
      </div>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Rates are never overwritten. An invoice keeps the rate in force on its own date, so past
        documents stay exactly as they were issued.
      </p>

      <div className="mb-3 space-y-1 text-sm">
        {[...code.rateVersions]
          .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
          .map((version) => (
            <div key={version.id} className="flex flex-wrap justify-between gap-2 border-b border-slate-100 py-1 last:border-0 dark:border-slate-800">
              <span className="font-medium">{trim(version.rate)}%</span>
              <span className="text-slate-500 dark:text-slate-400">
                {version.effectiveFrom} → {version.effectiveTo ?? 'open-ended'}
              </span>
              <span className="text-slate-500 dark:text-slate-400">
                {taxable ? accountLabel(version.outputTaxAccountId ?? code.outputTaxAccountId) : '—'}
              </span>
            </div>
          ))}
      </div>

      {code.status === 'active' ? (
        <div className="grid gap-2 sm:grid-cols-4">
          <Input
            value={taxable ? rate : '0'}
            onChange={(e) => setRate(e.target.value)}
            placeholder="New rate %"
            disabled={!taxable}
            inputMode="decimal"
          />
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            disabled={!taxable}
            options={[
              { value: '', label: 'Keep the code’s account' },
              ...postableAccounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })),
            ]}
          />
          <Button
            disabled={busy || (taxable && !rate.trim())}
            onClick={() => void onAdd({
              rate: taxable ? rate : '0',
              effectiveFrom: from,
              outputTaxAccountId: taxable ? (accountId || null) : null,
            })}
          >
            Add rate
          </Button>
        </div>
      ) : (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          This code is {code.status}. Its rates are history and are not extended.
        </p>
      )}
    </div>
  );
}

/* ══ What is not here yet ══════════════════════════════════════════════════ */

function UnsupportedNotice() {
  return (
    <Card>
      <CardBody>
        <h3 className="mb-1 text-sm font-semibold">Not available on server-held books yet</h3>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          These are refused rather than approximated. Each needs accounting the server has no
          controlled account mapping for, and a tax posted to a plausible-looking account is harder
          to unpick than one that was never posted.
        </p>
        <ul className="space-y-1.5 text-xs">
          {NOT_YET.map((item) => (
            <li key={item.label} className="flex gap-2">
              <span className="min-w-[8.5rem] shrink-0 font-medium text-slate-700 dark:text-slate-300">{item.label}</span>
              <span className="text-slate-500 dark:text-slate-400">{item.reason}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/* ══ Browser tax data still sitting in this device ═════════════════════════ */

/**
 * A census, not a migration.
 *
 * Tax codes left in localStorage from before the cutover cannot be imported:
 * the server would have to invent which account each posts to, and which of its
 * ten categories maps onto the five that can be posted. Guessing that on codes
 * that may already be named by browser documents is exactly the kind of
 * silent rewrite this whole slice exists to prevent.
 *
 * So this COUNTS them, says what it found, and leaves them alone. Deleting them
 * is the user's call and the browser store's job, not this screen's.
 */
export function BrowserTaxCensus() {
  const browserCodes = useTaxCodeStore((s) => s.taxCodes);
  const [dismissed, setDismissed] = useState(false);

  const census = useMemo(() => {
    const supported = new Set(CATEGORIES.map((c) => c.value as string));
    const portable = browserCodes.filter(
      (c) => supported.has(c.category) && (c.calculationMethod === 'exclusive' || c.calculationMethod === 'inclusive'),
    );
    return {
      total: browserCodes.length,
      portable: portable.length,
      unportable: browserCodes.length - portable.length,
      examples: browserCodes
        .filter((c) => !supported.has(c.category) || (c.calculationMethod !== 'exclusive' && c.calculationMethod !== 'inclusive'))
        .slice(0, 5)
        .map((c) => `${c.code} (${c.category}/${c.calculationMethod})`),
    };
  }, [browserCodes]);

  if (dismissed || census.total === 0) return null;

  return (
    <Card>
      <CardBody className="space-y-2 text-sm">
        <div className="flex items-center gap-2 font-semibold">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          {census.total} tax code{census.total === 1 ? '' : 's'} remain in this browser
        </div>
        <p className="text-slate-600 dark:text-slate-400">
          They are not used by these books and were not imported. Importing them would mean deciding
          which account each posts to and which server category it maps onto — decisions that would
          change what a document says it charged, so they are left for you to make.
        </p>
        <ul className="text-slate-600 dark:text-slate-400">
          <li>· {census.portable} could be recreated here as-is (a supported category and method).</li>
          <li>· {census.unportable} use a treatment the server refuses.</li>
        </ul>
        {census.examples.length > 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            For example: {census.examples.join(', ')}
          </p>
        ) : null}
        <Button variant="secondary" onClick={() => setDismissed(true)}>Understood</Button>
      </CardBody>
    </Card>
  );
}
