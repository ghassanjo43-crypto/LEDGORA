import { useEffect, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Account, AccountType } from '@/types';
import {
  accountFormSchema,
  type AccountFormValues,
} from '@/lib/validation';
import {
  ACCOUNT_TYPE_META,
  ACCOUNT_TYPE_OPTIONS,
  CASH_FLOW_OPTIONS,
  IFRS_CATEGORY_SUGGESTIONS,
  IFRS_STATEMENT_OPTIONS,
  INDUSTRY_OPTIONS,
  NORMAL_BALANCE_OPTIONS,
  PROFIT_OR_LOSS_CATEGORY_OPTIONS,
} from '@/data/ifrsOptions';
import {
  accountToFormValues,
  makeDefaultFormValues,
  useStore,
} from '@/store/useStore';
import { getDescendantIds } from '@/lib/accountTree';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { useToast } from '@/components/ui/Toast';

export type FormMode =
  | { kind: 'create'; parentId: string | null }
  | { kind: 'edit'; accountId: string };

export interface AccountFormDrawerProps {
  open: boolean;
  mode: FormMode | null;
  onClose: () => void;
}

export function AccountFormDrawer({ open, mode, onClose }: AccountFormDrawerProps) {
  const accounts = useStore((s) => s.accounts);
  const addAccount = useStore((s) => s.addAccount);
  const updateAccount = useStore((s) => s.updateAccount);
  const presentationMode = useStore((s) => s.settings.presentationMode);
  const { notify } = useToast();

  const editingAccount: Account | undefined =
    mode?.kind === 'edit' ? accounts.find((a) => a.id === mode.accountId) : undefined;

  const parentAccount: Account | undefined =
    mode?.kind === 'create' && mode.parentId
      ? accounts.find((a) => a.id === mode.parentId)
      : undefined;

  const defaultValues = useMemo<AccountFormValues>(() => {
    if (mode?.kind === 'edit' && editingAccount) {
      return accountToFormValues(editingAccount);
    }
    return makeDefaultFormValues(parentAccount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, editingAccount?.id, parentAccount?.id]);

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<AccountFormValues>({
    resolver: zodResolver(accountFormSchema),
    defaultValues,
  });

  useEffect(() => {
    if (open) reset(defaultValues);
  }, [open, defaultValues, reset]);

  const watchType = watch('type');
  const watchStatement = watch('ifrsStatement');

  // Parent options: header accounts only, excluding self + descendants when editing.
  const parentOptions = useMemo(() => {
    const excluded = new Set<string>();
    if (editingAccount) {
      excluded.add(editingAccount.id);
      for (const id of getDescendantIds(accounts, editingAccount.id)) excluded.add(id);
    }
    const options = accounts
      .filter((a) => !a.isPostingAccount && !excluded.has(a.id))
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }));
    return [{ value: '', label: 'None (top-level account)' }, ...options];
  }, [accounts, editingAccount]);

  const categorySuggestions = IFRS_CATEGORY_SUGGESTIONS[watchType as AccountType] ?? [];

  const applyTypeDefaults = (type: AccountType): void => {
    const meta = ACCOUNT_TYPE_META[type];
    setValue('normalBalance', meta.defaultNormalBalance, { shouldValidate: true });
    setValue('ifrsStatement', meta.defaultStatement, { shouldValidate: true });
    if (meta.defaultStatement !== 'PROFIT_OR_LOSS') {
      setValue('profitOrLossCategory', 'NOT_APPLICABLE');
    }
  };

  const onSubmit = (values: AccountFormValues): void => {
    const payload: AccountFormValues = {
      ...values,
      profitOrLossCategory:
        values.ifrsStatement === 'PROFIT_OR_LOSS'
          ? values.profitOrLossCategory ?? 'NOT_APPLICABLE'
          : 'NOT_APPLICABLE',
    };

    const result =
      mode?.kind === 'edit'
        ? updateAccount(mode.accountId, payload)
        : addAccount(payload, mode?.kind === 'create' ? mode.parentId : null);

    if (result.ok) {
      notify(
        mode?.kind === 'edit' ? 'Account updated.' : 'Account created.',
        'success',
      );
      onClose();
    } else {
      notify(result.error ?? 'Could not save the account.', 'error');
    }
  };

  const showPnl = watchStatement === 'PROFIT_OR_LOSS';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={mode?.kind === 'edit' ? 'Edit account' : 'New account'}
      description={
        mode?.kind === 'edit'
          ? `Editing ${editingAccount?.code} — ${editingAccount?.name}`
          : parentAccount
            ? `Child of ${parentAccount.code} — ${parentAccount.name}`
            : 'Create a new top-level account'
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>
            {mode?.kind === 'edit' ? 'Save changes' : 'Create account'}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Account code" required error={errors.code?.message} htmlFor="code">
            <Input
              id="code"
              placeholder="e.g. 1221"
              hasError={!!errors.code}
              {...register('code')}
            />
          </Field>

          <Field label="Account type" required error={errors.type?.message} htmlFor="type">
            <Controller
              control={control}
              name="type"
              render={({ field }) => (
                <Select
                  id="type"
                  options={ACCOUNT_TYPE_OPTIONS}
                  value={field.value}
                  hasError={!!errors.type}
                  onChange={(e) => {
                    const value = e.target.value as AccountType;
                    field.onChange(value);
                    applyTypeDefaults(value);
                  }}
                />
              )}
            />
          </Field>
        </div>

        <Field label="Account name" required error={errors.name?.message} htmlFor="name">
          <Input
            id="name"
            placeholder="e.g. Trade receivables"
            hasError={!!errors.name}
            {...register('name')}
          />
        </Field>

        <Field
          label="Parent account"
          error={errors.parentId?.message}
          hint="Choose a header account, or leave as top-level. Changing this moves the account."
          htmlFor="parentId"
        >
          <Controller
            control={control}
            name="parentId"
            render={({ field }) => (
              <Select
                id="parentId"
                options={parentOptions}
                value={field.value ?? ''}
                onChange={(e) => field.onChange(e.target.value === '' ? null : e.target.value)}
              />
            )}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="IFRS statement" required error={errors.ifrsStatement?.message} htmlFor="stmt">
            <Select
              id="stmt"
              options={IFRS_STATEMENT_OPTIONS}
              hasError={!!errors.ifrsStatement}
              {...register('ifrsStatement')}
            />
          </Field>

          <Field label="Normal balance" required error={errors.normalBalance?.message} htmlFor="nb">
            <Select
              id="nb"
              options={NORMAL_BALANCE_OPTIONS}
              hasError={!!errors.normalBalance}
              {...register('normalBalance')}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="IFRS category"
            required
            error={errors.ifrsCategory?.message}
            htmlFor="cat"
            hint={categorySuggestions.length ? `Suggestions: ${categorySuggestions.join(', ')}` : undefined}
          >
            <Input
              id="cat"
              list="ifrs-category-suggestions"
              placeholder="e.g. Current assets"
              hasError={!!errors.ifrsCategory}
              {...register('ifrsCategory')}
            />
            <datalist id="ifrs-category-suggestions">
              {categorySuggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>

          <Field label="IFRS subcategory" error={errors.ifrsSubcategory?.message} htmlFor="subcat">
            <Input
              id="subcat"
              placeholder="e.g. Trade receivables"
              {...register('ifrsSubcategory')}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Cash flow category" error={errors.cashFlowCategory?.message} htmlFor="cf">
            <Select id="cf" options={CASH_FLOW_OPTIONS} {...register('cashFlowCategory')} />
          </Field>

          <Field label="Industry tag" htmlFor="ind">
            <Select id="ind" options={INDUSTRY_OPTIONS} {...register('industryTag')} />
          </Field>
        </div>

        {showPnl && (
          <Field
            label="Profit or loss category (IFRS 18)"
            htmlFor="pnl"
            hint={
              presentationMode === 'IFRS_18'
                ? 'Required in IFRS 18 presentation mode.'
                : 'Used when the company switches to IFRS 18 presentation.'
            }
          >
            <Select
              id="pnl"
              options={PROFIT_OR_LOSS_CATEGORY_OPTIONS}
              {...register('profitOrLossCategory')}
            />
          </Field>
        )}

        <Field label="Description / notes" error={errors.description?.message} htmlFor="desc">
          <Textarea
            id="desc"
            placeholder="Optional notes about how this account should be used."
            {...register('description')}
          />
        </Field>

        <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <Controller
            control={control}
            name="isPostingAccount"
            render={({ field }) => (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                    Posting account
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Posting accounts receive journal entries. Headers only group children.
                  </p>
                </div>
                <Toggle checked={field.value} onChange={field.onChange} label="Posting account" />
              </div>
            )}
          />
          <Controller
            control={control}
            name="isActive"
            render={({ field }) => (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">Active</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Inactive accounts stay visible but cannot be used for new transactions.
                  </p>
                </div>
                <Toggle checked={field.value} onChange={field.onChange} label="Active" />
              </div>
            )}
          />
        </div>
      </form>
    </Drawer>
  );
}
