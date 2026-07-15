import { useState } from 'react';
import { Save, ShieldCheck, Loader2 } from 'lucide-react';
import type { BankDetails, BillingSettings } from '@/types/billing';
import { useBillingStore } from '@/store/billingStore';
import { useIsAdmin } from '@/store/billingHooks';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';

/** Administrator editor for bank remittance details and billing settings. */
export function BillingSettingsEditor() {
  const settings = useBillingStore((s) => s.settings);
  const isAdmin = useIsAdmin();
  const updateBankDetails = useBillingStore((s) => s.updateBankDetails);
  const updateBillingSettings = useBillingStore((s) => s.updateBillingSettings);

  const [bank, setBank] = useState<BankDetails>(() => ({ ...settings.bank }));
  const [general, setGeneral] = useState<Omit<BillingSettings, 'bank' | 'updatedAt'>>(() => ({
    currency: settings.currency,
    graceDays: settings.graceDays,
    reminderOffsets: settings.reminderOffsets,
    termMonths: settings.termMonths,
    invoicePrefix: settings.invoicePrefix,
    paymentDueDays: settings.paymentDueDays,
  }));
  const [savedBank, setSavedBank] = useState(false);
  const [savedGeneral, setSavedGeneral] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isAdmin) {
    return <EmptyState icon={ShieldCheck} title="Administrator access required" description="Only administrators can edit bank details and billing settings." />;
  }

  const setB = <K extends keyof BankDetails>(k: K, v: BankDetails[K]): void => setBank((s) => ({ ...s, [k]: v }));
  const setG = <K extends keyof typeof general>(k: K, v: (typeof general)[K]): void => setGeneral((s) => ({ ...s, [k]: v }));

  const saveBank = (): void => {
    setBusy(true);
    updateBankDetails(bank);
    setBusy(false);
    setSavedBank(true);
    window.setTimeout(() => setSavedBank(false), 1500);
  };

  const saveGeneral = (): void => {
    setError(null);
    const res = updateBillingSettings({
      currency: general.currency,
      graceDays: general.graceDays,
      reminderOffsets: general.reminderOffsets,
      termMonths: general.termMonths,
      invoicePrefix: general.invoicePrefix,
      paymentDueDays: general.paymentDueDays,
    });
    if (!res.ok) {
      setError(res.error ?? 'Could not save settings.');
      return;
    }
    setSavedGeneral(true);
    window.setTimeout(() => setSavedGeneral(false), 1500);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Bank remittance details" description="Shown on every subscription invoice. Existing invoices keep the details frozen at issue time." />
        <CardBody className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FieldInput label="Bank name" value={bank.bankName} onChange={(v) => setB('bankName', v)} />
            <FieldInput label="Account name" value={bank.accountName} onChange={(v) => setB('accountName', v)} />
            <FieldInput label="Account number" value={bank.accountNumber} onChange={(v) => setB('accountNumber', v)} />
            <FieldInput label="IBAN" value={bank.iban} onChange={(v) => setB('iban', v)} />
            <FieldInput label="SWIFT / BIC" value={bank.swift} onChange={(v) => setB('swift', v)} />
            <FieldInput label="Branch" value={bank.branch} onChange={(v) => setB('branch', v)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Instructions</label>
            <Textarea value={bank.instructions} rows={2} onChange={(e) => setB('instructions', e.target.value)} />
          </div>
          <div className="flex items-center justify-end gap-2">
            {savedBank && <span className="text-xs text-emerald-600">Saved</span>}
            <Button variant="primary" size="sm" onClick={saveBank} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save bank details
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Billing settings" description="Grace period, renewal reminders, term length and invoice numbering." />
        <CardBody className="space-y-3">
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FieldNumber label="Grace period (days)" value={general.graceDays} onChange={(v) => setG('graceDays', v)} />
            <FieldNumber label="Term length (months)" value={general.termMonths} onChange={(v) => setG('termMonths', v)} />
            <FieldNumber label="Payment due (days)" value={general.paymentDueDays} onChange={(v) => setG('paymentDueDays', v)} />
            <FieldInput label="Invoice prefix" value={general.invoicePrefix} onChange={(v) => setG('invoicePrefix', v)} />
            <FieldInput label="Currency" value={general.currency} onChange={(v) => setG('currency', v)} />
            <FieldInput
              label="Reminder days before expiry"
              value={general.reminderOffsets.join(', ')}
              onChange={(v) =>
                setG(
                  'reminderOffsets',
                  v.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)),
                )
              }
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            {savedGeneral && <span className="text-xs text-emerald-600">Saved</span>}
            <Button variant="primary" size="sm" onClick={saveGeneral}>
              <Save className="h-4 w-4" /> Save settings
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function FieldInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">{label}</label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function FieldNumber({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">{label}</label>
      <Input type="number" value={String(value)} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
