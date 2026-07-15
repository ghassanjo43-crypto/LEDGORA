import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { useCompanyStore } from '@/store/companyStore';
import { useStore } from '@/store/useStore';
import { CURRENCY_OPTIONS, ORGANIZATION_TYPE_OPTIONS } from '@/data/ifrsOptions';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';

/**
 * Create a new company. The company starts with the default IFRS-aligned chart
 * of accounts and empty customer/supplier and journal ledgers. The user is then
 * taken to Settings to complete the full company setup.
 */
export function AddCompanyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const addCompany = useCompanyStore((s) => s.addCompany);
  const setActiveView = useStore((s) => s.setActiveView);
  const { notify } = useToast();

  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [orgType, setOrgType] = useState('LLC');

  useEffect(() => {
    if (open) {
      setName('');
      setCurrency('USD');
      setOrgType('LLC');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const create = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const result = addCompany({ companyName: trimmed, baseCurrency: currency, organizationType: orgType }, true);
    if (result.ok) {
      notify(`Company “${trimmed}” created. Complete its setup.`, 'success');
      onClose();
      setActiveView('settings');
    } else {
      notify(result.error ?? 'Could not create the company.', 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-dropdown dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
            <Building2 className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">Add a new company</h3>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              Starts with a fresh IFRS chart of accounts and empty ledgers.
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <Field label="Company name" required htmlFor="newCompanyName">
            <Input
              id="newCompanyName"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              placeholder="Registered legal name"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Base currency" htmlFor="newCompanyCurrency">
              <Select id="newCompanyCurrency" options={CURRENCY_OPTIONS} value={currency} onChange={(e) => setCurrency(e.target.value)} />
            </Field>
            <Field label="Organisation type" htmlFor="newCompanyOrg">
              <Select id="newCompanyOrg" options={ORGANIZATION_TYPE_OPTIONS} value={orgType} onChange={(e) => setOrgType(e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={create} disabled={!name.trim()}>Create company</Button>
        </div>
      </div>
    </div>
  );
}
