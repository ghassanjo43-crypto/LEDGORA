/**
 * Human-facing marketing metadata for each edition — used by onboarding cards,
 * the edition selector and edition badges. No runtime access logic lives here.
 */
import type { LedgoraEdition } from '@/types/entitlements';
import type { BadgeTone } from '@/data/ifrsOptions';

export interface EditionCommercialInfo {
  edition: LedgoraEdition;
  name: string;
  tagline: string;
  description: string;
  /** Short bullet points shown on the onboarding / selector card. */
  highlights: string[];
  /** Badge tone hint (maps to the shared Badge component tones). */
  tone: BadgeTone;
  /** Display order for cards and selectors. */
  order: number;
}

export const EDITION_INFO: Record<LedgoraEdition, EditionCommercialInfo> = {
  core: {
    edition: 'core',
    name: 'Ledgora Core',
    tagline: 'Complete bookkeeping',
    description:
      'Everything a business needs to keep clean, IFRS-aligned books: accounting, sales, purchases, statements and standard tax and currency support.',
    highlights: [
      'Chart of accounts & general journal',
      'Invoices, credit notes & receipts',
      'Bills, supplier credits & payments',
      'Standard financial statements',
    ],
    tone: 'slate',
    order: 0,
  },
  projects: {
    edition: 'projects',
    name: 'Ledgora Projects',
    tagline: 'Project profitability & cost control',
    description:
      'Everything in Core plus cost centers and full project accounting — budgets, time and expenses, billing, profitability and project cash flow.',
    highlights: [
      'Cost centers & allocations',
      'Projects, budgets & billing',
      'Project profitability & cash flow',
      'Project reports',
    ],
    tone: 'blue',
    order: 1,
  },
  construction: {
    edition: 'construction',
    name: 'Ledgora Construction',
    tagline: 'Contract, BOQ, retention & WIP',
    description:
      'Everything in Projects plus construction financial control — WBS, cost codes, BOQ, progress billing, retention, subcontracts, WIP and revenue recognition.',
    highlights: [
      'WBS, cost codes & BOQ',
      'Progress billing & retention',
      'Subcontracts & variations',
      'WIP & revenue recognition',
    ],
    tone: 'amber',
    order: 2,
  },
  manufacturing: {
    edition: 'manufacturing',
    name: 'Ledgora Manufacturing',
    tagline: 'From raw material to finished product',
    description:
      'Manufacturing accounting, production control, inventory costing and plant performance from one reliable ledger — Core plus inventory, warehouses, BOM, routings, work orders and product costing. Projects remain an optional add-on.',
    highlights: [
      'Inventory, warehouses & lot/serial tracking',
      'Items, BOM, routings & work centers',
      'Work orders, material issues & production receipts',
      'Standard & actual costing with variances',
    ],
    tone: 'cyan',
    order: 3,
  },
  enterprise: {
    edition: 'enterprise',
    name: 'Ledgora Enterprise',
    tagline: 'Advanced multi-entity & customization',
    description:
      'All stable modules plus multi-entity consolidation, advanced approvals, permissions and custom reporting.',
    highlights: [
      'All Core, Projects & Construction modules',
      'Multi-entity & consolidation',
      'Advanced approvals & permissions',
      'Custom reporting',
    ],
    tone: 'violet',
    order: 4,
  },
};

export const EDITION_INFO_LIST: EditionCommercialInfo[] = Object.values(
  EDITION_INFO,
).sort((a, b) => a.order - b.order);
