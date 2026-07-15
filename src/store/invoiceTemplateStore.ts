import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  InvoiceNumberingConfig,
  InvoiceTemplate,
  InvoiceTemplateVersion,
  ResolvedInvoiceTemplate,
} from '@/types/invoice';
import {
  buildSeedInvoiceTemplates,
  SYSTEM_TEMPLATE_ID,
} from '@/data/invoiceTemplates';
import {
  resolveInvoiceTemplateVersion,
  createDraftVersionFromPublished,
  latestPublishedVersion,
  type TemplateData,
} from '@/lib/invoiceTemplates';
import { generateInvoiceNumber, makeDefaultNumberingConfig } from '@/lib/invoiceNumbering';
import { isPersistentLogo } from '@/lib/invoiceLogo';
import { generateId, nowIso } from '@/lib/utils';

/** Single-company invoicing entity id for now (multi-company: swap for the active company id). */
export const INVOICE_ENTITY_ID = 'primary';

export interface TemplateActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

interface InvoiceTemplateState {
  templates: InvoiceTemplate[];
  versions: InvoiceTemplateVersion[];
  numbering: Record<string, InvoiceNumberingConfig>;

  getData: () => TemplateData;
  getTemplate: (id: string) => InvoiceTemplate | undefined;
  getVersion: (id: string) => InvoiceTemplateVersion | undefined;
  /** Resolve the effective template version. Customer preference comes from the customer record. */
  resolve: (params: { entityId: string; customerDefaultTemplateId?: string; invoiceDate?: string; invoiceTemplateVersionId?: string }) => ResolvedInvoiceTemplate;

  duplicateTemplate: (templateId: string, name?: string) => TemplateActionResult;
  /** Rename a template in place (ID unchanged, so assignments/invoices/snapshots stay valid). */
  renameTemplate: (templateId: string, name: string) => TemplateActionResult;
  archiveTemplate: (templateId: string) => TemplateActionResult;
  makeEntityDefault: (templateId: string, entityId: string) => TemplateActionResult;
  createDraftVersion: (templateId: string, createdBy?: string) => TemplateActionResult;
  updateVersion: (versionId: string, patch: Partial<Pick<InvoiceTemplateVersion, 'layoutConfig' | 'styleConfig' | 'contentConfig' | 'versionLabel'>>) => TemplateActionResult;
  publishVersion: (versionId: string) => TemplateActionResult;

  getNumbering: (entityId: string) => InvoiceNumberingConfig;
  setNumbering: (entityId: string, patch: Partial<InvoiceNumberingConfig>) => void;
  /** Advance and persist the next invoice number for an entity, skipping used numbers. */
  takeInvoiceNumber: (entityId: string, usedNumbers: Set<string>, date: string) => string;

  resetToDefault: () => void;
}

function seed() {
  const s = buildSeedInvoiceTemplates(INVOICE_ENTITY_ID);
  return {
    templates: s.templates,
    versions: s.versions,
    numbering: { [INVOICE_ENTITY_ID]: makeDefaultNumberingConfig(INVOICE_ENTITY_ID) } as Record<string, InvoiceNumberingConfig>,
  };
}

export const useInvoiceTemplateStore = create<InvoiceTemplateState>()(
  persist(
    (set, get) => ({
      ...seed(),

      getData: () => {
        const { templates, versions } = get();
        return { templates, versions };
      },
      getTemplate: (id) => get().templates.find((t) => t.id === id),
      getVersion: (id) => get().versions.find((v) => v.id === id),
      resolve: (params) => resolveInvoiceTemplateVersion(params, get().getData()),

      duplicateTemplate: (templateId, name) => {
        const { templates, versions } = get();
        const src = templates.find((t) => t.id === templateId);
        if (!src) return { ok: false, error: 'Template not found.' };
        const newTemplateId = generateId('tmpl');
        const srcVersion = latestPublishedVersion(templateId, versions) ?? versions.find((v) => v.templateId === templateId);
        const newVersionId = generateId('tmplv');
        const now = nowIso();
        const newVersion: InvoiceTemplateVersion | null = srcVersion
          ? { ...structuredCopy(srcVersion), id: newVersionId, templateId: newTemplateId, versionNumber: 1, status: 'published', createdAt: now, publishedAt: now }
          : null;
        const newTemplate: InvoiceTemplate = {
          id: newTemplateId, entityId: INVOICE_ENTITY_ID, name: name || `${src.name} (copy)`, description: src.description,
          isSystemDefault: false, isEntityDefault: false, isArchived: false,
          currentVersionId: newVersionId, createdAt: now, updatedAt: now,
        };
        set({ templates: [...templates, newTemplate], versions: newVersion ? [...versions, newVersion] : versions });
        return { ok: true, id: newTemplateId };
      },

      renameTemplate: (templateId, name) => {
        const { templates } = get();
        const t = templates.find((x) => x.id === templateId);
        if (!t) return { ok: false, error: 'Template not found.' };
        const normalized = name.trim();
        if (!normalized) return { ok: false, error: 'Template name is required.' };
        if (normalized.length > 80) return { ok: false, error: 'Template name cannot exceed 80 characters.' };
        const duplicate = templates.some((x) => x.id !== templateId && !x.isArchived && x.name.trim().toLowerCase() === normalized.toLowerCase());
        if (duplicate) return { ok: false, error: 'An invoice template with this name already exists.' };
        // Rename in place — the ID never changes, so customer assignments, existing
        // invoices and issued snapshots stay linked/unaffected.
        set({ templates: templates.map((x) => (x.id === templateId ? { ...x, name: normalized, updatedAt: nowIso() } : x)) });
        return { ok: true, id: templateId };
      },

      archiveTemplate: (templateId) => {
        const { templates } = get();
        const t = templates.find((x) => x.id === templateId);
        if (!t) return { ok: false, error: 'Template not found.' };
        if (t.isSystemDefault) return { ok: false, error: 'The system default template cannot be archived.' };
        set({ templates: templates.map((x) => (x.id === templateId ? { ...x, isArchived: true, isEntityDefault: false, updatedAt: nowIso() } : x)) });
        return { ok: true, id: templateId };
      },

      makeEntityDefault: (templateId, entityId) => {
        const { templates } = get();
        const t = templates.find((x) => x.id === templateId);
        if (!t) return { ok: false, error: 'Template not found.' };
        if (t.isArchived) return { ok: false, error: 'Archived templates cannot be the entity default.' };
        set({ templates: templates.map((x) => (x.entityId === entityId || x.id === templateId ? { ...x, isEntityDefault: x.id === templateId, updatedAt: nowIso() } : x)) });
        return { ok: true, id: templateId };
      },

      createDraftVersion: (templateId, createdBy) => {
        const { templates, versions } = get();
        const t = templates.find((x) => x.id === templateId);
        if (!t) return { ok: false, error: 'Template not found.' };
        const draft = createDraftVersionFromPublished(t, versions, createdBy);
        set({ versions: [...versions, draft] });
        return { ok: true, id: draft.id };
      },

      updateVersion: (versionId, patch) => {
        const { versions } = get();
        const v = versions.find((x) => x.id === versionId);
        if (!v) return { ok: false, error: 'Version not found.' };
        if (v.status !== 'draft') return { ok: false, error: 'Only draft versions can be edited. Create a new version first.' };
        set({ versions: versions.map((x) => (x.id === versionId ? { ...x, ...patch } : x)) });
        return { ok: true, id: versionId };
      },

      publishVersion: (versionId) => {
        const { versions, templates } = get();
        const v = versions.find((x) => x.id === versionId);
        if (!v) return { ok: false, error: 'Version not found.' };
        if (v.status === 'archived') return { ok: false, error: 'Archived versions cannot be published.' };
        const now = nowIso();
        set({
          versions: versions.map((x) => (x.id === versionId ? { ...x, status: 'published', publishedAt: x.publishedAt ?? now } : x)),
          templates: templates.map((t) => (t.id === v.templateId ? { ...t, currentVersionId: versionId, updatedAt: now } : t)),
        });
        return { ok: true, id: versionId };
      },

      getNumbering: (entityId) => get().numbering[entityId] ?? makeDefaultNumberingConfig(entityId),
      setNumbering: (entityId, patch) => set((s) => ({ numbering: { ...s.numbering, [entityId]: { ...s.getNumbering(entityId), ...patch } } })),
      takeInvoiceNumber: (entityId, usedNumbers, date) => {
        const cfg = get().getNumbering(entityId);
        const { number, nextConfig } = generateInvoiceNumber(cfg, usedNumbers, date);
        set((s) => ({ numbering: { ...s.numbering, [entityId]: nextConfig } }));
        return number;
      },

      resetToDefault: () => set({ ...seed() }),
    }),
    {
      name: 'ledgerly-invoice-templates',
      version: 1,
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<InvoiceTemplateState>;
        // Guarantee the system default template always exists after hydration.
        const templates = p.templates?.some((t) => t.id === SYSTEM_TEMPLATE_ID) ? p.templates : seed().templates;
        const rawVersions = p.versions?.length ? p.versions : seed().versions;
        // Drop any legacy non-persistent (blob:/path) custom logos left in storage.
        const versions = rawVersions.map((v) => {
          const logo = v.contentConfig?.logo;
          if (logo?.customLogoUrl && !isPersistentLogo(logo.customLogoUrl)) {
            return { ...v, contentConfig: { ...v.contentConfig, logo: { ...logo, customLogoUrl: undefined, mode: logo.mode === 'custom' ? 'entity-default' : logo.mode } } };
          }
          return v;
        });
        return {
          ...current,
          ...p,
          templates: templates ?? current.templates,
          versions,
          numbering: p.numbering ?? current.numbering,
        };
      },
    },
  ),
);

function structuredCopy<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
