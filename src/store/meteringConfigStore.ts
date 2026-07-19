/**
 * Super-administrator-editable metering configuration.
 *
 * Base plans, prices, allowances, overage rates, bundles, Render cost
 * assumptions, thresholds and the active plan/modules all live here and are
 * persisted. NOTHING is hard-coded at runtime — the seed only provides initial
 * values. Edits are permission-gated (super administrator) and audited.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  CommercialBasePlan,
  MeteringAuditEntry,
  MeteringAuditEvent,
  MeteringConfig,
  OptionalModuleOffer,
  OrganizationBundles,
  OverageRates,
  RenderCostAssumptions,
} from '@/types/metering';
import { makeSeedMeteringConfig } from '@/lib/meteringSeed';
import { getPlatformRole, getCurrentUserName } from './sessionStore';
import { assertCanManageMetering } from '@/lib/meteringPermissions';
import { generateId, nowIso } from '@/lib/utils';

export interface MeteringActionResult {
  ok: boolean;
  error?: string;
}

function audit(event: MeteringAuditEvent, detail: string): MeteringAuditEntry {
  return { id: generateId('mau'), event, at: nowIso(), actor: getCurrentUserName(), detail };
}

interface MeteringConfigState {
  config: MeteringConfig;
  /** Bundles the active organization has purchased (raises effective allowance). */
  orgBundles: OrganizationBundles;
  auditTrail: MeteringAuditEntry[];
  seeded: boolean;

  ensureSeeded: () => void;

  setActiveBasePlan: (planId: string) => MeteringActionResult;
  setActiveModules: (moduleCodes: string[]) => MeteringActionResult;

  updateBasePlan: (id: string, patch: Partial<CommercialBasePlan>) => MeteringActionResult;
  updateOptionalModule: (id: string, patch: Partial<OptionalModuleOffer>) => MeteringActionResult;
  updateOverageRates: (patch: Partial<OverageRates>) => MeteringActionResult;
  updateRenderCosts: (patch: Partial<RenderCostAssumptions>) => MeteringActionResult;
  updateThresholds: (thresholds: number[]) => MeteringActionResult;

  purchaseBundle: (kind: 'storage' | 'bandwidth', gb: number) => MeteringActionResult;

  resetToDefault: () => void;
}

function seedState(): Pick<MeteringConfigState, 'config' | 'orgBundles' | 'auditTrail' | 'seeded'> {
  return {
    config: makeSeedMeteringConfig(nowIso()),
    orgBundles: { storageGb: 0, bandwidthGb: 0 },
    auditTrail: [],
    seeded: true,
  };
}

function guard(): MeteringActionResult | null {
  const perm = assertCanManageMetering(getPlatformRole());
  return perm.ok ? null : { ok: false, error: perm.error };
}

export const useMeteringConfigStore = create<MeteringConfigState>()(
  persist(
    (set, get) => ({
      ...seedState(),
      seeded: false,

      ensureSeeded: () => {
        if (get().seeded && get().config.basePlans.length > 0) return;
        set(seedState());
      },

      setActiveBasePlan: (planId) => {
        const g = guard();
        if (g) return g;
        if (!get().config.basePlans.some((p) => p.id === planId)) return { ok: false, error: 'Plan not found.' };
        set((s) => ({
          config: { ...s.config, activeBasePlanId: planId, updatedAt: nowIso() },
          auditTrail: [...s.auditTrail, audit('config-updated', `Active base plan set to ${planId}.`)],
        }));
        return { ok: true };
      },

      setActiveModules: (moduleCodes) => {
        const g = guard();
        if (g) return g;
        set((s) => ({
          config: { ...s.config, activeModuleCodes: [...new Set(moduleCodes)], updatedAt: nowIso() },
          auditTrail: [...s.auditTrail, audit('module-updated', `Active optional modules: ${moduleCodes.join(', ') || 'none'}.`)],
        }));
        return { ok: true };
      },

      updateBasePlan: (id, patch) => {
        const g = guard();
        if (g) return g;
        const existing = get().config.basePlans.find((p) => p.id === id);
        if (!existing) return { ok: false, error: 'Plan not found.' };
        if (patch.priceMonthly !== undefined && patch.priceMonthly < 0) return { ok: false, error: 'Price cannot be negative.' };
        set((s) => ({
          config: {
            ...s.config,
            basePlans: s.config.basePlans.map((p) => (p.id === id ? { ...p, ...patch, allowances: { ...p.allowances, ...(patch.allowances ?? {}) } } : p)),
            updatedAt: nowIso(),
          },
          auditTrail: [...s.auditTrail, audit('plan-updated', `Base plan "${existing.name}" updated.`)],
        }));
        return { ok: true };
      },

      updateOptionalModule: (id, patch) => {
        const g = guard();
        if (g) return g;
        const existing = get().config.optionalModules.find((m) => m.id === id);
        if (!existing) return { ok: false, error: 'Module not found.' };
        set((s) => ({
          config: { ...s.config, optionalModules: s.config.optionalModules.map((m) => (m.id === id ? { ...m, ...patch } : m)), updatedAt: nowIso() },
          auditTrail: [...s.auditTrail, audit('module-updated', `Optional module "${existing.name}" updated.`)],
        }));
        return { ok: true };
      },

      updateOverageRates: (patch) => {
        const g = guard();
        if (g) return g;
        set((s) => ({
          config: { ...s.config, overageRates: { ...s.config.overageRates, ...patch }, updatedAt: nowIso() },
          auditTrail: [...s.auditTrail, audit('overage-rates-updated', 'Overage rates updated.')],
        }));
        return { ok: true };
      },

      updateRenderCosts: (patch) => {
        const g = guard();
        if (g) return g;
        set((s) => ({
          config: { ...s.config, renderCosts: { ...s.config.renderCosts, ...patch }, updatedAt: nowIso() },
          auditTrail: [...s.auditTrail, audit('render-costs-updated', 'Render cost assumptions updated.')],
        }));
        return { ok: true };
      },

      updateThresholds: (thresholds) => {
        const g = guard();
        if (g) return g;
        const clean = thresholds.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
        if (clean.length === 0) return { ok: false, error: 'Provide at least one threshold.' };
        set((s) => ({
          config: { ...s.config, thresholds: clean, updatedAt: nowIso() },
          auditTrail: [...s.auditTrail, audit('config-updated', `Thresholds set to ${clean.join(', ')}.`)],
        }));
        return { ok: true };
      },

      purchaseBundle: (kind, gb) => {
        set((s) => ({
          orgBundles: {
            storageGb: s.orgBundles.storageGb + (kind === 'storage' ? gb : 0),
            bandwidthGb: s.orgBundles.bandwidthGb + (kind === 'bandwidth' ? gb : 0),
          },
          auditTrail: [...s.auditTrail, audit('bundle-purchased', `Purchased ${gb} GB ${kind} bundle.`)],
        }));
        return { ok: true };
      },

      resetToDefault: () => set({ ...seedState() }),
    }),
    {
      name: 'ledgora-metering-config',
      version: 1,
      partialize: (s) => ({ config: s.config, orgBundles: s.orgBundles, auditTrail: s.auditTrail, seeded: s.seeded }),
    },
  ),
);

/** The active base plan (call from useMemo / imperatively — not a selector). */
export function getActiveBasePlan(): CommercialBasePlan | undefined {
  const { config } = useMeteringConfigStore.getState();
  return config.basePlans.find((p) => p.id === config.activeBasePlanId);
}
