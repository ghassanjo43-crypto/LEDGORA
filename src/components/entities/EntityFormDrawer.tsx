import { useEffect, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { AccountType, BusinessEntity, EntityType } from '@/types';
import { entityFormSchema, type EntityFormValues } from '@/lib/entityValidation';
import {
  entityToFormValues,
  makeDefaultEntityValues,
  useEntityStore,
} from '@/store/useEntityStore';
import { useStore } from '@/store/useStore';
import {
  CUSTOMER_CATEGORY_OPTIONS,
  ENTITY_TYPE_OPTIONS,
  INVOICE_DELIVERY_OPTIONS,
  PAYMENT_METHOD_OPTIONS,
  PAYMENT_TERMS_OPTIONS,
  PAYMENT_TERMS_OPTIONS_WITH_DEFAULT,
  SUPPLIER_CATEGORY_OPTIONS,
} from '@/data/entityOptions';
import { CURRENCY_OPTIONS } from '@/data/ifrsOptions';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { useToast } from '@/components/ui/Toast';
import { useInvoiceTemplateStore } from '@/store/invoiceTemplateStore';

export type EntityFormMode =
  | { kind: 'create'; type: EntityType }
  | { kind: 'edit'; entityId: string };

interface EntityFormDrawerProps {
  open: boolean;
  mode: EntityFormMode | null;
  onClose: () => void;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="col-span-full mt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
      {children}
    </h3>
  );
}

export function EntityFormDrawer({ open, mode, onClose }: EntityFormDrawerProps) {
  const entities = useEntityStore((s) => s.entities);
  const addEntity = useEntityStore((s) => s.addEntity);
  const updateEntity = useEntityStore((s) => s.updateEntity);
  const accounts = useStore((s) => s.accounts);
  const { notify } = useToast();

  const editing: BusinessEntity | undefined =
    mode?.kind === 'edit' ? entities.find((e) => e.id === mode.entityId) : undefined;

  const defaultValues = useMemo<EntityFormValues>(() => {
    if (mode?.kind === 'edit' && editing) return entityToFormValues(editing);
    return makeDefaultEntityValues(mode?.kind === 'create' ? mode.type : 'customer');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, editing?.id]);

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<EntityFormValues>({
    resolver: zodResolver(entityFormSchema),
    defaultValues,
  });

  useEffect(() => {
    if (open) reset(defaultValues);
  }, [open, defaultValues, reset]);

  const entityType = watch('entityType');
  const showCustomer = entityType === 'customer' || entityType === 'both';
  const showSupplier = entityType === 'supplier' || entityType === 'both';

  // Invoice-template options for the customer's Default Invoice Template field.
  const invoiceTemplates = useInvoiceTemplateStore((s) => s.templates);
  const invoiceVersions = useInvoiceTemplateStore((s) => s.versions);
  const invoiceTemplateOptions = useMemo(() => {
    const opts = invoiceTemplates
      .filter((t) => !t.isArchived && invoiceVersions.some((v) => v.templateId === t.id && v.status === 'published'))
      .map((t) => ({ value: t.id, label: t.name }));
    return [{ value: '', label: 'Company default' }, ...opts];
  }, [invoiceTemplates, invoiceVersions]);

  // Account link options, filtered to active posting accounts of relevant types.
  const accountOptions = useMemo(() => {
    const build = (types: AccountType[]) => {
      const opts = accounts
        .filter((a) => a.isPostingAccount && a.isActive && types.includes(a.type))
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }));
      return [{ value: '', label: 'Not linked' }, ...opts];
    };
    return {
      revenue: build(['INCOME', 'OTHER_INCOME_EXPENSE']),
      receivable: build(['ASSET']),
      expense: build(['OPERATING_EXPENSE', 'COST_OF_SALES', 'OTHER_INCOME_EXPENSE']),
      payable: build(['LIABILITY']),
    };
  }, [accounts]);

  const onSubmit = (values: EntityFormValues): void => {
    const result =
      mode?.kind === 'edit'
        ? updateEntity(mode.entityId, values)
        : addEntity(values);
    if (result.ok) {
      notify(mode?.kind === 'edit' ? 'Entity updated.' : 'Entity created.', 'success');
      onClose();
    } else {
      notify(result.error ?? 'Could not save the entity.', 'error');
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      widthClassName="max-w-2xl"
      title={mode?.kind === 'edit' ? 'Edit business entity' : 'New business entity'}
      description={
        mode?.kind === 'edit'
          ? `${editing?.entityCode} — ${editing?.legalName}`
          : 'Customers are entities you invoice; suppliers are entities who invoice you.'
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>
            {mode?.kind === 'edit' ? 'Save changes' : 'Create entity'}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SectionTitle>Identity</SectionTitle>
        <Field label="Entity code" required error={errors.entityCode?.message} htmlFor="entityCode">
          <Input id="entityCode" placeholder="e.g. ENT-1001" hasError={!!errors.entityCode} {...register('entityCode')} />
        </Field>
        <Field label="Relationship type" required error={errors.entityType?.message} htmlFor="entityType">
          <Select id="entityType" options={ENTITY_TYPE_OPTIONS} hasError={!!errors.entityType} {...register('entityType')} />
        </Field>
        <Field label="Legal name" required error={errors.legalName?.message} htmlFor="legalName">
          <Input id="legalName" placeholder="Registered legal name" hasError={!!errors.legalName} {...register('legalName')} />
        </Field>
        <Field label="Trading name" error={errors.tradingName?.message} htmlFor="tradingName">
          <Input id="tradingName" placeholder="Brand / trading as" {...register('tradingName')} />
        </Field>

        <SectionTitle>Primary contact</SectionTitle>
        <Field label="Contact person" error={errors.contactPerson?.message} htmlFor="contactPerson">
          <Input id="contactPerson" {...register('contactPerson')} />
        </Field>
        <Field label="Job title" error={errors.jobTitle?.message} htmlFor="jobTitle">
          <Input id="jobTitle" {...register('jobTitle')} />
        </Field>
        <Field label="Email" required error={errors.email?.message} htmlFor="email">
          <Input id="email" type="email" placeholder="name@company.example" hasError={!!errors.email} {...register('email')} />
        </Field>
        <Field label="Website" error={errors.website?.message} htmlFor="website">
          <Input id="website" placeholder="https://company.example" hasError={!!errors.website} {...register('website')} />
        </Field>
        <Field label="Phone" error={errors.phone?.message} htmlFor="phone">
          <Input id="phone" {...register('phone')} />
        </Field>
        <Field label="Mobile" error={errors.mobile?.message} htmlFor="mobile">
          <Input id="mobile" {...register('mobile')} />
        </Field>

        <SectionTitle>Address</SectionTitle>
        <Field label="Country" error={errors.country?.message} htmlFor="country">
          <Input id="country" {...register('country')} />
        </Field>
        <Field label="City" error={errors.city?.message} htmlFor="city">
          <Input id="city" {...register('city')} />
        </Field>
        <Field label="Address line 1" error={errors.addressLine1?.message} htmlFor="addressLine1">
          <Input id="addressLine1" {...register('addressLine1')} />
        </Field>
        <Field label="Address line 2" error={errors.addressLine2?.message} htmlFor="addressLine2">
          <Input id="addressLine2" {...register('addressLine2')} />
        </Field>
        <Field label="Postal code" error={errors.postalCode?.message} htmlFor="postalCode">
          <Input id="postalCode" {...register('postalCode')} />
        </Field>

        <SectionTitle>Commercial &amp; tax</SectionTitle>
        <Field label="Tax registration number" error={errors.taxRegistrationNumber?.message} htmlFor="trn">
          <Input id="trn" placeholder="Unique if provided" {...register('taxRegistrationNumber')} />
        </Field>
        <Field label="Commercial registration no." error={errors.commercialRegistrationNumber?.message} htmlFor="crn">
          <Input id="crn" {...register('commercialRegistrationNumber')} />
        </Field>
        <Field label="Default payment terms" error={errors.paymentTerms?.message} htmlFor="paymentTerms">
          <Select id="paymentTerms" options={PAYMENT_TERMS_OPTIONS} {...register('paymentTerms')} />
        </Field>
        <Field label="Default currency" required error={errors.defaultCurrency?.message} htmlFor="currency">
          <Select id="currency" options={CURRENCY_OPTIONS} hasError={!!errors.defaultCurrency} {...register('defaultCurrency')} />
        </Field>

        <SectionTitle>Banking</SectionTitle>
        <Field label="Bank name" error={errors.bankName?.message} htmlFor="bankName">
          <Input id="bankName" {...register('bankName')} />
        </Field>
        <Field label="Bank account name" error={errors.bankAccountName?.message} htmlFor="bankAccountName">
          <Input id="bankAccountName" {...register('bankAccountName')} />
        </Field>
        <Field label="IBAN" error={errors.iban?.message} hint="Optional — validated if entered." htmlFor="iban">
          <Input id="iban" placeholder="AE07 0331 2345 6789 0123 456" hasError={!!errors.iban} {...register('iban')} />
        </Field>
        <Field label="SWIFT / BIC" error={errors.swiftCode?.message} hint="Optional — validated if entered." htmlFor="swift">
          <Input id="swift" placeholder="EBILAEAD" hasError={!!errors.swiftCode} {...register('swiftCode')} />
        </Field>

        {showCustomer && (
          <>
            <SectionTitle>Customer settings</SectionTitle>
            <Field label="Customer category" htmlFor="customerCategory">
              <Select id="customerCategory" options={CUSTOMER_CATEGORY_OPTIONS} {...register('customerCategory')} />
            </Field>
            <Field label="Credit limit" error={errors.creditLimit?.message} htmlFor="creditLimit">
              <Input id="creditLimit" type="number" min={0} step="100" hasError={!!errors.creditLimit} {...register('creditLimit')} />
            </Field>
            <Field label="Default receivable account (AR)" htmlFor="ar" hint="Links customer balances to Accounts Receivable.">
              <Select id="ar" options={accountOptions.receivable} {...register('defaultReceivableAccount')} />
            </Field>
            <Field label="Default revenue account" htmlFor="rev">
              <Select id="rev" options={accountOptions.revenue} {...register('defaultRevenueAccount')} />
            </Field>
            <Field label="Invoice delivery method" htmlFor="idm">
              <Select id="idm" options={INVOICE_DELIVERY_OPTIONS} {...register('invoiceDeliveryMethod')} />
            </Field>
            <Field label="Customer payment terms" htmlFor="cpt">
              <Select id="cpt" options={PAYMENT_TERMS_OPTIONS_WITH_DEFAULT} {...register('customerPaymentTerms')} />
            </Field>
            <Field label="Default invoice template" htmlFor="dit" className="sm:col-span-2" hint="Applied automatically to new invoices for this customer. Leave on “Company default” to use the entity default.">
              <Select id="dit" options={invoiceTemplateOptions} {...register('defaultInvoiceTemplateId')} />
            </Field>
          </>
        )}

        {showSupplier && (
          <>
            <SectionTitle>Supplier settings</SectionTitle>
            <Field label="Supplier category" htmlFor="supplierCategory">
              <Select id="supplierCategory" options={SUPPLIER_CATEGORY_OPTIONS} {...register('supplierCategory')} />
            </Field>
            <Field label="Preferred payment method" htmlFor="ppm">
              <Select id="ppm" options={PAYMENT_METHOD_OPTIONS} {...register('preferredPaymentMethod')} />
            </Field>
            <Field label="Default payable account (AP)" htmlFor="ap" hint="Links supplier balances to Accounts Payable.">
              <Select id="ap" options={accountOptions.payable} {...register('defaultPayableAccount')} />
            </Field>
            <Field label="Default expense account" htmlFor="exp">
              <Select id="exp" options={accountOptions.expense} {...register('defaultExpenseAccount')} />
            </Field>
            <Field label="Supplier payment terms" htmlFor="spt">
              <Select id="spt" options={PAYMENT_TERMS_OPTIONS_WITH_DEFAULT} {...register('supplierPaymentTerms')} />
            </Field>
            <Controller
              control={control}
              name="withholdingTaxApplicable"
              render={({ field }) => (
                <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-800">
                  <span className="text-sm text-slate-700 dark:text-slate-200">Withholding tax applicable</span>
                  <Toggle checked={field.value} onChange={field.onChange} label="Withholding tax applicable" />
                </div>
              )}
            />
          </>
        )}

        <SectionTitle>Other</SectionTitle>
        <Field label="Notes" className="sm:col-span-2" error={errors.notes?.message} htmlFor="notes">
          <Textarea id="notes" placeholder="Internal notes about this entity." {...register('notes')} />
        </Field>
        <Controller
          control={control}
          name="isActive"
          render={({ field }) => (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 px-3 py-2.5 sm:col-span-2 dark:border-slate-800">
              <div>
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200">Active</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Inactive entities stay visible but cannot be selected for new transactions.
                </p>
              </div>
              <Toggle checked={field.value} onChange={field.onChange} label="Active" />
            </div>
          )}
        />
      </form>
    </Drawer>
  );
}
