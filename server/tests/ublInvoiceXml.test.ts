/**
 * The UBL 2.1 invoice builder.
 *
 * These tests pin the parts of UBL that are PUBLIC and country-independent —
 * element sequence, namespaces, currency attributes, escaping — because those
 * are the parts that can be verified today without a specification in hand.
 *
 * They deliberately do NOT assert that any output is acceptable to JoFotara.
 * Nothing here has been checked against ISTD's specification, and a test that
 * claimed otherwise would be the most expensive kind of wrong: a green tick
 * standing in for a compliance review nobody performed.
 */
import { describe, expect, it } from 'vitest';
import { buildInvoiceXml, escapeXml, type UblInvoiceInput } from '../src/services/invoicing/ubl/invoiceXml.js';
import {
  PLACEHOLDER_PROFILE,
  UnverifiedProfileError,
  assertSubmittable,
} from '../src/services/invoicing/ubl/ublProfile.js';

const input = (over: Partial<UblInvoiceInput> = {}): UblInvoiceInput => ({
  invoiceNumber: 'INV-2026-0001',
  issueDate: '2026-03-01',
  dueDate: '2026-03-31',
  currencyCode: 'JOD',
  supplier: { name: 'Ledgora Test LLC', taxNumber: '123456789', city: 'Amman', countryCode: 'JO' },
  customer: { name: 'Acme Trading', taxNumber: '987654321', city: 'Irbid', countryCode: 'JO' },
  lines: [{
    id: '1', quantity: '2', unitCode: 'PCE',
    lineExtensionAmount: '200.000', unitPrice: '100.000',
    taxAmount: '32.000', taxPercent: '16.00', itemName: 'Consulting',
  }],
  lineExtensionAmount: '200.000',
  taxExclusiveAmount: '200.000',
  taxInclusiveAmount: '232.000',
  payableAmount: '232.000',
  taxAmount: '32.000',
  ...over,
});

const build = (over: Partial<UblInvoiceInput> = {}) => buildInvoiceXml(input(over), PLACEHOLDER_PROFILE);

/** Index of a tag in the document, for order assertions. */
const at = (xml: string, tag: string): number => xml.indexOf(`<${tag}`);

describe('the document skeleton', () => {
  it('declares the three UBL 2.1 namespaces', () => {
    const xml = build();
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
    expect(xml).toContain('urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2');
    expect(xml).toContain('urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2');
  });

  it('starts with an XML declaration and closes the root', () => {
    const xml = build();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml.trimEnd().endsWith('</Invoice>')).toBe(true);
  });
});

describe('element order', () => {
  /*
   * UBL's schema uses xsd:sequence. An Invoice carrying every correct value in
   * the wrong order is invalid, and this is the single most common way a
   * hand-built UBL document fails validation.
   */
  it('follows the UBL sequence for the document header', () => {
    const xml = build();
    const order = [
      'cbc:UBLVersionID', 'cbc:CustomizationID', 'cbc:ProfileID', 'cbc:ID',
      'cbc:IssueDate', 'cbc:DueDate', 'cbc:InvoiceTypeCode', 'cbc:DocumentCurrencyCode',
      'cac:AccountingSupplierParty', 'cac:AccountingCustomerParty',
      'cac:TaxTotal', 'cac:LegalMonetaryTotal', 'cac:InvoiceLine',
    ];
    const positions = order.map((tag) => at(xml, tag));
    expect(positions.every((p) => p >= 0), `missing: ${order.filter((t) => at(xml, t) < 0)}`).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('orders monetary total children as UBL requires', () => {
    const xml = build({ allowanceTotalAmount: '5.000' });
    const totals = xml.slice(at(xml, 'cac:LegalMonetaryTotal'));
    const order = ['cbc:LineExtensionAmount', 'cbc:TaxExclusiveAmount', 'cbc:TaxInclusiveAmount',
      'cbc:AllowanceTotalAmount', 'cbc:PayableAmount'];
    const positions = order.map((tag) => totals.indexOf(`<${tag}`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('omits an optional element entirely rather than emitting it empty', () => {
    const xml = build({ dueDate: null, allowanceTotalAmount: null, note: null });
    expect(xml).not.toContain('cbc:DueDate');
    expect(xml).not.toContain('cbc:AllowanceTotalAmount');
    expect(xml).not.toContain('cbc:Note');
  });
});

describe('money', () => {
  it('carries currencyID on every monetary amount', () => {
    const xml = build();
    const amounts = xml.match(/<cbc:\w*Amount[^>]*>/g) ?? [];
    expect(amounts.length).toBeGreaterThan(0);
    expect(amounts.filter((tag) => !tag.includes('currencyID='))).toEqual([]);
  });

  it('writes the decimal string it was given, unrounded', () => {
    // Passing these through a float is how a document ends up one minor unit
    // away from the sum of its own lines.
    const xml = build({ payableAmount: '232.000' });
    expect(xml).toContain('>232.000<');
    expect(xml).not.toContain('>232<');
  });
});

describe('escaping', () => {
  it('escapes the five XML entities', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('escapes a customer name containing an ampersand', () => {
    // Ordinary, not adversarial — and it produces an unparseable document.
    const xml = build({ customer: { name: 'Smith & Sons Ltd' } });
    expect(xml).toContain('Smith &amp; Sons Ltd');
    expect(xml).not.toContain('Smith & Sons');
  });

  it('escapes attribute values too', () => {
    const xml = buildInvoiceXml(input(), { ...PLACEHOLDER_PROFILE, invoiceTypeCodeName: 'a"b' });
    expect(xml).toContain('name="a&quot;b"');
  });
});

describe('what the profile controls', () => {
  it('takes every national code from the profile, not from this builder', () => {
    const xml = buildInvoiceXml(input(), {
      ...PLACEHOLDER_PROFILE,
      customizationId: 'CUSTOM-X', profileId: 'PROFILE-Y',
      taxSchemeId: 'GST', standardTaxCategoryId: 'Q',
    });
    expect(xml).toContain('<cbc:CustomizationID>CUSTOM-X</cbc:CustomizationID>');
    expect(xml).toContain('<cbc:ProfileID>PROFILE-Y</cbc:ProfileID>');
    expect(xml).toContain('<cbc:ID>GST</cbc:ID>');
    expect(xml).toContain('<cbc:ID>Q</cbc:ID>');
  });

  it('uses the zero-rated category when the rate is zero', () => {
    const zero = build({
      lines: [{ ...input().lines[0]!, taxPercent: '0', taxAmount: '0.000' }],
      taxAmount: '0.000',
    });
    expect(zero).toContain(`<cbc:ID>${PLACEHOLDER_PROFILE.zeroTaxCategoryId}</cbc:ID>`);
  });
});

describe('the guard against shipping placeholder values', () => {
  it('refuses to submit an unverified profile', () => {
    // The placeholder builds fine — that is what it is for — but it must never
    // reach an authority. A plausible wrong value survives review; this does not.
    expect(() => assertSubmittable(PLACEHOLDER_PROFILE)).toThrow(UnverifiedProfileError);
  });

  it('allows a profile that has been checked against a specification', () => {
    expect(() => assertSubmittable({ ...PLACEHOLDER_PROFILE, verified: true })).not.toThrow();
  });

  it('says in the error why the document would be wrong', () => {
    expect(() => assertSubmittable(PLACEHOLDER_PROFILE))
      .toThrow(/not been checked against a tax authority specification/i);
  });
});

describe('bilingual documents', () => {
  const bilingual = (over: Partial<UblInvoiceInput> = {}) =>
    buildInvoiceXml(input({
      primaryLanguage: 'en',
      secondaryLanguage: 'ar',
      lines: [{ ...input().lines[0]!, itemName: 'Consulting', itemNameAlt: 'استشارات' }],
      ...over,
    }), PLACEHOLDER_PROFILE);

  it('carries both item names, each tagged with its language', () => {
    const xml = bilingual();
    // UBL permits repeated cbc:Name distinguished by languageID.
    expect(xml).toContain('<cbc:Name languageID="en">Consulting</cbc:Name>');
    expect(xml).toContain('<cbc:Name languageID="ar">استشارات</cbc:Name>');
  });

  it('carries both notes when both are supplied', () => {
    const xml = bilingual({ note: 'Thank you', noteAlt: 'شكرًا لكم' });
    expect(xml).toContain('<cbc:Note languageID="en">Thank you</cbc:Note>');
    expect(xml).toContain('<cbc:Note languageID="ar">شكرًا لكم</cbc:Note>');
  });

  it('omits languageID entirely when there is only one name', () => {
    const xml = buildInvoiceXml(input(), PLACEHOLDER_PROFILE);
    /*
     * Tagging a lone name is legal UBL but adds an attribute a national profile
     * may not expect, and there is nothing to disambiguate it from.
     */
    expect(xml).toContain('<cbc:Name>Consulting</cbc:Name>');
    expect(xml).not.toContain('languageID');
  });

  it('ignores an alternate name when no secondary language is declared', () => {
    const xml = buildInvoiceXml(input({
      lines: [{ ...input().lines[0]!, itemNameAlt: 'استشارات' }],
    }), PLACEHOLDER_PROFILE);
    // Emitting an untagged duplicate would give the document two names with no
    // way to tell which is which.
    expect(xml).not.toContain('استشارات');
  });

  it('escapes Arabic text like any other, and keeps the dates Gregorian', () => {
    const xml = bilingual({ noteAlt: 'شركة "الأمل" & شركاه', note: 'n' });
    expect(xml).toContain('&quot;الأمل&quot;');
    expect(xml).toContain('&amp;');
    /*
     * cbc:IssueDate is xsd:date — proleptic Gregorian. A Hijri date here would
     * be schema-invalid and its tax period unrecoverable, so the bilingual path
     * must not touch it.
     */
    expect(xml).toContain('<cbc:IssueDate>2026-03-01</cbc:IssueDate>');
  });
});
