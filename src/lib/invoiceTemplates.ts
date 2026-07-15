import type {
  InvoiceCompanySnapshot,
  InvoiceCustomerSnapshot,
  InvoiceTemplate,
  InvoiceTemplateSnapshot,
  InvoiceTemplateVersion,
  ResolvedInvoiceTemplate,
} from '@/types/invoice';
import { generateId } from '@/lib/utils';
import { resolveTemplateLogoUrl } from '@/lib/invoiceLogo';

export interface TemplateData {
  templates: InvoiceTemplate[];
  versions: InvoiceTemplateVersion[];
}

export interface ResolveParams {
  /** Manual per-invoice override (highest priority). */
  invoiceTemplateVersionId?: string;
  /** The customer's preferred template id, stored ON the customer record. */
  customerDefaultTemplateId?: string;
  entityId: string;
  invoiceDate?: string;
}

function version(versions: InvoiceTemplateVersion[], id: string | undefined): InvoiceTemplateVersion | undefined {
  return id ? versions.find((v) => v.id === id) : undefined;
}

/** Highest-numbered PUBLISHED version of a template (undefined if none published). */
export function latestPublishedVersion(templateId: string, versions: InvoiceTemplateVersion[]): InvoiceTemplateVersion | undefined {
  return versions
    .filter((v) => v.templateId === templateId && v.status === 'published')
    .sort((a, b) => b.versionNumber - a.versionNumber)[0];
}

/** Only published versions may be assigned to customers or new invoices. */
export function canAssignVersion(v: InvoiceTemplateVersion | undefined): boolean {
  return v?.status === 'published';
}

function entityDefaultTemplate(data: TemplateData, entityId: string): InvoiceTemplate | undefined {
  return data.templates.find((t) => t.isEntityDefault && !t.isArchived && t.entityId === entityId)
    ?? data.templates.find((t) => t.isEntityDefault && !t.isArchived);
}

function systemDefaultTemplate(data: TemplateData): InvoiceTemplate | undefined {
  return data.templates.find((t) => t.isSystemDefault);
}

/**
 * THE single template-resolution function. Priority:
 *   1. Invoice-specific templateVersionId (manual per-invoice override)
 *   2. Customer's preferred template (stored on the customer record) → its latest published version
 *   3. Entity default template's published version
 *   4. System default template's published version
 * Never duplicate this logic in UI components.
 */
export function resolveInvoiceTemplateVersion(params: ResolveParams, data: TemplateData): ResolvedInvoiceTemplate {
  // 1. Invoice override
  const override = version(data.versions, params.invoiceTemplateVersionId);
  if (override) {
    return { templateId: override.templateId, templateVersionId: override.id, resolutionSource: 'invoice-override' };
  }

  // 2. Customer's preferred template (from the customer record)
  if (params.customerDefaultTemplateId) {
    const template = data.templates.find((t) => t.id === params.customerDefaultTemplateId && !t.isArchived);
    const resolved = template ? latestPublishedVersion(template.id, data.versions) : undefined;
    if (template && resolved) {
      return { templateId: template.id, templateVersionId: resolved.id, resolutionSource: 'customer-preference' };
    }
  }

  // 3. Entity default
  const entityDefault = entityDefaultTemplate(data, params.entityId);
  if (entityDefault) {
    const resolved = latestPublishedVersion(entityDefault.id, data.versions) ?? version(data.versions, entityDefault.currentVersionId);
    if (resolved) {
      return { templateId: entityDefault.id, templateVersionId: resolved.id, resolutionSource: 'entity-default' };
    }
  }

  // 4. System default (always available)
  const system = systemDefaultTemplate(data);
  const systemVersion = system
    ? latestPublishedVersion(system.id, data.versions) ?? version(data.versions, system.currentVersionId)
    : undefined;
  if (system && systemVersion) {
    return { templateId: system.id, templateVersionId: systemVersion.id, resolutionSource: 'system-default' };
  }

  throw new Error('No invoice template could be resolved — the system default template is missing.');
}

/* ───────────────────────────── Snapshotting ─────────────────────────────── */

/**
 * Freeze a template version plus the company/customer identity into an immutable
 * snapshot stored on the invoice at issuance. Deep-copies the configs so later
 * template edits never mutate an already-issued invoice.
 */
export function createInvoiceTemplateSnapshot(
  template: InvoiceTemplate,
  version: InvoiceTemplateVersion,
  company: InvoiceCompanySnapshot,
  customer: InvoiceCustomerSnapshot,
): InvoiceTemplateSnapshot {
  // Freeze the EFFECTIVE logo (custom template logo, company default, or none)
  // into the company snapshot so a later logo change never alters this invoice.
  const effectiveLogoUrl = resolveTemplateLogoUrl(version.contentConfig, company.logoUrl);
  const contentConfig = structuredCloneSafe(version.contentConfig);
  // The renderer reads the image from companySnapshot.logoUrl; drop the (often
  // large) duplicate data URL from the content copy so each issued invoice stores
  // the logo ONCE — this keeps LocalStorage well under quota as invoices accrue.
  if (contentConfig.logo?.customLogoUrl) contentConfig.logo = { ...contentConfig.logo, customLogoUrl: undefined };
  return {
    templateId: template.id,
    templateVersionId: version.id,
    templateName: template.name,
    versionNumber: version.versionNumber,
    layoutConfig: structuredCloneSafe(version.layoutConfig),
    styleConfig: structuredCloneSafe(version.styleConfig),
    contentConfig,
    companySnapshot: { ...company, logoUrl: effectiveLogoUrl },
    customerSnapshot: { ...customer },
  };
}

/* ───────────────────────────── Versioning ───────────────────────────────── */

/**
 * Editing a PUBLISHED version never overwrites it — it creates a new DRAFT that
 * copies the configuration and increments the version number.
 */
export function createDraftVersionFromPublished(
  template: InvoiceTemplate,
  versions: InvoiceTemplateVersion[],
  createdBy?: string,
): InvoiceTemplateVersion {
  const source = latestPublishedVersion(template.id, versions)
    ?? versions.filter((v) => v.templateId === template.id).sort((a, b) => b.versionNumber - a.versionNumber)[0];
  const maxNumber = versions.filter((v) => v.templateId === template.id).reduce((m, v) => Math.max(m, v.versionNumber), 0);
  return {
    id: generateId('tmplv'),
    templateId: template.id,
    versionNumber: maxNumber + 1,
    status: 'draft',
    layoutConfig: structuredCloneSafe(source?.layoutConfig ?? ({} as InvoiceTemplateVersion['layoutConfig'])),
    styleConfig: structuredCloneSafe(source?.styleConfig ?? ({} as InvoiceTemplateVersion['styleConfig'])),
    contentConfig: structuredCloneSafe(source?.contentConfig ?? ({} as InvoiceTemplateVersion['contentConfig'])),
    createdBy,
    createdAt: new Date().toISOString(),
  };
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
