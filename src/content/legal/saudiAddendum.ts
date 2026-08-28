/**
 * Saudi Arabia Country Addendum — English, DRAFT pending Saudi counsel review.
 *
 * ── The ZATCA position, verified in this codebase ────────────────────────────
 * There is NO ZATCA or Fatoora code anywhere in the repository — not a mock,
 * not a stub, not a configuration flag. This Addendum therefore states that
 * Ledgora provides no ZATCA e-invoicing capability at all, and makes no claim
 * of compliance, certification, clearance or integration. That must not change
 * until a production integration exists and has been verified end to end.
 *
 * This is the most restrictive of the three addenda for a reason: Saudi
 * e-invoicing is mandatory and phased, so a Saudi customer who assumed Ledgora
 * handled it would be exposed. The Addendum says so in terms.
 */
import type { LegalDocument } from './types';

export const SAUDI_ADDENDUM: LegalDocument = {
  id: 'addendum-sa',
  country: 'SA',
  title: 'Ledgora Country Addendum — Kingdom of Saudi Arabia',
  version: '0.1.0-draft',
  effectiveDate: 'not-yet-effective',
  language: 'en',
  counselApproved: false,
  publicationApproved: false,
  reviewRequired:
    'Review and approval by Saudi-qualified counsel, including the PDPL cross-border transfer basis, the Arabic-language requirement, and confirmation that offering the Service without ZATCA e-invoicing capability is acceptable for the intended customer segment.',
  sections: [
    {
      number: 'SA-1',
      heading: 'Application',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This Addendum applies where your organization\'s legal country is the Kingdom of Saudi Arabia. It supplements the Ledgora Master Terms and Conditions and prevails over them to the extent of any conflict.',
        },
        {
          kind: 'paragraph',
          text: 'Nothing in this Addendum or in the Master Terms removes or limits any right given to you by the laws of the Kingdom that cannot be excluded by agreement, or displaces any rule of Saudi public order or Shari\'ah principle applied by the Saudi courts.',
        },
      ],
    },
    {
      number: 'SA-2',
      heading: 'Electronic contracting and electronic acceptance',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You and we agree to contract electronically. Accepting the Master Terms and this Addendum through the Ledgora interface creates a binding agreement, and neither of us will dispute its validity on the ground that it is in electronic form.',
        },
        {
          kind: 'paragraph',
          text: 'This reflects the Saudi Electronic Transactions Law, which gives legal effect to electronic records, contracts and signatures.',
        },
        {
          kind: 'paragraph',
          text: 'We record the version of each document presented, a fingerprint of the exact text shown, who accepted, for which organization, and the server time of acceptance.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — whether click-acceptance is evidentially sufficient before the Saudi courts for an agreement of this kind, or whether a certified electronic signature is advisable.',
        },
      ],
    },
    {
      number: 'SA-3',
      heading: 'E-commerce and consumer rights',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Ledgora is supplied for business use by registered organizations. Where the Saudi E-Commerce Law or Saudi consumer-protection rules apply to your acquisition of the Service, they apply in addition to this agreement and are not limited by it.',
        },
        {
          kind: 'paragraph',
          text: 'The Saudi E-Commerce Law imposes disclosure obligations on a service provider contracting electronically, including identification of the provider and clear presentation of terms, price and the contracting process.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — whether the E-Commerce Law\'s consumer provisions reach a business subscriber; the specific disclosures required of a non-resident provider; and any right of withdrawal, refund or cancellation that must be offered. These determine Master Terms clause 8.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — whether a non-resident provider must register with any Saudi authority, or appoint a local representative, to offer the Service to Saudi customers.',
        },
      ],
    },
    {
      number: 'SA-4',
      heading: 'Personal data and cross-border transfer',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Where we process personal data relating to you, your staff or your contacts, we do so in accordance with the Saudi Personal Data Protection Law and its Implementing Regulations, and with our Privacy Policy.',
        },
        {
          kind: 'paragraph',
          text: 'Your accounting records are held in your own browser and are not transmitted to or held on our servers (Master Terms clause 6). Personal data you record inside those records stays on your device, and we cannot access, export or delete it for you.',
        },
        {
          kind: 'paragraph',
          text: 'Platform data — your account, organization, membership, subscription and payment records, and our audit logs — is held on servers operated through our hosting provider, and is processed outside the Kingdom.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — cross-border transfer, and the most significant open item in this Addendum. The PDPL and its Implementing Regulations restrict transfer of personal data outside the Kingdom and condition it on defined bases and safeguards, which may include a risk assessment and, in some cases, regulatory engagement. The hosting location must be confirmed, the transfer basis identified, and the required assessment and safeguards completed BEFORE Saudi customers are accepted. Acceptance of these Terms does not by itself satisfy that requirement.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — controller/processor characterisation, lawful basis, the data-processing agreement, subprocessor disclosure, retention, data-subject rights handling, breach-notification timing, and whether registration on the national data controller register is required. None is in place.',
        },
      ],
    },
    {
      number: 'SA-5',
      heading: 'VAT, ZATCA e-invoicing and record keeping',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You are responsible for your own VAT position, for issuing valid tax invoices to your own customers, for your returns and filings, and for keeping the records Saudi law requires, for the period it requires.',
        },
        {
          kind: 'paragraph',
          text: 'Ledgora provides NO ZATCA e-invoicing capability. It does not generate ZATCA-compliant invoices, does not apply cryptographic stamps, UUIDs or QR codes to the standard ZATCA specification, does not integrate with the Fatoora platform, and does not report or clear any invoice with the Zakat, Tax and Customs Authority. We make no claim of ZATCA compliance or certification.',
        },
        {
          kind: 'paragraph',
          text: 'Saudi e-invoicing obligations are mandatory for taxpayers within their scope. If those obligations apply to you, you must meet them through a compliant solution. Using Ledgora does not discharge them, and invoices produced by Ledgora should not be treated as satisfying them.',
        },
        {
          kind: 'paragraph',
          text: 'Because your accounting records are held in your own browser, meeting Saudi record-retention requirements is your responsibility, and you should export and retain your records independently of the Service.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — commercial suitability. Whether Ledgora may properly be offered to Saudi taxpayers who are within the scope of mandatory e-invoicing, given that it provides no such capability, is a commercial and legal decision that must be taken before launch rather than left to the customer to discover.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — the VAT treatment of a subscription supplied to a Saudi customer by a UAE free zone establishment, including any reverse-charge or non-resident VAT registration obligation for Experts Group FZE.',
        },
      ],
    },
    {
      number: 'SA-6',
      heading: 'Governing law, jurisdiction and mandatory rights',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Master Terms clause 14 states the governing law. Whatever that clause provides, it does not deprive you of the protection of any mandatory rule of Saudi law that would apply regardless of the parties\' choice, and it does not prevent you from bringing proceedings before the Saudi courts where Saudi law entitles you to do so.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — forum and enforceability. Whether a foreign governing law and foreign forum are enforceable against a Saudi-registered customer, and how a Saudi court would treat them, must be confirmed. Saudi courts may decline to give effect to a foreign choice of law where it conflicts with Shari\'ah principles or Saudi public order, and certain provisions common in software terms — including some liability exclusions and interest provisions — may not be enforceable.',
        },
      ],
    },
    {
      number: 'SA-7',
      heading: 'Language',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This Addendum and the Master Terms are published in English.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — Arabic version. Proceedings before the Saudi courts are conducted in Arabic, and Saudi e-commerce and consumer rules may require terms to be presented in Arabic to a customer in the Kingdom. Whether an Arabic version must be shown at the point of acceptance, and which language governs on a discrepancy, must be confirmed. Any Arabic version must be counsel-approved or certified; a machine translation must not be published as a legal version.',
        },
      ],
    },
  ],
};
