/**
 * Ledgora Master Terms and Conditions — English, DRAFT pending counsel review.
 *
 * Applies to every customer in every country Ledgora is offered in. A Country
 * Addendum supplements these Terms and PREVAILS over them where mandatory local
 * law requires it (clause 1.3).
 *
 * ── What this text deliberately does not say ─────────────────────────────────
 * It does not name Experts Group FZE's free zone, licence number, registered
 * address, governing Emirate or competent court; it does not state where data
 * is hosted; and it does not claim any tax-authority integration. Every one of
 * those is an `unresolved` block, because inventing them would produce a
 * contract that is wrong in exactly the places a dispute would turn on.
 */
import type { LegalDocument } from './types';

export const MASTER_TERMS: LegalDocument = {
  id: 'master-terms',
  title: 'Ledgora Master Terms and Conditions',
  version: '0.1.0-draft',
  effectiveDate: 'not-yet-effective',
  language: 'en',
  counselApproved: false,
  publicationApproved: false,
  reviewRequired:
    'Review and approval by UAE counsel for Experts Group FZE, with input from Jordanian and Saudi counsel on the interaction between these Terms and each Country Addendum.',
  sections: [
    {
      number: '1',
      heading: 'These Terms, and how the Country Addendum works with them',
      blocks: [
        {
          kind: 'paragraph',
          text: 'These Master Terms and Conditions govern the supply of the Ledgora accounting software service ("Ledgora", "the Service") by Experts Group FZE ("we", "us", the "Provider") to the organization that accepts them ("you", the "Customer").',
        },
        {
          kind: 'paragraph',
          text: 'Ledgora is currently offered to organizations registered in the United Arab Emirates, the Hashemite Kingdom of Jordan and the Kingdom of Saudi Arabia. A separate Country Addendum applies to each. The Country Addendum that applies to you is determined by the country in which your organization is legally registered, which you select and confirm yourself — see clause 3.',
        },
        {
          kind: 'paragraph',
          text: 'The applicable Country Addendum forms part of your agreement with us and supplements these Master Terms. Where a term of the applicable Country Addendum conflicts with these Master Terms, the Country Addendum prevails to the extent of the conflict.',
        },
        {
          kind: 'paragraph',
          text: 'Nothing in these Terms or in any Country Addendum removes, limits or waives any right or protection that the law of your country gives you and that cannot lawfully be excluded or limited by agreement. Where any provision of these Terms would have that effect, that provision does not apply to you to the extent of the inconsistency, and the remainder of these Terms continues to apply. This clause prevails over any other provision of these Terms, including any governing-law or jurisdiction clause.',
        },
      ],
    },
    {
      number: '2',
      heading: 'The Provider',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The Service is provided by Experts Group FZE, a free zone establishment incorporated in the United Arab Emirates.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — Experts Group FZE identity block. The free zone authority, trade licence number, registered address and the Emirate of registration must be confirmed from the company\'s licence and inserted here before publication. They are deliberately not stated, because a contracting party must be identified from its licence and not from an assumption.',
        },
      ],
    },
    {
      number: '3',
      heading: 'Your organization\'s legal country',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Your organization\'s legal country is the country in which your organization is legally registered. It determines which Country Addendum applies to you.',
        },
        {
          kind: 'paragraph',
          text: 'You select and confirm your organization\'s legal country yourself. We do not infer it from your internet address, your device\'s location, your language settings or your billing currency, and a change in any of those does not change the Country Addendum that applies to you.',
        },
        {
          kind: 'paragraph',
          text: 'You are responsible for selecting your organization\'s legal country correctly and for telling us if it changes. After your subscription is activated, the legal country can only be changed through our organization-administration process. A change of legal country changes the applicable Country Addendum, and we will ask an authorised person in your organization to review and accept the new Country Addendum before the change takes effect.',
        },
        {
          kind: 'paragraph',
          text: 'A change of legal country does not alter, restate or re-file any accounting record, tax configuration or document you have already created. Those remain exactly as they were, and any consequences of the change for your tax position are for you and your advisers to determine.',
        },
      ],
    },
    {
      number: '4',
      heading: 'Acceptance of these Terms',
      blocks: [
        {
          kind: 'paragraph',
          text: 'To use the Service, a person with authority to bind your organization must accept these Master Terms and the applicable Country Addendum. By accepting, that person confirms that they have that authority.',
        },
        {
          kind: 'paragraph',
          text: 'We record which version of the Master Terms and which version of which Country Addendum was presented and accepted, by whom, for which organization, and when. We record a fingerprint of the exact text shown, so that what was agreed can be established later.',
        },
        {
          kind: 'paragraph',
          text: 'If we publish a new version of the Master Terms, or make a material change to the Country Addendum that applies to you, we will ask you to review and accept the new version. Until that acceptance is given, the version you last accepted continues to govern your use of the Service, except where the law requires otherwise.',
        },
      ],
    },
    {
      number: '5',
      heading: 'What Ledgora is, and what it is not',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Ledgora is bookkeeping and accounting software. We supply software; we do not provide accounting, audit, tax, legal or financial advice, and nothing produced by the Service is such advice.',
        },
        {
          kind: 'paragraph',
          text: 'You remain responsible for your own books and records, for the accuracy and completeness of everything you enter, for your tax filings and returns, and for compliance with the accounting, tax, invoicing and record-keeping laws that apply to you. The Service assists you in keeping records; it does not discharge any obligation the law places on you.',
        },
        {
          kind: 'paragraph',
          text: 'We do not file, submit or transmit anything to any tax authority on your behalf unless a specific integration is described in the applicable Country Addendum as being available and in operation.',
        },
      ],
    },
    {
      number: '6',
      heading: 'Where your data is held, and how it is processed',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Ledgora holds different categories of data in different places, and the distinction matters to you.',
        },
        {
          kind: 'paragraph',
          text: 'Your accounting records — your chart of accounts, journal entries, invoices, bills, credit notes, supplier debit notes, payments, receipts, inventory and the documents built from them — are held in the storage of the web browser you use, on your own device. They are not transmitted to or stored on our servers. This has consequences you should understand: clearing your browser data, using a different browser or device, or a device failure will make those records unavailable, and we cannot recover them for you because we do not hold them. You are responsible for exporting and retaining your own records as your law requires.',
        },
        {
          kind: 'paragraph',
          text: 'Platform data — your account and sign-in credentials, your organization record, membership and roles, subscription and package information, payment references and evidence you upload, invitations, and our audit logs of account and administrative actions — is held on servers we operate through our hosting provider.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — hosting and data location. The hosting region for the application servers and the database, and the location of any backups, must be confirmed and stated here before publication. It must not be assumed to be the United Arab Emirates. This affects the cross-border transfer analysis under Jordanian and Saudi data-protection law, and must be settled with counsel before customers are accepted in those countries.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — subprocessors. The complete list of third parties that process platform data on our behalf — hosting and database, transactional email, and any font, analytics or error-reporting service that receives visitor data — must be confirmed and disclosed, in these Terms or in a linked subprocessor list, before publication.',
        },
        {
          kind: 'paragraph',
          text: 'These Terms do not replace our Privacy Policy, cookie notice or any data-processing agreement. Where the law that applies to you requires a separate data-processing agreement, transfer safeguards, an impact assessment, a notice or a registration, acceptance of these Terms alone does not satisfy that requirement.',
        },
      ],
    },
    {
      number: '7',
      heading: 'Your account and your people',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You are responsible for the people to whom you give access to your organization in Ledgora, for the roles and permissions you grant them, and for everything done under those accounts. You must keep credentials confidential and tell us promptly if you believe an account has been compromised.',
        },
        {
          kind: 'paragraph',
          text: 'Some actions in Ledgora change your accounting records in ways that are recorded permanently — including amending a posted document, which reverses the original posting and creates a corrected replacement while preserving the original. You decide which of your people may perform those actions.',
        },
      ],
    },
    {
      number: '8',
      heading: 'Subscription, fees and payment',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Access to the Service depends on an active subscription to a package. The package you hold determines the features and limits available to you.',
        },
        {
          kind: 'paragraph',
          text: 'Fees, billing period, payment method, renewal and any applicable taxes are as stated at the point of purchase and in the applicable Country Addendum. Where a Country Addendum states a tax treatment for your country, that treatment applies.',
        },
        {
          kind: 'paragraph',
          text: 'If a subscription lapses, is suspended or is cancelled, we do not delete your data merely because of that. Access to create new postings may be suspended while the subscription is not in good standing; your existing records remain available for reading and export, subject to the browser-storage limitation described in clause 6.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — fees, billing cycle, refund and cancellation terms, and any statutory cooling-off or withdrawal right. These must be settled commercially and confirmed against each country\'s consumer and e-commerce rules before publication.',
        },
      ],
    },
    {
      number: '9',
      heading: 'Availability, support and changes to the Service',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We aim to keep the Service available and to correct faults within a reasonable time, but we do not warrant that it will be uninterrupted or error-free. We may change, add to or withdraw features. Where a change materially reduces the functionality you are paying for, we will tell you in advance.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — whether any service level, uptime commitment or support response time is offered. None is stated here, because a commitment that is not measured and honoured is worse than none.',
        },
      ],
    },
    {
      number: '10',
      heading: 'Our staff and your records',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Our platform administrators operate the Ledgora service. They do not have access to your accounting records through their platform role, and platform status alone does not authorise anyone to enter your organization\'s books or to change your accounting records.',
        },
        {
          kind: 'paragraph',
          text: 'Where you ask us for support that requires access to your organization, that access requires your authorisation through a mechanism we make available for the purpose, and it is recorded.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — support access. A customer-authorised support-access mechanism is not yet implemented. Until it exists, this clause must either describe the true position (no such access is available) or be withheld. It must not describe a control that does not exist.',
        },
      ],
    },
    {
      number: '11',
      heading: 'Intellectual property',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We own the Ledgora software and all intellectual property in it. You are granted a non-exclusive, non-transferable right to use it for your own business during your subscription. You own your own data and the records you create.',
        },
      ],
    },
    {
      number: '12',
      heading: 'Liability',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Nothing in these Terms limits or excludes liability that cannot lawfully be limited or excluded, including liability for death or personal injury caused by negligence and for fraud or fraudulent misrepresentation.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — liability cap and exclusions. The figure, the categories of excluded loss, and their enforceability must be settled with counsel in each of the three countries. A cap that is void under local consumer or civil law is worse than no cap, because it invites a dispute about the whole clause.',
        },
      ],
    },
    {
      number: '13',
      heading: 'Term, suspension and termination',
      blocks: [
        {
          kind: 'paragraph',
          text: 'These Terms apply for as long as you use the Service. Either of us may end the agreement in accordance with the cancellation terms applying to your subscription. We may suspend access where required by law, where a subscription is not in good standing, or where continued use presents a security or integrity risk, and we will tell you why.',
        },
        {
          kind: 'paragraph',
          text: 'On termination you should export your records. Because your accounting records are held in your own browser, ending your subscription does not by itself delete them, and we cannot retrieve them for you.',
        },
      ],
    },
    {
      number: '14',
      heading: 'Governing law and disputes',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The governing law and the forum for disputes are stated in the Country Addendum that applies to your organization.',
        },
        {
          kind: 'paragraph',
          text: 'Whatever governing law applies, it does not deprive you of the protection of any mandatory rule of the law of your own country that would apply regardless of the parties\' choice, and it does not prevent you from bringing proceedings where the law of your country entitles you to do so. Clause 1.4 applies to this clause.',
        },
      ],
    },
    {
      number: '15',
      heading: 'General',
      blocks: [
        {
          kind: 'paragraph',
          text: 'If any provision is found unenforceable, the rest continues to apply. Our failure to enforce a term is not a waiver of it. You may not transfer your rights under these Terms without our consent. These Terms, together with the applicable Country Addendum and the documents referred to in them, are the whole agreement between us about the Service.',
        },
        {
          kind: 'paragraph',
          text: 'These Terms and each Country Addendum are published in English. Where an Arabic version is published, the relationship between the two language versions is stated in the applicable Country Addendum.',
        },
      ],
    },
  ],
};
