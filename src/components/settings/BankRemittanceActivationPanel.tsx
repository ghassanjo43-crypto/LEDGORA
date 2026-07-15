import { useState } from 'react';
import { Banknote, CheckCircle2 } from 'lucide-react';
import { useEntitlementStore } from '@/store/entitlementStore';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

/**
 * Manual activation after a bank-remittance confirmation. No online card
 * billing — an administrator records the remittance reference and activates.
 */
export function BankRemittanceActivationPanel() {
  const status = useEntitlementStore((s) => s.subscription.status);
  const savedRef = useEntitlementStore((s) => s.subscription.bankRemittanceReference);
  const activate = useEntitlementStore((s) => s.activateSubscription);

  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  const onActivate = (): void => {
    activate({
      method: 'bank-remittance',
      bankRemittanceReference: reference.trim() || undefined,
      adminNotes: notes.trim() || undefined,
    });
    setReference('');
    setNotes('');
  };

  const isActive = status === 'active' || status === 'trial';

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
        <Banknote className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Record the bank-remittance reference from the customer's payment, then
          activate the subscription. This is a manual, admin-only action — no
          card details are collected.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">
            Bank-remittance reference
          </label>
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="e.g. TT-2026-00184"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">
            Admin notes (optional)
          </label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Confirmation detail"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={onActivate}>
          <CheckCircle2 className="h-4 w-4" />
          {isActive ? 'Re-confirm activation' : 'Activate subscription'}
        </Button>
        {savedRef && (
          <span className="text-xs text-slate-400">
            Last reference on file: <span className="font-mono">{savedRef}</span>
          </span>
        )}
      </div>
    </div>
  );
}
