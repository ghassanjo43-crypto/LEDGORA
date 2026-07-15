import type { ReceiptMethod, ReceiptStatus, ReceiptType } from '@/types/receipt';
import type { BadgeTone } from '@/data/ifrsOptions';

export const RECEIPT_TYPE_LABELS: Record<ReceiptType, string> = {
  'customer-payment': 'Customer payment',
  'customer-advance': 'Customer advance',
  'unapplied-customer-receipt': 'Unapplied customer receipt',
  'miscellaneous-income': 'Miscellaneous income',
  'owner-contribution': 'Owner contribution',
  'loan-proceeds': 'Loan proceeds',
  'interest-income': 'Interest income',
  'supplier-refund': 'Supplier refund',
  other: 'Other',
};

export const RECEIPT_METHOD_LABELS: Record<ReceiptMethod, string> = {
  cash: 'Cash',
  'bank-transfer': 'Bank transfer',
  cheque: 'Cheque',
  card: 'Card',
  'online-transfer': 'Online transfer',
  other: 'Other',
};

export const RECEIPT_STATUS_TONE: Record<ReceiptStatus, BadgeTone> = {
  draft: 'slate',
  approved: 'indigo',
  posted: 'blue',
  'partially-allocated': 'amber',
  'fully-allocated': 'green',
  reversed: 'red',
  void: 'red',
};

/** Receipt types that require a customer. */
export function isCustomerReceipt(type: ReceiptType): boolean {
  return type === 'customer-payment' || type === 'customer-advance' || type === 'unapplied-customer-receipt';
}
