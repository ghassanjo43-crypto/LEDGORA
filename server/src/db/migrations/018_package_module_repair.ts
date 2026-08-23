/**
 * Repair the coarse module lists the commercial packages sell.
 *
 * ══ What was wrong ═══════════════════════════════════════════════════════════
 *
 * Migration 014 seeded each package's `module_entitlements` inline, and the list
 * drifted from the product. Three gaps, all of which surfaced to a subscriber as
 * "not in package" on a module their edition genuinely includes:
 *
 *   · `fixed_assets`   — in NO package at all, Enterprise included. The asset
 *                        register has a module, a navigation group and its own
 *                        edition tier, so it was visible everywhere and
 *                        permitted nowhere.
 *   · `multi_currency` — Enterprise only, though it gates currency MASTER DATA,
 *                        which every edition ships. Advanced FX is a different
 *                        module and is unaffected.
 *   · `cost_centers`   — missing from `manufacturing`, whose own
 *                        `manufacturing_core` and `manufacturing_work_centers`
 *                        declare a dependency on it.
 *
 * ══ Why this ADDS rather than replaces ═══════════════════════════════════════
 *
 * Migration 014 protected an operator's edits by touching only rows still
 * carrying the 002 seed values. That rule cannot be reused here: the whole point
 * is to repair rows that 014 itself wrote, and an operator who has since
 * customised a package would otherwise keep the broken list forever.
 *
 * So this takes the UNION of what the row already sells and what the canonical
 * catalogue says it must sell. An operator's additions survive untouched; only
 * the missing entitlements are added. Nothing is ever removed — withdrawing a
 * module from a live package is a commercial act, not a migration's business.
 */
import { sql, type Kysely } from 'kysely';
import { PACKAGE_CODES, modulesForPackage } from '../../config/packageCatalogue.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  for (const code of PACKAGE_CODES) {
    const required = JSON.stringify(modulesForPackage(code));
    /*
     * `@>` asks "does the row already contain every required module?", so a row
     * that is already correct is not rewritten and its `updated_at` is not
     * disturbed — which matters, because 014 reads that column as the marker of
     * an untouched row.
     */
    await sql`
      UPDATE subscription_plans
         SET module_entitlements = (
               SELECT to_jsonb(array_agg(DISTINCT value ORDER BY value))
                 FROM jsonb_array_elements_text(module_entitlements || ${required}::jsonb)
             ),
             updated_at = now()
       WHERE code = ${code}
         AND NOT (module_entitlements @> ${required}::jsonb)
    `.execute(db);
  }

  /*
   * `organization_entitlements` is a DERIVED CACHE, and `getEntitlements` serves
   * the cached row whenever one exists — it only recomputes when the row is
   * absent. Repairing the plans without touching the cache would therefore fix
   * nothing for anybody who already has a subscription: every existing
   * subscriber would keep resolving the restored modules as "not in package"
   * until an operator happened to press "refresh entitlements".
   *
   * The stale rows are DROPPED rather than recomputed in SQL, so the rebuild
   * goes through `recalculateEntitlements` — the single implementation that
   * knows about plan modules, per-tenant extras and status — instead of a
   * second copy of that logic living here and drifting from it.
   */
  await sql`
    DELETE FROM organization_entitlements e
     USING subscription_plans p
     WHERE e.plan_id = p.id
       AND NOT (e.modules @> p.module_entitlements)
  `.execute(db);
}

export async function down(): Promise<void> {
  /*
   * Deliberately empty. Down would mean taking modules away from packages that
   * are now selling them — and from any subscriber whose entitlements were
   * recomputed in the meantime. Re-running `up` is idempotent, so there is
   * nothing a rollback needs to undo.
   */
}
