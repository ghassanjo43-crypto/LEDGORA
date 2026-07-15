import type { Invoice, InvoiceCompanySnapshot, InvoiceCustomerSnapshot } from '@/types/invoice';
import type { CompanySettings } from '@/types';

/** Realistic sample invoice used to preview a template. */
export function makeSampleInvoice(currency: string): Invoice {
  return {
    id: 'sample', entityId: 'primary', customerId: 'sample', invoiceNumber: 'INV-2026-0007', status: 'issued',
    issueDate: '2026-07-11', dueDate: '2026-08-10', currency, exchangeRate: 1, purchaseOrderReference: 'PO-5521',
    templateId: '', templateVersionId: '', templateResolutionSource: 'system-default',
    lines: [
      { id: 's1', accountId: 'r', description: 'Consulting services — July', quantity: 12, unit: 'hrs', unitPrice: 150, taxRate: 15, taxAmount: 270, lineSubtotal: 1800, lineTotal: 2070, sortOrder: 1 },
      { id: 's2', accountId: 'r', description: 'Onboarding package', quantity: 1, unit: 'ea', unitPrice: 500, discountType: 'percentage', discountValue: 10, taxRate: 15, taxAmount: 67.5, lineSubtotal: 500, lineTotal: 517.5, sortOrder: 2 },
    ],
    subtotal: 2300, discountTotal: 50, taxTotal: 337.5, additionalChargesTotal: 0, grandTotal: 2587.5, amountPaid: 0, creditsApplied: 0, balanceDue: 2587.5,
    paymentTerms: 'Net 30', terms: 'Payment due within 30 days of the invoice date.', notes: 'Thank you for your business.', payments: [], auditTrail: [], createdAt: '', updatedAt: '',
  };
}

export function sampleCompanyFromSettings(settings: CompanySettings): InvoiceCompanySnapshot {
  return {
    legalName: settings.companyName || 'Your Company LLC',
    tradingName: settings.tradingName || undefined,
    address: [settings.addressLine1, settings.city, settings.country].filter(Boolean).join(', ') || 'Business Bay, Dubai, UAE',
    taxNumber: settings.taxRegistrationNumber || '100123456700003',
    registrationNumber: settings.registrationNumber || 'CN-1234567',
    phone: settings.phone || '+971 4 000 0000',
    email: settings.email || 'billing@company.example',
    website: settings.website || 'company.example',
    logoUrl: settings.logoUrl || undefined,
    bankDetails: 'Bank of Ledgora · A/C 0123456789 · IBAN AE00 0000 0000 0000',
  };
}

export const SAMPLE_CUSTOMER: InvoiceCustomerSnapshot = {
  name: 'Blue Horizon Hospitality LLC',
  billingAddress: 'Sheikh Zayed Road, Dubai, UAE',
  taxNumber: '100987654300003',
  phone: '+971 4 111 2222',
  email: 'ap@bluehorizon.example',
};
