/**
 * Print a UBL 2.1 invoice built by our own builder, for driving the mock by hand.
 *
 *   npx tsx scripts/sample-invoice.ts > /tmp/invoice.xml
 *   curl -X POST http://127.0.0.1:4000/api/mock/jofotara/submit \
 *        -H 'content-type: application/xml' --data-binary @/tmp/invoice.xml
 *
 * It uses PLACEHOLDER_PROFILE, so the document is structurally correct UBL and
 * carries no real Jordanian codes. See `ublProfile.ts`.
 */
import { buildInvoiceXml } from '../src/services/invoicing/ubl/invoiceXml.js';
import { PLACEHOLDER_PROFILE } from '../src/services/invoicing/ubl/ublProfile.js';

process.stdout.write(buildInvoiceXml({
  invoiceNumber: 'INV-2026-0001', issueDate: '2026-03-01', dueDate: '2026-03-31', currencyCode: 'JOD',
  supplier: { name: 'Ledgora Test LLC', taxNumber: '123456789', city: 'Amman', countryCode: 'JO' },
  customer: { name: 'Acme Trading', taxNumber: '987654321', city: 'Irbid', countryCode: 'JO' },
  lines: [{
    id: '1', quantity: '2', unitCode: 'PCE', lineExtensionAmount: '200.000',
    unitPrice: '100.000', taxAmount: '32.000', taxPercent: '16.00', itemName: 'Consulting',
  }],
  lineExtensionAmount: '200.000', taxExclusiveAmount: '200.000',
  taxInclusiveAmount: '232.000', payableAmount: '232.000', taxAmount: '32.000',
}, PLACEHOLDER_PROFILE));
