import { useEffect, useRef, useState } from 'react';
import { Building2, SlidersHorizontal, ShieldAlert, Upload, Trash2, ImageOff } from 'lucide-react';
import type { CompanySettings, PresentationMode } from '@/types';
import { LOGO_ACCEPT_ATTR, compressImageDataUrl, readFileAsDataUrl, validateLogoFile } from '@/lib/invoiceLogo';
import { LogoImage } from '@/components/invoices/LogoImage';
import { useStore } from '@/store/useStore';
import { useCompanyStore } from '@/store/companyStore';
import {
  CURRENCY_OPTIONS,
  INDUSTRY_OPTIONS,
  ORGANIZATION_TYPE_OPTIONS,
  ACCOUNTING_BASIS_OPTIONS,
  REPORTING_FRAMEWORK_OPTIONS,
} from '@/data/ifrsOptions';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { Alert } from '@/components/ui/Alert';
import { Tabs } from '@/components/ui/Tabs';
import { Icon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { cn } from '@/lib/utils';

type SettingsTab = 'company' | 'presentation' | 'system';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_OPTIONS = MONTHS.map((label, i) => ({
  value: String(i + 1).padStart(2, '0') + '-01',
  label: `${label} 1`,
}));

const PRESENTATION_MODES: {
  value: PresentationMode;
  title: string;
  description: string;
}[] = [
  {
    value: 'IAS_1',
    title: 'IAS 1 — Current presentation',
    description:
      'Classic profit or loss presentation by nature or function of expense.',
  },
  {
    value: 'IFRS_18',
    title: 'IFRS 18 — Ready presentation',
    description:
      'Adds operating / investing / financing / income tax categories to P&L accounts.',
  },
];

export function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const resetToDefault = useStore((s) => s.resetToDefault);
  const { notify } = useToast();

  const [draft, setDraft] = useState<CompanySettings>(settings);
  const [confirmReset, setConfirmReset] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('company');

  useEffect(() => setDraft(settings), [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const save = (): void => {
    updateSettings(draft);
    useCompanyStore.getState().syncActiveSettings(draft);
    notify('Company settings saved.', 'success');
  };

  const set = <K extends keyof CompanySettings>(key: K, value: CompanySettings[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div className="space-y-5">
      <Tabs<SettingsTab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'company', label: 'Company', icon: Building2 },
          { id: 'presentation', label: 'Presentation', icon: SlidersHorizontal },
          { id: 'system', label: 'System', icon: ShieldAlert },
        ]}
      />

      {tab === 'company' && (
        <div className="space-y-5">
          <Alert variant="info" title="Company setup">
            This is the organisation your books are kept for. Complete the identity, tax and
            accounting details before recording transactions — these values flow into reports,
            journals and exports.
          </Alert>

          {/* Identity */}
          <Card>
            <CardHeader title="Organisation identity" description="Legal and trading identity of the business." />
            <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Legal / registered name" required htmlFor="company">
                <Input id="company" value={draft.companyName} onChange={(e) => set('companyName', e.target.value)} placeholder="Registered legal name" />
              </Field>
              <Field label="Trading name" htmlFor="tradingName" hint="Brand or “trading as” name, if different.">
                <Input id="tradingName" value={draft.tradingName} onChange={(e) => set('tradingName', e.target.value)} />
              </Field>
              <Field label="Organisation type" htmlFor="orgType">
                <Select id="orgType" options={ORGANIZATION_TYPE_OPTIONS} value={draft.organizationType} onChange={(e) => set('organizationType', e.target.value)} />
              </Field>
              <Field label="Industry" htmlFor="industry">
                <Select id="industry" options={INDUSTRY_OPTIONS} value={draft.industryType} onChange={(e) => set('industryType', e.target.value)} />
              </Field>
              <div className="sm:col-span-2">
                <CompanyLogoField value={draft.logoUrl} onChange={(url) => set('logoUrl', url)} />
              </div>
            </CardBody>
          </Card>

          {/* Registration & tax */}
          <Card>
            <CardHeader title="Registration & tax" description="Statutory registration and tax identifiers." />
            <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Commercial registration no." htmlFor="reg">
                <Input id="reg" value={draft.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value)} placeholder="Company / CR number" />
              </Field>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-800">
                <div>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">Tax registered</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Enable if the entity charges/report VAT or sales tax.</p>
                </div>
                <Toggle checked={draft.taxRegistered} onChange={(v) => set('taxRegistered', v)} label="Tax registered" />
              </div>
              <Field label="Tax registration number (VAT / TRN)" htmlFor="trn">
                <Input id="trn" value={draft.taxRegistrationNumber} onChange={(e) => set('taxRegistrationNumber', e.target.value)} disabled={!draft.taxRegistered} placeholder={draft.taxRegistered ? 'e.g. 100123456700003' : 'Enable tax registration first'} />
              </Field>
              <Field label="Default tax rate (%)" htmlFor="taxRate">
                <Input id="taxRate" type="number" min={0} max={100} step="0.5" value={draft.defaultTaxRate} onChange={(e) => set('defaultTaxRate', Number(e.target.value) || 0)} disabled={!draft.taxRegistered} />
              </Field>
            </CardBody>
          </Card>

          {/* Contact & address */}
          <Card>
            <CardHeader title="Contact & address" description="Registered address and primary contact details." />
            <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Email" htmlFor="email"><Input id="email" type="email" value={draft.email} onChange={(e) => set('email', e.target.value)} placeholder="finance@company.example" /></Field>
              <Field label="Phone" htmlFor="phone"><Input id="phone" value={draft.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
              <Field label="Website" htmlFor="website"><Input id="website" value={draft.website} onChange={(e) => set('website', e.target.value)} placeholder="https://company.example" /></Field>
              <Field label="Country" htmlFor="country"><Input id="country" value={draft.country} onChange={(e) => set('country', e.target.value)} /></Field>
              <Field label="State / Province" htmlFor="state"><Input id="state" value={draft.stateProvince} onChange={(e) => set('stateProvince', e.target.value)} /></Field>
              <Field label="City" htmlFor="city"><Input id="city" value={draft.city} onChange={(e) => set('city', e.target.value)} /></Field>
              <Field label="Address line 1" htmlFor="addr1"><Input id="addr1" value={draft.addressLine1} onChange={(e) => set('addressLine1', e.target.value)} /></Field>
              <Field label="Address line 2" htmlFor="addr2"><Input id="addr2" value={draft.addressLine2} onChange={(e) => set('addressLine2', e.target.value)} /></Field>
              <Field label="Postal code" htmlFor="postal"><Input id="postal" value={draft.postalCode} onChange={(e) => set('postalCode', e.target.value)} /></Field>
            </CardBody>
          </Card>

          {/* Accounting & reporting */}
          <Card>
            <CardHeader title="Accounting & reporting" description="How and when the books are kept and reported." />
            <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Base currency" required htmlFor="currency" hint="All ledgers and reports are kept in this currency.">
                <Select id="currency" options={CURRENCY_OPTIONS} value={draft.baseCurrency} onChange={(e) => set('baseCurrency', e.target.value)} />
              </Field>
              <Field label="Fiscal year start" htmlFor="fy">
                <Select id="fy" options={MONTH_OPTIONS} value={draft.fiscalYearStart} onChange={(e) => set('fiscalYearStart', e.target.value)} />
              </Field>
              <Field label="Books start date" htmlFor="booksStart" hint="The date opening balances are recorded / bookkeeping begins.">
                <Input id="booksStart" type="date" value={draft.booksStartDate} onChange={(e) => set('booksStartDate', e.target.value)} />
              </Field>
              <Field label="Accounting basis" htmlFor="basis">
                <Select id="basis" options={ACCOUNTING_BASIS_OPTIONS} value={draft.accountingBasis} onChange={(e) => set('accountingBasis', e.target.value as CompanySettings['accountingBasis'])} />
              </Field>
              <Field label="Reporting framework" htmlFor="framework">
                <Select id="framework" options={REPORTING_FRAMEWORK_OPTIONS} value={draft.reportingFramework} onChange={(e) => set('reportingFramework', e.target.value as CompanySettings['reportingFramework'])} />
              </Field>
            </CardBody>
          </Card>
        </div>
      )}

      {tab === 'presentation' && (
      <Card>
        <CardHeader
          title="IFRS presentation mode"
          description="Switch how profit or loss accounts are classified."
        />
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PRESENTATION_MODES.map((mode) => {
            const active = draft.presentationMode === mode.value;
            return (
              <button
                key={mode.value}
                type="button"
                onClick={() => setDraft((d) => ({ ...d, presentationMode: mode.value }))}
                className={cn(
                  'focus-ring rounded-xl border p-4 text-left transition-colors',
                  active
                    ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-500/10'
                    : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600',
                )}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {mode.title}
                  </p>
                  {active && (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white">
                      <Icon.Check className="h-3.5 w-3.5" />
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {mode.description}
                </p>
              </button>
            );
          })}
        </CardBody>
      </Card>
      )}

      {tab !== 'system' && (
        <div className="flex items-center justify-end gap-2">
          {dirty && <span className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</span>}
          <Button variant="outline" onClick={() => setDraft(settings)} disabled={!dirty}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!dirty}>
            Save changes
          </Button>
        </div>
      )}

      {tab === 'system' && (
      <Card className="border-red-200 dark:border-red-500/30">
        <CardHeader title="Danger zone" description="Irreversible actions." />
        <CardBody>
          <Alert variant="warning" className="mb-4">
            Resetting restores the default IFRS-aligned chart of accounts and
            discards all of your customisations.
          </Alert>
          <Button variant="danger" onClick={() => setConfirmReset(true)}>
            <Icon.Reset className="h-4 w-4" /> Reset to default chart of accounts
          </Button>
        </CardBody>
      </Card>
      )}

      <ConfirmDialog
        open={confirmReset}
        title="Reset chart of accounts?"
        message="This replaces your current chart with the default IFRS-aligned seed chart. All edits will be lost. This cannot be undone."
        confirmLabel="Reset to default"
        destructive
        onConfirm={() => {
          resetToDefault();
          setConfirmReset(false);
          notify('Chart of accounts reset to default.', 'success');
        }}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}

/** Company default logo uploader shown in the organisation-identity section. */
function CompanyLogoField({ value, onChange }: { value?: string; onChange: (url: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const v = validateLogoFile(file);
    if (!v.ok) { setError(v.error ?? 'Invalid file.'); return; }
    try {
      const raw = await readFileAsDataUrl(file);
      onChange(await compressImageDataUrl(raw)); // downscale so it fits in LocalStorage
      setError(null);
    } catch {
      setError('Could not read the file.');
    }
  };

  return (
    <Field label="Company logo" hint="Shown on invoices that use the company default logo (PNG, JPG or WebP · max 1 MB · ~800×300).">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-16 w-32 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/40">
          {value ? <LogoImage url={value} alt="Company logo" className="max-h-14 max-w-28 object-contain" /> : <span className="flex items-center gap-1 text-xs text-slate-400"><ImageOff className="h-4 w-4" /> None</span>}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => { setError(null); fileRef.current?.click(); }}><Upload className="h-4 w-4" /> {value ? 'Replace' : 'Upload'}</Button>
          {value && <Button type="button" variant="ghost" size="sm" onClick={() => onChange('')}><Trash2 className="h-4 w-4" /> Remove</Button>}
        </div>
        <input ref={fileRef} type="file" accept={LOGO_ACCEPT_ATTR} className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Field>
  );
}
