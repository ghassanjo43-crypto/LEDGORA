import type { CreditNoteReasonCode, CreditNoteStatus, CreditType } from '@/types/creditNote';
import type { BadgeTone } from '@/data/ifrsOptions';

/** Human-readable labels for the controlled reason codes. */
export const CREDIT_NOTE_REASON_LABELS: Record<CreditNoteReasonCode, string> = {
  'goods-returned': 'Goods returned',
  'service-cancelled': 'Service cancelled',
  'invoice-overcharge': 'Invoice overcharge',
  'pricing-error': 'Pricing error',
  'quantity-error': 'Quantity error',
  'tax-error': 'Tax error',
  'discount-adjustment': 'Discount adjustment',
  'damaged-goods': 'Damaged goods',
  'customer-goodwill': 'Customer goodwill',
  'duplicate-invoice': 'Duplicate invoice',
  other: 'Other',
};

export const CREDIT_TYPE_LABELS: Record<CreditType, string> = {
  full: 'Full credit',
  partial: 'Partial credit',
  'selected-lines': 'Selected lines',
  'price-adjustment': 'Price adjustment',
  'general-credit': 'General customer credit',
};

export const CREDIT_NOTE_STATUS_TONE: Record<CreditNoteStatus, BadgeTone> = {
  draft: 'slate',
  approved: 'indigo',
  issued: 'blue',
  applied: 'green',
  'partially-applied': 'amber',
  refunded: 'cyan',
  void: 'red',
};
