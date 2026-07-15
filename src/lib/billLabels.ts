import type { BillStatus, BillType, BillPaymentMethod } from '@/types/bill';
import type { BadgeTone } from '@/data/ifrsOptions';

export const BILL_TYPE_LABELS: Record<BillType, string> = {
  goods: 'Goods',
  services: 'Services',
  expense: 'Expense',
  'asset-purchase': 'Asset purchase',
  'inventory-purchase': 'Inventory purchase',
  other: 'Other',
};

export const BILL_STATUS_TONE: Record<BillStatus, BadgeTone> = {
  draft: 'slate',
  submitted: 'indigo',
  approved: 'violet',
  posted: 'blue',
  'partially-paid': 'amber',
  paid: 'green',
  void: 'red',
  reversed: 'red',
};

export const BILL_PAYMENT_METHOD_LABELS: Record<BillPaymentMethod, string> = {
  cash: 'Cash',
  'bank-transfer': 'Bank transfer',
  cheque: 'Cheque',
  card: 'Card',
  'online-transfer': 'Online transfer',
  other: 'Other',
};
