/**
 * Default (seed) packages, bank details and billing settings.
 *
 * These are only the INITIAL values written to the store on first run. Every
 * value is editable from the administrator panel and persisted — nothing here
 * is read at runtime as a source of truth once the store is seeded.
 */
import type { LedgoraEdition } from '@/types/entitlements';
import type {
  BankDetails,
  BillingSettings,
  SubscriptionPlan,
} from '@/types/billing';
import { EDITION_INFO } from '@/config/editionCommercialInfo';
import { EDITION_LIMITS } from '@/config/editions';

/** Monthly USD list price per edition (editable afterwards). */
export const DEFAULT_PLAN_PRICES: Record<LedgoraEdition, number> = {
  core: 29,
  projects: 59,
  construction: 99,
  manufacturing: 119,
  enterprise: 249,
};

const PLAN_ORDER: LedgoraEdition[] = [
  'core',
  'projects',
  'construction',
  'manufacturing',
  'enterprise',
];

export function makeSeedPlans(now: string): SubscriptionPlan[] {
  return PLAN_ORDER.map((edition, i) => {
    const info = EDITION_INFO[edition];
    const limits = EDITION_LIMITS[edition];
    return {
      id: `plan_${edition}`,
      code: edition,
      name: info.name,
      description: info.description,
      edition,
      priceMonthly: DEFAULT_PLAN_PRICES[edition],
      currency: 'USD',
      userLimit: limits.userLimit,
      entityLimit: limits.entityLimit,
      addOnModules: [],
      removedModules: [],
      isActive: true,
      isPublic: true,
      sortOrder: i,
      createdAt: now,
      updatedAt: now,
    } satisfies SubscriptionPlan;
  });
}

/**
 * Shipped placeholder bank details. `isPlaceholder` drives the development
 * warning shown next to them; it is cleared the moment an administrator saves
 * real account information.
 */
export const DEFAULT_BANK_DETAILS: BankDetails = {
  bankName: 'Ledgora Bank (example)',
  accountName: 'Ledgora Software FZ-LLC',
  accountNumber: '0123456789',
  iban: 'AE00 0000 0000 0000 0000 000',
  swift: 'LEDGAEXX',
  branch: 'Business Bay, Dubai',
  // The customer quotes the generated LEDGORA payment reference — NOT the
  // invoice number — because that reference is what reconciles the transfer.
  instructions:
    'Transfer the invoice total to the account below and quote the LEDGORA payment reference exactly as shown. Upload the transfer receipt for verification.',
  isPlaceholder: true,
};

export function makeSeedBillingSettings(now: string): BillingSettings {
  return {
    currency: 'USD',
    bank: { ...DEFAULT_BANK_DETAILS },
    graceDays: 7,
    reminderOffsets: [7, 3, 0],
    termMonths: 1,
    invoicePrefix: 'SUB',
    paymentDueDays: 7,
    updatedAt: now,
  };
}
