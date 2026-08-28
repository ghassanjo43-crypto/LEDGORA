/**
 * Jordan Country Addendum — English, DRAFT pending Jordanian counsel review.
 *
 * ── The JOFOTARA position, verified in this codebase ─────────────────────────
 * There is NO operational JOFOTARA integration. The only JoFotara code in the
 * repository is a mock (`server/src/services/joFotara/mock.ts`), it is not
 * wired into any invoicing route, and `config/env.ts` refuses to enable it in
 * production because "a mocked CLEARED is indistinguishable from a real one
 * once stored". This Addendum therefore states plainly that Ledgora does not
 * submit anything to JOFOTARA. That sentence must not be softened or removed
 * until a production integration exists and has been verified end to end.
 */
import type { LegalDocument } from './types';

export const JORDAN_ADDENDUM: LegalDocument = {
  id: 'addendum-jo',
  country: 'JO',
  title: 'Ledgora Country Addendum — Hashemite Kingdom of Jordan',
  version: '0.1.0-draft',
  effectiveDate: 'not-yet-effective',
  language: 'en',
  counselApproved: false,
  publicationApproved: false,
  reviewRequired:
    'Review and approval by Jordanian-qualified counsel, including the cross-border transfer position under the Personal Data Protection Law and the Arabic-language requirement for enforceability before the Jordanian courts.',
  sections: [
    {
      number: 'JO-1',
      heading: 'Application',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This Addendum applies where your organization\'s legal country is the Hashemite Kingdom of Jordan. It supplements the Ledgora Master Terms and Conditions and prevails over them to the extent of any conflict.',
        },
        {
          kind: 'paragraph',
          text: 'Nothing in this Addendum or in the Master Terms removes or limits any right given to you by Jordanian law that cannot be excluded by agreement, or displaces any rule of Jordanian public order.',
        },
      ],
    },
    {
      number: 'JO-2',
      heading: 'Electronic contracting and electronic acceptance',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You and we agree to contract electronically. Accepting the Master Terms and this Addendum through the Ledgora interface creates a binding agreement, and neither of us will dispute its validity on the ground that it is in electronic form.',
        },
        {
          kind: 'paragraph',
          text: 'This reflects the Jordanian Electronic Transactions Law, which gives legal effect to electronic records, contracts and signatures.',
        },
        {
          kind: 'paragraph',
          text: 'We record the version of each document presented, a fingerprint of the exact text shown, who accepted, for which organization, and the server time of acceptance.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — citation and evidential sufficiency. The Electronic Transactions Law in force (and its number and year) must be confirmed from the Legislation and Opinion Bureau, together with whether click-acceptance is sufficient evidentially in a Jordanian court or whether a stronger form of electronic signature is advisable for this agreement.',
        },
      ],
    },
    {
      number: 'JO-3',
      heading: 'Consumer protection',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Ledgora is supplied for business use by registered organizations. Where Jordanian consumer-protection law nonetheless applies, it applies in addition to this agreement and is not limited by it.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — whether the Jordanian consumer-protection regime reaches a business subscriber to a software service, and if so which disclosure, cancellation and remedy rules apply to pricing, renewal and refunds.',
        },
      ],
    },
    {
      number: 'JO-4',
      heading: 'Personal data and cross-border processing',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Where we process personal data relating to you, your staff or your contacts, we do so in accordance with Jordan\'s Personal Data Protection Law and our Privacy Policy.',
        },
        {
          kind: 'paragraph',
          text: 'Your accounting records are held in your own browser and are not transmitted to or held on our servers (Master Terms clause 6). Personal data you record inside those records stays on your device, and we cannot access, export or delete it for you.',
        },
        {
          kind: 'paragraph',
          text: 'Platform data — your account, organization, membership, subscription and payment records, and our audit logs — is held on servers operated through our hosting provider, and is processed outside Jordan.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — cross-border transfer. Jordan\'s Personal Data Protection Law restricts transfer of personal data outside Jordan and conditions it on defined safeguards or approvals. The hosting location must be confirmed, the transfer basis identified, and any consent, notice, safeguard or regulatory approval obtained BEFORE Jordanian customers are accepted. Acceptance of these Terms does not by itself satisfy that requirement.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — the data-processing agreement, subprocessor disclosure, retention periods, data-subject request handling, and whether any registration or notification to the Jordanian data-protection authority is required. None is in place.',
        },
      ],
    },
    {
      number: 'JO-5',
      heading: 'Sales tax, invoicing and record keeping',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You are responsible for your own general sales tax position, for issuing valid invoices to your own customers, for your returns and filings, and for keeping the records Jordanian law requires, for the period it requires.',
        },
        {
          kind: 'paragraph',
          text: 'Ledgora records the tax treatment you configure and enter. It does not determine your tax liability and does not verify your configuration.',
        },
        {
          kind: 'paragraph',
          text: 'Ledgora does NOT submit, clear or transmit invoices to JOFOTARA or to the Income and Sales Tax Department. No national e-invoicing integration is available in the Service. If Jordanian law requires you to issue or clear invoices through JOFOTARA, you must do so by other means, and using Ledgora does not discharge that obligation.',
        },
        {
          kind: 'paragraph',
          text: 'Because your accounting records are held in your own browser, meeting Jordanian record-retention requirements is your responsibility, and you should export and retain your records independently of the Service.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — the sales-tax treatment of a subscription supplied to a Jordanian customer by a UAE free zone establishment, including any reverse-charge or non-resident registration obligation, and whether Jordanian e-invoicing obligations apply to Experts Group FZE\'s own invoices to you.',
        },
      ],
    },
    {
      number: 'JO-6',
      heading: 'Governing law, jurisdiction and mandatory rights',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Master Terms clause 14 states the governing law. Whatever that clause provides, it does not deprive you of the protection of any mandatory rule of Jordanian law that would apply regardless of the parties\' choice, and it does not prevent you from bringing proceedings before the Jordanian courts where Jordanian law entitles you to do so.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — forum. Whether a foreign governing law and forum are enforceable against a Jordan-registered customer, and whether a Jordanian court would accept or decline jurisdiction, must be confirmed. If the answer is that Jordanian customers retain access to the Jordanian courts, the Master Terms clause must say so rather than implying otherwise.',
        },
      ],
    },
    {
      number: 'JO-7',
      heading: 'Language',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This Addendum and the Master Terms are published in English.',
        },
        {
          kind: 'unresolved',
          text: 'UNRESOLVED — Arabic version. Proceedings before the Jordanian courts are conducted in Arabic and a certified Arabic translation is likely to be required for enforcement. Whether an Arabic version must be presented to customers at the point of acceptance — and which language governs on a discrepancy — must be confirmed by counsel. Any Arabic version must be counsel-approved or certified; a machine translation must not be published as a legal version.',
        },
      ],
    },
  ],
};
