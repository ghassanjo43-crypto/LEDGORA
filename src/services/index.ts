/**
 * Service registry. Swap a development adapter for its API-backed
 * implementation here — no page or store imports an adapter directly.
 */
import type { AccountingPersistenceService, AuthService, SubscriptionService } from './types';
import type { PaymentReferenceService } from './paymentReferenceService';
import { devAuthService } from './devAuthService';
import { devSubscriptionService } from './devSubscriptionService';
import { devAccountingPersistenceService } from './devAccountingPersistenceService';
import { devPaymentReferenceService } from './paymentReferenceService';

export const authService: AuthService = devAuthService;
export const subscriptionService: SubscriptionService = devSubscriptionService;
export const accountingPersistenceService: AccountingPersistenceService = devAccountingPersistenceService;
/**
 * Payment references are generated in-browser today. Swap in an API-backed
 * implementation here; production references MUST come from the server, where a
 * UNIQUE database constraint guarantees uniqueness.
 */
export const paymentReferenceService: PaymentReferenceService = devPaymentReferenceService;

export * from './types';
export * from './paymentReferenceService';
