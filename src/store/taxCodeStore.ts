import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { Account } from '@/types';
import type { ProductTaxCategory, TaxCode, TaxGroup, TaxRateVersion, TaxAuditEvent } from '@/types/taxCode';
import type { TaxAdjustment, TaxJurisdiction, TaxRegistration, TaxReportingBox } from '@/types/taxReporting';
import { hasOverlappingRateVersion } from '@/lib/taxResolution';
import { validateTaxCodeForActivation } from '@/lib/taxValidation';
import {
  SEED_TAX_CODES, SEED_TAX_GROUPS, SEED_TAX_JURISDICTION, SEED_TAX_RATE_VERSIONS, SEED_TAX_REPORTING_BOXES,
} from '@/data/taxSeed';
import { generateId, nowIso } from '@/lib/utils';
import { useStore } from './useStore';

const ACTOR = 'Finance Manager';

export interface TaxActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function accountsMap(): Map<string, Account> {
  return new Map(useStore.getState().accounts.map((a) => [a.id, a]));
}
function audit(action: string, detail?: string): TaxAuditEvent {
  return { id: generateId('taud'), at: nowIso(), action, detail, by: ACTOR };
}

interface TaxCodeState {
  taxCodes: TaxCode[];
  rateVersions: TaxRateVersion[];
  taxGroups: TaxGroup[];
  jurisdictions: TaxJurisdiction[];
  registrations: TaxRegistration[];
  reportingBoxes: TaxReportingBox[];
  productCategories: ProductTaxCategory[];
  adjustments: TaxAdjustment[];

  getTaxCode: (id: string) => TaxCode | undefined;
  getVersionsForCode: (taxCodeId: string) => TaxRateVersion[];
  usedByPostedDocument: (taxCodeId: string) => boolean;

  createTaxCode: (patch?: Partial<TaxCode>) => TaxActionResult;
  updateTaxCode: (id: string, patch: Partial<TaxCode>) => TaxActionResult;
  activateTaxCode: (id: string) => TaxActionResult;
  deactivateTaxCode: (id: string) => TaxActionResult;
  archiveTaxCode: (id: string) => TaxActionResult;
  duplicateTaxCode: (id: string) => TaxActionResult;

  createRateVersion: (taxCodeId: string, input: { rate: number; effectiveFrom: string; outputTaxAccountId?: string; inputTaxAccountId?: string }) => TaxActionResult;

  createTaxGroup: (patch?: Partial<TaxGroup>) => TaxActionResult;
  updateTaxGroup: (id: string, patch: Partial<TaxGroup>) => TaxActionResult;

  createJurisdiction: (patch?: Partial<TaxJurisdiction>) => TaxActionResult;
  updateJurisdiction: (id: string, patch: Partial<TaxJurisdiction>) => TaxActionResult;

  upsertReportingBox: (box: TaxReportingBox) => TaxActionResult;

  createAdjustment: (input: Omit<TaxAdjustment, 'id' | 'createdAt'>) => TaxActionResult;

  replaceAll: (state: Partial<Pick<TaxCodeState, 'taxCodes' | 'rateVersions' | 'taxGroups' | 'jurisdictions' | 'reportingBoxes' | 'adjustments'>>) => void;
  resetToDefault: () => void;
}

function defaultCode(): TaxCode {
  const now = nowIso();
  return {
    id: generateId('tax'), code: '', name: '', category: 'standard', direction: 'sales', scope: 'domestic',
    status: 'inactive', rate: 0, rateType: 'percentage', calculationMethod: 'exclusive', roundingMethod: 'line', precision: 2,
    reportingBoxIds: [], jurisdictionId: SEED_TAX_JURISDICTION.id, effectiveFrom: now.slice(0, 10),
    auditTrail: [audit('tax-code-created')], createdAt: now, updatedAt: now, createdBy: ACTOR,
  };
}

export const useTaxCodeStore = create<TaxCodeState>()(
  persist(
    (set, get) => ({
      taxCodes: SEED_TAX_CODES,
      rateVersions: SEED_TAX_RATE_VERSIONS,
      taxGroups: SEED_TAX_GROUPS,
      jurisdictions: [SEED_TAX_JURISDICTION],
      registrations: [],
      reportingBoxes: SEED_TAX_REPORTING_BOXES,
      productCategories: [],
      adjustments: [],

      getTaxCode: (id) => get().taxCodes.find((c) => c.id === id),
      getVersionsForCode: (taxCodeId) => get().rateVersions.filter((v) => v.taxCodeId === taxCodeId).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)),
      // Placeholder for cross-store usage checks — documents reference tax codes by id in snapshots.
      usedByPostedDocument: () => false,

      createTaxCode: (patch) => {
        const code = { ...defaultCode(), ...patch };
        set({ taxCodes: [...get().taxCodes, code] });
        return { ok: true, id: code.id };
      },

      updateTaxCode: (id, patch) => {
        const { taxCodes } = get();
        const existing = taxCodes.find((c) => c.id === id);
        if (!existing) return { ok: false, error: 'Tax code not found.' };
        if (existing.status === 'archived') return { ok: false, error: 'Archived tax codes cannot be edited.' };
        const changed: string[] = [];
        const patchRec = patch as Record<string, unknown>;
        const existingRec = existing as unknown as Record<string, unknown>;
        for (const k of ['rate', 'outputTaxAccountId', 'inputTaxAccountId', 'reportingBoxIds', 'effectiveFrom', 'effectiveTo'] as const) {
          if (k in patch && JSON.stringify(patchRec[k]) !== JSON.stringify(existingRec[k])) changed.push(k);
        }
        const trail = changed.length ? [...existing.auditTrail, audit('mapping-changed', changed.join(', '))] : existing.auditTrail;
        set({ taxCodes: taxCodes.map((c) => (c.id === id ? { ...existing, ...patch, auditTrail: trail, updatedAt: nowIso(), updatedBy: ACTOR } : c)) });
        return { ok: true, id };
      },

      activateTaxCode: (id) => {
        const { taxCodes, rateVersions } = get();
        const code = taxCodes.find((c) => c.id === id);
        if (!code) return { ok: false, error: 'Tax code not found.' };
        const issues = validateTaxCodeForActivation({ ...code, status: 'active' }, { accountsById: accountsMap(), existingCodes: taxCodes, versions: rateVersions });
        const error = issues.find((i) => i.severity === 'error');
        if (error) return { ok: false, error: error.message };
        set({ taxCodes: taxCodes.map((c) => (c.id === id ? { ...c, status: 'active', auditTrail: [...c.auditTrail, audit('activated')], updatedAt: nowIso() } : c)) });
        return { ok: true, id };
      },

      deactivateTaxCode: (id) => {
        const { taxCodes } = get();
        const code = taxCodes.find((c) => c.id === id);
        if (!code) return { ok: false, error: 'Tax code not found.' };
        set({ taxCodes: taxCodes.map((c) => (c.id === id ? { ...c, status: 'inactive', auditTrail: [...c.auditTrail, audit('deactivated')], updatedAt: nowIso() } : c)) });
        return { ok: true, id };
      },

      archiveTaxCode: (id) => {
        const { taxCodes } = get();
        const code = taxCodes.find((c) => c.id === id);
        if (!code) return { ok: false, error: 'Tax code not found.' };
        set({ taxCodes: taxCodes.map((c) => (c.id === id ? { ...c, status: 'archived', auditTrail: [...c.auditTrail, audit('archived')], updatedAt: nowIso() } : c)) });
        return { ok: true, id };
      },

      duplicateTaxCode: (id) => {
        const { taxCodes } = get();
        const src = taxCodes.find((c) => c.id === id);
        if (!src) return { ok: false, error: 'Tax code not found.' };
        const now = nowIso();
        const copy: TaxCode = {
          ...structuredCopy(src), id: generateId('tax'), code: `${src.code}-COPY`, status: 'inactive',
          isDefaultSales: false, isDefaultPurchase: false, isDefaultExport: false, isDefaultImport: false,
          auditTrail: [audit('tax-code-created', `duplicated from ${src.code}`)], createdAt: now, updatedAt: now,
        };
        set({ taxCodes: [...taxCodes, copy] });
        return { ok: true, id: copy.id };
      },

      createRateVersion: (taxCodeId, input) => {
        const { rateVersions, taxCodes } = get();
        const code = taxCodes.find((c) => c.id === taxCodeId);
        if (!code) return { ok: false, error: 'Tax code not found.' };
        const now = nowIso();
        // End-date any OPEN prior version (one starting before the new one) the day
        // before the new version begins; genuine overlaps (backdating into a closed
        // range or duplicating a start) are still blocked.
        const priorEnd = addDays(input.effectiveFrom, -1);
        const updatedVersions = rateVersions.map((v) =>
          v.taxCodeId === taxCodeId && !v.effectiveTo && v.effectiveFrom < input.effectiveFrom ? { ...v, effectiveTo: priorEnd } : v,
        );
        if (hasOverlappingRateVersion(updatedVersions, taxCodeId, input.effectiveFrom, undefined)) {
          return { ok: false, error: 'The new effective period overlaps an existing rate version.' };
        }
        const version: TaxRateVersion = {
          id: generateId('trv'), taxCodeId, rate: input.rate, effectiveFrom: input.effectiveFrom,
          outputTaxAccountId: input.outputTaxAccountId ?? code.outputTaxAccountId, inputTaxAccountId: input.inputTaxAccountId ?? code.inputTaxAccountId,
          createdAt: now, createdBy: ACTOR,
        };
        set({
          rateVersions: [...updatedVersions, version],
          // The code's current rate reflects the latest version; historical docs keep snapshots.
          taxCodes: taxCodes.map((c) => (c.id === taxCodeId ? { ...c, rate: input.rate, effectiveFrom: input.effectiveFrom, auditTrail: [...c.auditTrail, audit('rate-version-created', `${input.rate}% from ${input.effectiveFrom}`)], updatedAt: now } : c)),
        });
        return { ok: true, id: version.id };
      },

      createTaxGroup: (patch) => {
        const now = nowIso();
        const group: TaxGroup = { id: generateId('txg'), code: '', name: '', status: 'active', taxCodeIds: [], calculationOrder: 'parallel', createdAt: now, updatedAt: now, ...patch };
        set({ taxGroups: [...get().taxGroups, group] });
        return { ok: true, id: group.id };
      },
      updateTaxGroup: (id, patch) => {
        const { taxGroups } = get();
        if (!taxGroups.some((g) => g.id === id)) return { ok: false, error: 'Tax group not found.' };
        set({ taxGroups: taxGroups.map((g) => (g.id === id ? { ...g, ...patch, updatedAt: nowIso() } : g)) });
        return { ok: true, id };
      },

      createJurisdiction: (patch) => {
        const now = nowIso();
        const jur: TaxJurisdiction = { id: generateId('jur'), code: '', name: '', status: 'active', filingFrequency: 'quarterly', createdAt: now, updatedAt: now, ...patch };
        set({ jurisdictions: [...get().jurisdictions, jur] });
        return { ok: true, id: jur.id };
      },
      updateJurisdiction: (id, patch) => {
        const { jurisdictions } = get();
        if (!jurisdictions.some((j) => j.id === id)) return { ok: false, error: 'Jurisdiction not found.' };
        set({ jurisdictions: jurisdictions.map((j) => (j.id === id ? { ...j, ...patch, updatedAt: nowIso() } : j)) });
        return { ok: true, id };
      },

      upsertReportingBox: (box) => {
        const { reportingBoxes } = get();
        const exists = reportingBoxes.some((b) => b.id === box.id);
        set({ reportingBoxes: exists ? reportingBoxes.map((b) => (b.id === box.id ? box : b)) : [...reportingBoxes, box] });
        return { ok: true, id: box.id };
      },

      createAdjustment: (input) => {
        const adj: TaxAdjustment = { ...input, id: generateId('tadj'), createdAt: nowIso(), createdBy: ACTOR };
        set({ adjustments: [...get().adjustments, adj] });
        return { ok: true, id: adj.id };
      },

      replaceAll: (state) => set((s) => ({ ...s, ...state })),
      resetToDefault: () => set({
        taxCodes: SEED_TAX_CODES.map((c) => ({ ...c })), rateVersions: SEED_TAX_RATE_VERSIONS.map((v) => ({ ...v })),
        taxGroups: [], jurisdictions: [SEED_TAX_JURISDICTION], registrations: [], reportingBoxes: SEED_TAX_REPORTING_BOXES.map((b) => ({ ...b })), productCategories: [], adjustments: [],
      }),
    }),
    { name: 'ledgerly-tax-codes', storage: businessJSONStorage, version: 1 },
  ),
);

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function structuredCopy<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
