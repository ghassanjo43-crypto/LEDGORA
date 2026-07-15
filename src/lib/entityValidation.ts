import { z } from 'zod';
import type { BusinessEntity, EntityValidationIssue } from '@/types';
import { generateId } from './utils';

const entityTypeEnum = z.enum(['customer', 'supplier', 'both']);
const paymentTermsEnum = z.enum([
  'DUE_ON_RECEIPT',
  'NET_7',
  'NET_15',
  'NET_30',
  'NET_45',
  'NET_60',
  'NET_90',
]);
const paymentTermsOrEmpty = z.union([paymentTermsEnum, z.literal('')]);
const invoiceDeliveryEnum = z.union([
  z.enum(['email', 'portal', 'post', 'edi']),
  z.literal(''),
]);
const paymentMethodEnum = z.union([
  z.enum(['bank_transfer', 'cheque', 'cash', 'card', 'letter_of_credit']),
  z.literal(''),
]);

/** Basic IBAN shape (2 letters + 2 digits + up to 30 alphanumerics). */
const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/u;
/** SWIFT/BIC shape (8 or 11 characters). */
const SWIFT_RE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/u;

const optionalUrl = z
  .string()
  .trim()
  .max(200)
  .refine(
    (v) => v === '' || /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/.*)?$/iu.test(v),
    'Enter a valid website URL',
  );

/** Schema for the create/edit form (React Hook Form + Zod resolver). */
export const entityFormSchema = z
  .object({
    entityCode: z.string().trim().min(2, 'Entity code is required').max(40),
    legalName: z.string().trim().min(2, 'Legal name is required').max(160),
    tradingName: z.string().trim().max(160),
    entityType: entityTypeEnum,

    contactPerson: z.string().trim().max(120),
    jobTitle: z.string().trim().max(120),
    email: z.string().trim().email('Enter a valid email address').max(160),
    phone: z.string().trim().max(40),
    mobile: z.string().trim().max(40),
    website: optionalUrl,

    country: z.string().trim().max(80),
    city: z.string().trim().max(80),
    addressLine1: z.string().trim().max(160),
    addressLine2: z.string().trim().max(160),
    postalCode: z.string().trim().max(40),

    taxRegistrationNumber: z.string().trim().max(60),
    commercialRegistrationNumber: z.string().trim().max(60),
    paymentTerms: paymentTermsEnum,
    defaultCurrency: z.string().trim().min(3).max(3),

    bankName: z.string().trim().max(120),
    bankAccountName: z.string().trim().max(160),
    iban: z
      .string()
      .trim()
      .max(40)
      .refine((v) => v === '' || IBAN_RE.test(v.replace(/\s+/gu, '').toUpperCase()), 'Enter a valid IBAN'),
    swiftCode: z
      .string()
      .trim()
      .max(11)
      .refine((v) => v === '' || SWIFT_RE.test(v.toUpperCase()), 'Enter a valid SWIFT/BIC code'),

    notes: z.string().trim().max(1000),
    isActive: z.boolean(),

    customerCategory: z.string().trim().max(60),
    creditLimit: z.coerce.number().min(0, 'Credit limit cannot be negative').max(1_000_000_000),
    defaultRevenueAccount: z.string().trim().max(60),
    defaultReceivableAccount: z.string().trim().max(60),
    defaultInvoiceTemplateId: z.string().trim().max(60),
    invoiceDeliveryMethod: invoiceDeliveryEnum,
    customerPaymentTerms: paymentTermsOrEmpty,

    supplierCategory: z.string().trim().max(60),
    defaultExpenseAccount: z.string().trim().max(60),
    defaultPayableAccount: z.string().trim().max(60),
    supplierPaymentTerms: paymentTermsOrEmpty,
    withholdingTaxApplicable: z.boolean(),
    preferredPaymentMethod: paymentMethodEnum,
  })
  .strip();

export type EntityFormValues = z.infer<typeof entityFormSchema>;

/** Schema for a persisted entity (used to validate imported JSON/CSV). */
export const businessEntitySchema = entityFormSchema.extend({
  id: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const entitiesArraySchema = z.array(businessEntitySchema);

/** Validate the whole directory and return a flat list of issues. */
export function validateEntities(entities: BusinessEntity[]): EntityValidationIssue[] {
  const issues: EntityValidationIssue[] = [];
  const codeCounts = new Map<string, BusinessEntity[]>();
  const taxCounts = new Map<string, BusinessEntity[]>();
  const nameCounts = new Map<string, BusinessEntity[]>();

  for (const e of entities) {
    const codeKey = e.entityCode.trim().toLowerCase();
    codeCounts.set(codeKey, [...(codeCounts.get(codeKey) ?? []), e]);

    const tax = e.taxRegistrationNumber.trim().toLowerCase();
    if (tax) taxCounts.set(tax, [...(taxCounts.get(tax) ?? []), e]);

    const name = e.legalName.trim().toLowerCase();
    if (name) nameCounts.set(name, [...(nameCounts.get(name) ?? []), e]);
  }

  const push = (
    entity: BusinessEntity | null,
    severity: EntityValidationIssue['severity'],
    rule: string,
    message: string,
  ): void => {
    issues.push({
      id: generateId('eiss'),
      entityId: entity?.id ?? null,
      entityCode: entity?.entityCode ?? null,
      severity,
      rule,
      message,
    });
  };

  for (const [, list] of codeCounts) {
    if (list.length > 1) {
      for (const e of list) push(e, 'error', 'unique-code', `Duplicate entity code "${e.entityCode}".`);
    }
  }
  for (const [, list] of taxCounts) {
    if (list.length > 1) {
      for (const e of list) {
        push(e, 'error', 'unique-tax', `Tax registration number "${e.taxRegistrationNumber}" is used by more than one entity.`);
      }
    }
  }
  for (const [, list] of nameCounts) {
    if (list.length > 1) {
      for (const e of list) push(e, 'warning', 'duplicate-name', `Legal name "${e.legalName}" appears on more than one entity.`);
    }
  }

  for (const e of entities) {
    if (e.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(e.email)) {
      push(e, 'error', 'invalid-email', `"${e.legalName}" has an invalid email address.`);
    }
  }

  return issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return (a.entityCode ?? '').localeCompare(b.entityCode ?? '');
  });
}
