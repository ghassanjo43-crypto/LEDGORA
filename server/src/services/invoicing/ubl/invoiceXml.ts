/**
 * A UBL 2.1 Invoice document, built from a Ledgora invoice.
 *
 * ── What is standard here, and what is not ───────────────────────────────────
 * The element names, namespaces and SEQUENCE below are OASIS UBL 2.1. UBL's
 * schema uses xsd:sequence, not xsd:all: an Invoice whose DueDate precedes its
 * IssueDate is invalid however correct the values are. That ordering is the
 * single most common thing hand-rolled builders get wrong, it is published, and
 * it does not vary by country — which is why building this before the JoFotara
 * specification arrives is worth doing rather than guessing.
 *
 * Every value that DOES vary by country comes from `UblProfile`. There are no
 * national code literals in this file. If one appears here in a later change,
 * it is in the wrong place.
 *
 * ── Money ────────────────────────────────────────────────────────────────────
 * Amounts arrive as decimal strings from PostgreSQL NUMERIC and are written out
 * as decimal strings. They are never parsed into a float on the way through.
 * A tax authority reconciles totals to the minor unit, and a document whose
 * PayableAmount is 0.01 away from the sum of its lines is a rejected document.
 *
 * ── What this does NOT do ────────────────────────────────────────────────────
 * No digital signature, no hashing, no QR code, no submission. Those are
 * authority-specific in both algorithm and placement, and every one of them is
 * a thing that must be right rather than plausible. They arrive with the spec.
 */
import type { UblProfile } from './ublProfile.js';

export interface UblParty {
  name: string;
  /** Tax or commercial registration number, quoted under the profile's scheme. */
  taxNumber?: string | null;
  street?: string | null;
  city?: string | null;
  postalZone?: string | null;
  /** ISO 3166-1 alpha-2. */
  countryCode?: string | null;
}

export interface UblInvoiceLine {
  id: string;
  quantity: string;
  unitCode: string;
  /** Line net of tax. */
  lineExtensionAmount: string;
  unitPrice: string;
  taxAmount: string;
  /** Percentage, e.g. "16.00". */
  taxPercent: string;
  itemName: string;
}

export interface UblInvoiceInput {
  invoiceNumber: string;
  issueDate: string;
  dueDate?: string | null;
  currencyCode: string;
  note?: string | null;

  supplier: UblParty;
  customer: UblParty;

  lines: UblInvoiceLine[];

  /** Sum of line extension amounts — net of tax. */
  lineExtensionAmount: string;
  taxExclusiveAmount: string;
  taxInclusiveAmount: string;
  allowanceTotalAmount?: string | null;
  payableAmount: string;
  taxAmount: string;
}

/**
 * XML text escaping.
 *
 * Applied to every interpolated value without exception. A customer legal name
 * containing `&` is ordinary, not adversarial, and it produces a document that
 * fails to parse — which at clearance time looks like an outage rather than a
 * data problem.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const indent = (depth: number): string => '  '.repeat(depth);

function element(depth: number, tag: string, value: string, attributes: Record<string, string> = {}): string {
  const attrs = Object.entries(attributes)
    .filter(([, attributeValue]) => attributeValue !== '')
    .map(([key, attributeValue]) => ` ${key}="${escapeXml(attributeValue)}"`)
    .join('');
  return `${indent(depth)}<${tag}${attrs}>${escapeXml(value)}</${tag}>`;
}

/** An amount element. UBL requires currencyID on every monetary amount. */
const amount = (depth: number, tag: string, value: string, currency: string): string =>
  element(depth, tag, value, { currencyID: currency });

function partyXml(depth: number, tag: string, party: UblParty, scheme: string): string[] {
  const lines = [`${indent(depth)}<${tag}>`, `${indent(depth + 1)}<cac:Party>`];

  if (party.taxNumber) {
    lines.push(
      `${indent(depth + 2)}<cac:PartyIdentification>`,
      element(depth + 3, 'cbc:ID', party.taxNumber, { schemeID: scheme }),
      `${indent(depth + 2)}</cac:PartyIdentification>`,
    );
  }

  // PostalAddress precedes PartyTaxScheme, which precedes PartyLegalEntity.
  if (party.street || party.city || party.postalZone || party.countryCode) {
    lines.push(`${indent(depth + 2)}<cac:PostalAddress>`);
    if (party.street) lines.push(element(depth + 3, 'cbc:StreetName', party.street));
    if (party.city) lines.push(element(depth + 3, 'cbc:CityName', party.city));
    if (party.postalZone) lines.push(element(depth + 3, 'cbc:PostalZone', party.postalZone));
    if (party.countryCode) {
      lines.push(
        `${indent(depth + 3)}<cac:Country>`,
        element(depth + 4, 'cbc:IdentificationCode', party.countryCode),
        `${indent(depth + 3)}</cac:Country>`,
      );
    }
    lines.push(`${indent(depth + 2)}</cac:PostalAddress>`);
  }

  lines.push(
    `${indent(depth + 2)}<cac:PartyLegalEntity>`,
    element(depth + 3, 'cbc:RegistrationName', party.name),
    `${indent(depth + 2)}</cac:PartyLegalEntity>`,
    `${indent(depth + 1)}</cac:Party>`,
    `${indent(depth)}</${tag}>`,
  );
  return lines;
}

function taxTotalXml(
  depth: number,
  taxAmountValue: string,
  taxableAmount: string,
  percent: string,
  currency: string,
  profile: UblProfile,
): string[] {
  const zeroRated = Number(percent) === 0;
  return [
    `${indent(depth)}<cac:TaxTotal>`,
    amount(depth + 1, 'cbc:TaxAmount', taxAmountValue, currency),
    `${indent(depth + 1)}<cac:TaxSubtotal>`,
    amount(depth + 2, 'cbc:TaxableAmount', taxableAmount, currency),
    amount(depth + 2, 'cbc:TaxAmount', taxAmountValue, currency),
    `${indent(depth + 2)}<cac:TaxCategory>`,
    element(depth + 3, 'cbc:ID', zeroRated ? profile.zeroTaxCategoryId : profile.standardTaxCategoryId),
    element(depth + 3, 'cbc:Percent', percent),
    `${indent(depth + 3)}<cac:TaxScheme>`,
    element(depth + 4, 'cbc:ID', profile.taxSchemeId),
    `${indent(depth + 3)}</cac:TaxScheme>`,
    `${indent(depth + 2)}</cac:TaxCategory>`,
    `${indent(depth + 1)}</cac:TaxSubtotal>`,
    `${indent(depth)}</cac:TaxTotal>`,
  ];
}

function invoiceLineXml(depth: number, line: UblInvoiceLine, currency: string, profile: UblProfile): string[] {
  return [
    `${indent(depth)}<cac:InvoiceLine>`,
    element(depth + 1, 'cbc:ID', line.id),
    element(depth + 1, 'cbc:InvoicedQuantity', line.quantity, { unitCode: line.unitCode }),
    amount(depth + 1, 'cbc:LineExtensionAmount', line.lineExtensionAmount, currency),
    ...taxTotalXml(depth + 1, line.taxAmount, line.lineExtensionAmount, line.taxPercent, currency, profile),
    `${indent(depth + 1)}<cac:Item>`,
    element(depth + 2, 'cbc:Name', line.itemName),
    `${indent(depth + 1)}</cac:Item>`,
    `${indent(depth + 1)}<cac:Price>`,
    amount(depth + 2, 'cbc:PriceAmount', line.unitPrice, currency),
    `${indent(depth + 1)}</cac:Price>`,
    `${indent(depth)}</cac:InvoiceLine>`,
  ];
}

const NS = [
  'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
  'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
  'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
];

/**
 * Build the document.
 *
 * Pure: no clock, no database, no network. The same invoice and profile always
 * produce the same bytes, which is what makes the output diffable against a
 * reference document once a real specification exists — and what will make it
 * hashable when signing arrives.
 */
export function buildInvoiceXml(input: UblInvoiceInput, profile: UblProfile): string {
  const currency = input.currencyCode;

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Invoice ${NS.join(' ')}>`,

    // ── Order below is UBL 2.1's sequence. Do not sort these alphabetically. ──
    element(1, 'cbc:UBLVersionID', profile.ublVersionId),
    element(1, 'cbc:CustomizationID', profile.customizationId),
    element(1, 'cbc:ProfileID', profile.profileId),
    element(1, 'cbc:ID', input.invoiceNumber),
    element(1, 'cbc:IssueDate', input.issueDate),
  ];

  if (input.dueDate) lines.push(element(1, 'cbc:DueDate', input.dueDate));

  lines.push(element(1, 'cbc:InvoiceTypeCode', profile.invoiceTypeCode, {
    ...(profile.invoiceTypeCodeName ? { name: profile.invoiceTypeCodeName } : {}),
  }));

  if (input.note) lines.push(element(1, 'cbc:Note', input.note));

  lines.push(
    element(1, 'cbc:DocumentCurrencyCode', currency),
    ...partyXml(1, 'cac:AccountingSupplierParty', input.supplier, profile.supplierIdentification.schemeId),
    ...partyXml(1, 'cac:AccountingCustomerParty', input.customer, profile.customerIdentification.schemeId),
  );

  /*
   * Document-level TaxTotal. The percent handed to it is the document's
   * effective rate, used only to choose a tax category; per-line rates are
   * authoritative and are written on each line.
   */
  const effectivePercent = input.lines.length > 0 ? input.lines[0]!.taxPercent : '0';
  lines.push(...taxTotalXml(1, input.taxAmount, input.taxExclusiveAmount, effectivePercent, currency, profile));

  lines.push(`${indent(1)}<cac:LegalMonetaryTotal>`);
  lines.push(amount(2, 'cbc:LineExtensionAmount', input.lineExtensionAmount, currency));
  lines.push(amount(2, 'cbc:TaxExclusiveAmount', input.taxExclusiveAmount, currency));
  lines.push(amount(2, 'cbc:TaxInclusiveAmount', input.taxInclusiveAmount, currency));
  if (input.allowanceTotalAmount) {
    lines.push(amount(2, 'cbc:AllowanceTotalAmount', input.allowanceTotalAmount, currency));
  }
  lines.push(amount(2, 'cbc:PayableAmount', input.payableAmount, currency));
  lines.push(`${indent(1)}</cac:LegalMonetaryTotal>`);

  input.lines.forEach((line) => lines.push(...invoiceLineXml(1, line, currency, profile)));

  lines.push('</Invoice>');
  return lines.join('\n');
}
