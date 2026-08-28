/**
 * UAE Country Addendum — English, DRAFT pending UAE counsel review.
 *
 * Supplements the Master Terms for organizations registered in the United Arab
 * Emirates, and prevails over them where UAE mandatory law requires it.
 *
 * Every statutory citation below is stated from the published federal
 * legislation and must still be verified by counsel against the version in
 * force on the date of publication, including any implementing regulation or
 * amendment. Nothing here states the free zone, Emirate or court — those come
 * from Experts Group FZE's licence, which has not been provided.
 */
import type { LegalDocument } from './types';

export const UAE_ADDENDUM: LegalDocument = {
  id: 'addendum-ae',
  country: 'AE',
  title: 'Ledgora Country Addendum — United Arab Emirates',
  version: '0.1.0-draft',
  effectiveDate: 'not-yet-effective',
  language: 'en',
  counselApproved: false,
  publicationApproved: false,
  reviewRequired:
    'Review and approval by UAE-qualified counsel, including confirmation of Experts Group FZE\'s free zone, trade licence, registered address, governing Emirate and competent court, and of whether the free zone\'s own dispute forum applies.',
  sections: [
    {
      number: 'AE-1',
      heading: 'Application',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This Addendum applies where your organization\'s legal country is the United Arab Emirates. It supplements the Ledgora Master Terms and Conditions and prevails over them to the extent of any conflict.',
        },
        {
          kind: 'paragraph',
          text: 'Nothing in this Addendum or in the Master Terms removes or limits any right given to you by UAE law that cannot be excluded by agreement.',
        },
      ],
    },
    {
      number: 'AE-2',
      heading: 'The Provider and its licensing',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The Service is provided by Experts Group FZE, a free zone establishment incorporated in the United Arab Emirates.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — free zone authority, trade licence number, licence expiry, registered address and Emirate of registration. These must be taken from the current trade licence and inserted before publication.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — free zone implications. Whether the free zone of incorporation permits Experts Group FZE to contract with and invoice customers established in mainland UAE, and on what conditions, must be confirmed. A free zone entity\'s permitted activities and territorial scope are set by its licence and its free zone regulations, and they determine whether mainland UAE customers can be served directly or require a mainland arrangement.',
        },
      ],
    },
    {
      number: 'AE-3',
      heading: 'Electronic contracting and electronic acceptance',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You and we agree to contract electronically. Accepting the Master Terms and this Addendum through the Ledgora interface creates a binding agreement, and neither of us will dispute the validity or enforceability of the agreement, of any electronic record, or of any electronic signature or acceptance, on the ground that it is in electronic form.',
        },
        {
          kind: 'paragraph',
          text: 'This reflects the UAE framework for electronic transactions and trust services, under Federal Decree-Law No. 46 of 2021 on Electronic Transactions and Trust Services, which gives legal effect to electronic records and signatures.',
        },
        {
          kind: 'paragraph',
          text: 'We keep a record of the version of each document presented to you, a fingerprint of the exact text shown, the identity of the person who accepted, the organization they accepted for, and the time of acceptance recorded on our servers.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — whether any category of the agreement requires a qualified or authenticated electronic signature rather than click-acceptance, and whether any retention format or period is prescribed for electronic records.',
        },
      ],
    },
    {
      number: 'AE-4',
      heading: 'Consumer protection',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Ledgora is supplied for business use by registered organizations. Where UAE consumer-protection law nonetheless applies to your acquisition of the Service, that law applies in addition to this agreement, and this agreement does not limit it.',
        },
        {
          kind: 'paragraph',
          text: 'The UAE consumer-protection framework is set out in Federal Law No. 15 of 2020 on Consumer Protection and its implementing regulation.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — whether a business subscriber to a software service falls within the UAE consumer-protection regime, and if so which disclosure, pricing-transparency, cancellation and remedy obligations attach. This determines the fees, refund and cancellation terms in Master Terms clause 8.',
        },
      ],
    },
    {
      number: 'AE-5',
      heading: 'Personal data',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Where we process personal data relating to you, your staff or your contacts, we do so in accordance with applicable UAE personal-data law, including Federal Decree-Law No. 45 of 2021 on the Protection of Personal Data, and with our Privacy Policy.',
        },
        {
          kind: 'paragraph',
          text: 'Your accounting records are held in your own browser, not on our servers (Master Terms clause 6). Any personal data you record inside those accounting records — customer and supplier contact details, for example — is therefore not transmitted to or held by us, and we are not in a position to access, export, correct or delete it on your behalf.',
        },
        {
          kind: 'paragraph',
          text: 'For platform data that we do hold, we act as controller in respect of your account and subscription relationship, and where we process personal data on your instructions we do so as processor under a separate data-processing agreement.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — controller/processor characterisation, the lawful basis for each processing purpose, cross-border transfer basis, the data-processing agreement, the subprocessor list, retention periods, and whether any free zone data-protection regime (rather than or in addition to the federal law) applies to Experts Group FZE. A data-processing agreement is not yet in place and is required before customers are accepted.',
        },
      ],
    },
    {
      number: 'AE-6',
      heading: 'VAT, invoicing and record keeping',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You are responsible for your own VAT position, for issuing valid tax invoices to your own customers, for your returns and filings, and for keeping the records UAE law requires you to keep, for the period it requires.',
        },
        {
          kind: 'paragraph',
          text: 'The UAE VAT framework is set out in Federal Decree-Law No. 8 of 2017 on Value Added Tax and its Executive Regulation.',
        },
        {
          kind: 'paragraph',
          text: 'Ledgora records the tax treatment you configure and enter. It does not determine your VAT liability, does not verify your tax configuration, and does not submit returns or invoices to the Federal Tax Authority on your behalf.',
        },
        {
          kind: 'paragraph',
          text: 'Because your accounting records are held in your own browser, satisfying UAE record-retention requirements is your responsibility, and you should export and retain your records independently of the Service.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — the VAT treatment of the subscription fee charged by a free zone establishment to UAE mainland, other-free-zone, and non-UAE customers, and Experts Group FZE\'s own registration and invoicing obligations. This must be confirmed before pricing is published.',
        },
      ],
    },
    {
      number: 'AE-7',
      heading: 'Governing law and jurisdiction',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This agreement is governed by the federal law of the United Arab Emirates and the law of the Emirate stated below.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — governing Emirate and competent court. These follow from Experts Group FZE\'s free zone and registered address and must not be assumed. The choice is materially different depending on the free zone: some free zones have their own courts and dispute-resolution rules, and others fall to the onshore courts of their Emirate.',
        },
        {
          kind: 'paragraph',
          text: 'Whatever forum is agreed, it does not deprive you of any mandatory protection of UAE law, and it does not prevent you from bringing proceedings where UAE law entitles you to do so.',
        },
      ],
    },
    {
      number: 'AE-8',
      heading: 'Language',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This Addendum and the Master Terms are published in English.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — Arabic version. Whether an Arabic version is required for enforceability or for filing, and which language governs in the event of a discrepancy, must be confirmed. UAE courts conduct proceedings in Arabic and may require a certified translation. Any Arabic version must be prepared or approved by counsel; a machine translation must not be published as a legal version.',
        },
      ],
    },
  ],
};
