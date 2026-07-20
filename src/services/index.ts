/**
 * Service registry. Swap a development adapter for its API-backed
 * implementation here — no page or store imports an adapter directly.
 */
import type { AccountingPersistenceService, AuthService, SubscriptionService } from './types';
import type { PaymentReferenceService } from './paymentReferenceService';
import { devAuthService } from './devAuthService';
import { apiAuthService } from './apiAuthService';
import { devSubscriptionService } from './devSubscriptionService';
import { devAccountingPersistenceService } from './devAccountingPersistenceService';
import { devPaymentReferenceService } from './paymentReferenceService';
import { isApiConfigured } from './api/client';

/**
 * Real, server-side authentication whenever a backend origin is configured
 * (`VITE_API_URL`); otherwise the browser-only development adapter, so the
 * static demo build keeps working with no backend to talk to.
 *
 * Resolved once at module load: the build-time value cannot change at runtime,
 * and a stable choice avoids two adapters racing over the same stores.
 */
export const authService: AuthService = isApiConfigured() ? apiAuthService : devAuthService;
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
