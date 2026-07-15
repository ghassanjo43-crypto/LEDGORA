import type {
  EntityType,
  InvoiceDeliveryMethod,
  PaymentMethod,
  PaymentTerms,
} from '@/types';
import type { BadgeTone, Option } from '@/data/ifrsOptions';

export const ENTITY_TYPE_OPTIONS: Option<EntityType>[] = [
  { value: 'customer', label: 'Customer' },
  { value: 'supplier', label: 'Supplier' },
  { value: 'both', label: 'Customer & Supplier' },
];

export const ENTITY_TYPE_META: Record<
  EntityType,
  { label: string; short: string; tone: BadgeTone }
> = {
  customer: { label: 'Customer', short: 'Customer', tone: 'green' },
  supplier: { label: 'Supplier', short: 'Supplier', tone: 'amber' },
  both: { label: 'Customer & Supplier', short: 'Both', tone: 'violet' },
};

export const PAYMENT_TERMS_OPTIONS: Option<PaymentTerms>[] = [
  { value: 'DUE_ON_RECEIPT', label: 'Due on receipt' },
  { value: 'NET_7', label: 'Net 7 days' },
  { value: 'NET_15', label: 'Net 15 days' },
  { value: 'NET_30', label: 'Net 30 days' },
  { value: 'NET_45', label: 'Net 45 days' },
  { value: 'NET_60', label: 'Net 60 days' },
  { value: 'NET_90', label: 'Net 90 days' },
];

/** Payment-term options that include an empty "use entity default" choice. */
export const PAYMENT_TERMS_OPTIONS_WITH_DEFAULT: Option<string>[] = [
  { value: '', label: 'Use entity default' },
  ...PAYMENT_TERMS_OPTIONS,
];

export const INVOICE_DELIVERY_OPTIONS: Option<InvoiceDeliveryMethod | ''>[] = [
  { value: '', label: '—' },
  { value: 'email', label: 'Email' },
  { value: 'portal', label: 'Customer portal' },
  { value: 'post', label: 'Postal mail' },
  { value: 'edi', label: 'EDI' },
];

export const PAYMENT_METHOD_OPTIONS: Option<PaymentMethod | ''>[] = [
  { value: '', label: '—' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'letter_of_credit', label: 'Letter of credit' },
];

export const CUSTOMER_CATEGORY_OPTIONS: Option<string>[] = [
  { value: '', label: '—' },
  { value: 'key_account', label: 'Key account' },
  { value: 'wholesale', label: 'Wholesale' },
  { value: 'retail', label: 'Retail' },
  { value: 'government', label: 'Government' },
  { value: 'project', label: 'Project-based' },
  { value: 'online', label: 'Online / e-commerce' },
];

export const SUPPLIER_CATEGORY_OPTIONS: Option<string>[] = [
  { value: '', label: '—' },
  { value: 'materials', label: 'Materials' },
  { value: 'services', label: 'Services' },
  { value: 'subcontractor', label: 'Subcontractor' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'logistics', label: 'Logistics' },
  { value: 'it_equipment', label: 'IT & equipment' },
  { value: 'professional', label: 'Professional services' },
];

/** A pragmatic country list; users can extend by importing. */
export const COUNTRY_OPTIONS: Option<string>[] = [
  { value: 'United Arab Emirates', label: 'United Arab Emirates' },
  { value: 'Saudi Arabia', label: 'Saudi Arabia' },
  { value: 'Qatar', label: 'Qatar' },
  { value: 'Kuwait', label: 'Kuwait' },
  { value: 'Bahrain', label: 'Bahrain' },
  { value: 'Oman', label: 'Oman' },
  { value: 'Jordan', label: 'Jordan' },
  { value: 'Egypt', label: 'Egypt' },
  { value: 'United Kingdom', label: 'United Kingdom' },
  { value: 'United States', label: 'United States' },
  { value: 'Germany', label: 'Germany' },
  { value: 'India', label: 'India' },
];

export function paymentTermsLabel(term: PaymentTerms | ''): string {
  if (!term) return 'Default';
  return PAYMENT_TERMS_OPTIONS.find((o) => o.value === term)?.label ?? term;
}
