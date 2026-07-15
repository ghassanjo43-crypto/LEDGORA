import type { Account } from '@/types';
import type { TaxCode } from '@/types/taxCode';
import { Field } from '@/components/ui/Input';
import { AccountSelect } from '@/components/journal/AccountSelect';

type AccountField =
  | 'outputTaxAccountId' | 'inputTaxAccountId' | 'taxPayableAccountId' | 'taxReceivableAccountId'
  | 'taxExpenseAccountId' | 'nonRecoverableAccountId' | 'withholdingAccountId'
  | 'reverseChargeOutputAccountId' | 'reverseChargeInputAccountId';

interface Props {
  code: Partial<TaxCode>;
  accounts: Account[];
  onChange: (field: AccountField, id: string) => void;
  disabled?: boolean;
}

/** The account-mapping section of the tax code editor — every field uses the shared AccountSelect. */
export function TaxAccountMappings({ code, accounts, onChange, disabled }: Props) {
  const sales = code.direction === 'sales' || code.direction === 'both';
  const purchase = code.direction === 'purchase' || code.direction === 'both';
  const rc = code.category === 'reverse-charge';
  const wht = code.category === 'withholding' || code.direction === 'withholding-payable' || code.direction === 'withholding-receivable';
  const partial = (code.recoverabilityPercent ?? 100) < 100;

  const sel = (field: AccountField) => (
    <AccountSelect value={(code[field] as string) ?? ''} accounts={accounts} onChange={(a) => onChange(field, a.id)} disabled={disabled} />
  );

  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {sales && <Field label="Output tax account">{sel('outputTaxAccountId')}</Field>}
      {purchase && <Field label="Input tax account">{sel('inputTaxAccountId')}</Field>}
      <Field label="Tax payable account">{sel('taxPayableAccountId')}</Field>
      <Field label="Tax receivable account">{sel('taxReceivableAccountId')}</Field>
      <Field label="Tax expense account">{sel('taxExpenseAccountId')}</Field>
      {partial && <Field label="Non-recoverable account">{sel('nonRecoverableAccountId')}</Field>}
      {wht && <Field label="Withholding account">{sel('withholdingAccountId')}</Field>}
      {rc && <Field label="Reverse-charge output account">{sel('reverseChargeOutputAccountId')}</Field>}
      {rc && <Field label="Reverse-charge input account">{sel('reverseChargeInputAccountId')}</Field>}
    </section>
  );
}
