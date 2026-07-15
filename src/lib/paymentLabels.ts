import type { PaymentMethod, PaymentStatus, PaymentType } from '@/types/payment';
import type { BadgeTone } from '@/data/ifrsOptions';

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  'supplier-payment': 'Supplier payment',
  'supplier-advance': 'Supplier advance',
  'unapplied-supplier-payment': 'Unapplied supplier payment',
  'expense-payment': 'Expense payment',
  'tax-payment': 'Tax payment',
  'payroll-payment': 'Payroll payment',
  'loan-repayment': 'Loan repayment',
  'lease-payment': 'Lease payment',
  'owner-drawing': 'Owner drawing',
  'dividend-payment': 'Dividend payment',
  'customer-refund': 'Customer refund',
  'credit-note-refund': 'Credit-note refund',
  other: 'Other',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  'bank-transfer': 'Bank transfer',
  cash: 'Cash',
  cheque: 'Cheque',
  card: 'Card',
  'online-transfer': 'Online transfer',
  'direct-debit': 'Direct debit',
  other: 'Other',
};

export const PAYMENT_STATUS_TONE: Record<PaymentStatus, BadgeTone> = {
  draft: 'slate',
  submitted: 'indigo',
  approved: 'indigo',
  posted: 'blue',
  'partially-allocated': 'amber',
  'fully-allocated': 'green',
  reversed: 'red',
  void: 'red',
};

/** Payment types that settle supplier bills / carry supplier allocations. */
export function isSupplierPaymentType(type: PaymentType): boolean {
  return type === 'supplier-payment' || type === 'supplier-advance' || type === 'unapplied-supplier-payment';
}

/** Payment types that refund a customer (Dr receivables/credit, Cr bank). */
export function isCustomerRefundType(type: PaymentType): boolean {
  return type === 'customer-refund' || type === 'credit-note-refund';
}

/** Payment types that require an explicit debit account chosen by the user. */
export function requiresDebitAccount(type: PaymentType): boolean {
  return (
    type === 'expense-payment' ||
    type === 'tax-payment' ||
    type === 'payroll-payment' ||
    type === 'owner-drawing' ||
    type === 'dividend-payment' ||
    type === 'other'
  );
}
