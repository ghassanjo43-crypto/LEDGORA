/**
 * Keeping `useStore.settings` in step with the server.
 *
 * ══ What this store is now ═══════════════════════════════════════════════════
 *
 * A CACHE. Every accounting-meaning setting — fiscal year, books start,
 * reporting framework, tax registration, and the block that prints on tax
 * documents — is authoritative on the server. `useStore.settings` holds the
 * last answer so screens can render synchronously; it decides nothing.
 *
 * The rest of `settings` (`presentationMode`) is a view preference and stays
 * local, because it changes how a statement is laid out, never what it says.
 *
 * ══ Why hydration overwrites rather than merges ══════════════════════════════
 *
 * A merge would let a stale local value survive a server answer, which is
 * exactly the divergence this work exists to end. Server fields overwrite;
 * local-only fields are preserved because the server has no opinion on them.
 */
import { companySettingsApi, type ServerCompanySettings, type CompanySettingsPatch } from './api/companySettingsApi';
import { useStore } from '@/store/useStore';

/** The version the last hydration returned; required by every update. */
let currentVersion: number | null = null;

export function settingsVersion(): number | null {
  return currentVersion;
}

/** Sign-out, or a company change: the cached verdict no longer applies. */
export function resetCompanySettings(): void {
  currentVersion = null;
}

/** Server answer → the shape `useStore.settings` already uses. */
function toStoreSettings(server: ServerCompanySettings) {
  return {
    tradingName: '',
    organizationType: server.organizationType,
    industryType: server.industryType,
    logoUrl: server.logoUrl,
    registrationNumber: '',
    taxRegistered: server.taxRegistered,
    taxRegistrationNumber: server.taxRegistrationNumber,
    /* Held exactly on the server; the store's field is numeric for display. */
    defaultTaxRate: Number(server.defaultTaxRate),
    email: server.email,
    phone: server.phone,
    website: server.website,
    country: server.country,
    stateProvince: server.stateProvince,
    city: server.city,
    addressLine1: server.addressLine1,
    addressLine2: server.addressLine2,
    postalCode: server.postalCode,
    fiscalYearStart: server.fiscalYearStart,
    booksStartDate: server.booksStartDate ?? '',
    accountingBasis: server.accountingBasis,
    reportingFramework: server.reportingFramework,
  };
}

/**
 * Load the open company's settings and replace the cache.
 *
 * Failure leaves the previous cache in place and is reported to the caller: a
 * screen that cannot reach the server should say so, not silently render a
 * fiscal year nobody chose.
 */
export async function hydrateCompanySettings(): Promise<
  { ok: true; settings: ServerCompanySettings } | { ok: false; error: string }
> {
  try {
    const server = await companySettingsApi.get();
    currentVersion = server.version;
    useStore.getState().updateSettings(toStoreSettings(server));
    return { ok: true, settings: server };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not load your company settings.',
    };
  }
}

/**
 * Write a change through the server, then refresh the cache from what it
 * returned — never from what was sent.
 *
 * The server may normalise a value, and the version certainly changes; echoing
 * the request back into the cache would leave the two disagreeing until the
 * next reload, which is the whole failure being removed.
 */
export async function saveCompanySettings(
  patch: CompanySettingsPatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (currentVersion === null) {
    /* Nothing was read, so there is no version to write against. */
    const hydrated = await hydrateCompanySettings();
    if (!hydrated.ok) return hydrated;
  }
  try {
    const server = await companySettingsApi.update(patch, currentVersion!);
    currentVersion = server.version;
    useStore.getState().updateSettings(toStoreSettings(server));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not save your company settings.',
    };
  }
}
