/**
 * Free Demo configuration.
 *
 * The demo is a *temporary, in-memory* workspace: no payment, no permanent
 * storage, no cloud backup, no collaboration, no permanent uploads. It exposes
 * only the modules explicitly listed here — a demo visitor is never treated as a
 * paid subscriber and never receives administration surfaces.
 */
import type { ViewKey } from '@/types';

export const FREE_DEMO_PLAN_ID = 'free-demo';

export const FREE_DEMO_COPY = {
  title: 'Explore LEDGORA Free',
  description:
    'Use journals, invoices, ledgers and reports in a temporary demonstration workspace. Your information will not be saved for future sessions.',
  cta: 'Continue without saving',
  confirmTitle: 'Start the LEDGORA Free Demo?',
  confirmBody:
    'You are entering LEDGORA Free Demo. Information entered during this session is temporary and may be lost when you refresh, close, or leave the application.',
  confirmEnter: 'Enter Free Demo',
  confirmChoosePackage: 'Choose a package',
  banner: 'Free Demo — Your information is temporary and will not be available in a future session.',
  saveNotice: 'Saved temporarily for this demo session. Choose a package to retain your records.',
} as const;

/** What the demo explicitly does NOT include (shown on the demo card). */
export const FREE_DEMO_LIMITS: string[] = [
  'No permanent data storage or cloud backup',
  'No multi-user collaboration',
  'No permanent document uploads',
  'Data is lost on refresh, sign-out or closing the browser',
];

/**
 * Views a Free Demo visitor may open. Everything else resolves to the
 * module-unavailable page — the demo cannot reach administration, metering,
 * member management or the super-admin console.
 */
export const FREE_DEMO_VIEWS: ViewKey[] = [
  'dashboard',
  'tree',
  'mapping',
  'entities',
  'customers',
  'suppliers',
  'journal',
  'general-ledger',
  'trial-balance',
  'income-statement',
  'balance-sheet',
  'cash-flow',
  'invoices',
  'credit-notes',
  'receipts',
  'statements',
  'bills',
  'payments',
  'settings',
  'subscription',
];

const DEMO_VIEW_SET = new Set<string>(FREE_DEMO_VIEWS);

export function isFreeDemoView(view: string): boolean {
  return DEMO_VIEW_SET.has(view);
}
