/**
 * Keep the invoice store pointed at the active company's actual backend.
 *
 * ── Why this is an effect and not a call inside `switchCompany` ──────────────
 * `switchCompany` is synchronous and returns a `CompanyActionResult` the caller
 * checks immediately. Loading invoices is a network round trip. Making the
 * switch await it would either block the company change behind a request that
 * can time out, or leave the switch reporting success while the books on screen
 * still belong to the previous company.
 *
 * So the switch stays synchronous and this effect follows it. The window
 * between them is covered by `syncing`, which a list can render as "loading"
 * rather than as "no invoices".
 *
 * ── Why it re-runs on the migration timestamp, not just the id ──────────────
 * A company migrates DURING a session — that is what the cutover does. Watching
 * only `activeCompanyId` would leave the store on the browser backend until the
 * next company switch, so the screen that just reported a successful migration
 * would still be reading localStorage.
 */
import { useEffect } from 'react';
import { useCompanyStore } from '@/store/companyStore';
import { useInvoiceStore } from '@/store/invoiceStore';

export function useInvoiceBackendSync(): void {
  const activeCompanyId = useCompanyStore((s) => s.activeCompanyId);
  const migratedAt = useCompanyStore(
    (s) => s.companies.find((company) => company.id === s.activeCompanyId)?.invoicesMigratedAt ?? null,
  );

  useEffect(() => {
    /*
     * No active company means there is nothing to resolve a backend for. The
     * store keeps whatever it holds rather than being blanked — blanking here
     * would clear a browser-backed company's books on a transient empty render.
     */
    if (!activeCompanyId) return;
    void useInvoiceStore.getState().syncFromServer({ invoicesMigratedAt: migratedAt });
  }, [activeCompanyId, migratedAt]);
}
