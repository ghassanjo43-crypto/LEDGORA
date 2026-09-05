/**
 * The browser's client for the server-held fixed-asset register.
 *
 * ══ What this client cannot ask for ══════════════════════════════════════════
 *
 * There is no cost, no accumulated depreciation, no carrying amount, no
 * schedule and no run in any type here, because there is none on the server.
 * The absence is deliberate and typed: a screen that tries to read a net book
 * value from a `ServerFixedAsset` fails to compile rather than rendering
 * `undefined` as a currency.
 *
 * ══ Amounts stay STRINGS ═════════════════════════════════════════════════════
 *
 * `residualValue` arrives as an exact decimal string and stays one. Parsing it
 * to `number` here would lose the third place before any screen saw it, and a
 * JOD residual value of 1.005 that quietly became 1.0049999 would be frozen
 * onto the asset the moment F2 capitalised it.
 */
import { api } from './client';

/** The only two methods F1 evaluates. The server refuses every other by name. */
export type FixedAssetMethod = 'straight_line' | 'none';
/** The product's one proration convention: whole calendar months. */
export type FixedAssetConvention = 'full_month';

export type CategoryStatus = 'active' | 'archived';
/** Every other status asserts a posting that does not exist yet. */
export type AssetStatus = 'draft' | 'archived';

export interface ServerAssetCategory {
  id: string;
  code: string;
  name: string;
  description: string;
  defaultMethod: FixedAssetMethod;
  /** Months. This product measures useful life in months everywhere. */
  defaultUsefulLifeMonths: number | null;
  /** A PERCENTAGE, as an exact decimal string. The ASSET holds an amount. */
  defaultResidualPercent: string;
  depreciationConvention: FixedAssetConvention;
  assetCostAccountId: string | null;
  accumulatedDepreciationAccountId: string | null;
  depreciationExpenseAccountId: string | null;
  assetCostAccountLabel: string;
  accumulatedDepreciationAccountLabel: string;
  depreciationExpenseAccountLabel: string;
  /** All three mappings present. F2 will refuse to post without them. */
  mappingComplete: boolean;
  status: CategoryStatus;
  version: number;
  /** Non-archived assets naming this category. Drives the archive refusal. */
  activeAssetCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CategoryWriteInput {
  code: string;
  name: string;
  description?: string;
  defaultMethod?: string;
  defaultUsefulLifeMonths?: number | null;
  defaultResidualPercent?: string | null;
  depreciationConvention?: string;
  assetCostAccountId?: string | null;
  accumulatedDepreciationAccountId?: string | null;
  depreciationExpenseAccountId?: string | null;
}

export interface ServerFixedAsset {
  id: string;
  assetCode: string;
  name: string;
  description: string;
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  /** Calendar dates, `yyyy-mm-dd`. Never timestamps: an asset has no time zone. */
  acquisitionDate: string;
  depreciationStartDate: string | null;
  /** Frozen from the category at registration; a later category edit never moves it. */
  depreciationMethod: FixedAssetMethod;
  usefulLifeMonths: number | null;
  /** Always 'months'. Said by the server so no screen has to assume it. */
  usefulLifeUnit: 'months';
  depreciationConvention: FixedAssetConvention;
  /** An exact decimal string. Never parsed to a float on the way through. */
  residualValue: string;
  /** Identical units this one record represents. Not stock on hand. */
  quantity: number;
  location: string;
  custodian: string;
  branch: string;
  department: string;
  supplierPartyId: string | null;
  supplierName: string;
  purchaseReference: string;
  notes: string;
  status: AssetStatus;
  version: number;
  /** Zero throughout F1. Returned so a screen states it rather than assuming. */
  accountingActivityCount: number;
  policyEditable: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AssetWriteInput {
  /** Blank or omitted means "allocate one" — AST-0001, held server-side. */
  assetCode?: string | null;
  name: string;
  description?: string;
  categoryId: string;
  acquisitionDate: string;
  depreciationStartDate?: string | null;
  depreciationMethod?: string;
  usefulLifeMonths?: number | null;
  depreciationConvention?: string;
  residualValue?: string | null;
  quantity?: number;
  location?: string;
  custodian?: string;
  branch?: string;
  department?: string;
  supplierPartyId?: string | null;
  purchaseReference?: string;
  notes?: string;
}

export interface FixedAssetAuditEvent {
  id: string;
  action: string;
  previousVersion: number | null;
  resultingVersion: number | null;
  reason: string;
  detail: Record<string, unknown>;
  /** The server's, from the session. A client-supplied actor never reaches it. */
  actorName: string;
  occurredAt: string | null;
}

export interface RegisterByCategoryRow {
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  categoryStatus: CategoryStatus;
  draftAssets: number;
  archivedAssets: number;
  totalAssets: number;
  totalUnits: number;
  mappingComplete: boolean;
}

export interface ConfigurationIssue {
  subjectType: 'category' | 'asset';
  subjectId: string;
  code: string;
  name: string;
  issue: string;
  detail: string;
}

export interface RegisterReport {
  basis: 'register-master-data';
  /** Always false in F1, and typed so no screen can claim otherwise. */
  reconcilesToGeneralLedger: false;
  note: string;
  byCategory: RegisterByCategoryRow[];
  totals: {
    categories: number;
    activeCategories: number;
    archivedCategories: number;
    assets: number;
    draftAssets: number;
    archivedAssets: number;
    totalUnits: number;
  };
  configurationIssues: ConfigurationIssue[];
}

/**
 * What the server says this slice supports.
 *
 * Read rather than restated, so a screen cannot come to disagree with the API
 * about which workflows exist — and stays correct when F2 turns one on.
 */
export interface FixedAssetCapabilities {
  registerRecords: boolean;
  categories: boolean;
  accountMappings: boolean;
  archiveAndReactivate: boolean;
  auditHistory: boolean;

  acquisitionCost: boolean;
  capitalization: boolean;
  depreciationSchedules: boolean;
  depreciationPosting: boolean;
  depreciationPreview: boolean;
  impairment: boolean;
  revaluation: boolean;
  disposal: boolean;
  transfers: boolean;
  billAcquisition: boolean;
  componentAccounting: boolean;
  taxBooks: boolean;
  multipleBooks: boolean;
  attachments: boolean;
  foreignCurrency: boolean;

  usefulLifeUnit: string;
  supportedMethods: readonly string[];
  supportedConventions: readonly string[];

  deferred: Record<string, string>;
}

const query = (params: Record<string, string | number | boolean | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const fixedAssetCategoriesApi = {
  list: async (
    params: { status?: CategoryStatus; search?: string; limit?: number } = {},
  ): Promise<ServerAssetCategory[]> =>
    (await api.get<{ categories: ServerAssetCategory[] }>(
      `/api/fixed-assets/categories${query(params)}`,
    )).categories,

  get: async (id: string): Promise<ServerAssetCategory> =>
    (await api.get<{ category: ServerAssetCategory }>(
      `/api/fixed-assets/categories/${id}`,
    )).category,

  history: async (id: string): Promise<FixedAssetAuditEvent[]> =>
    (await api.get<{ events: FixedAssetAuditEvent[] }>(
      `/api/fixed-assets/categories/${id}/history`,
    )).events,

  create: async (input: CategoryWriteInput): Promise<ServerAssetCategory> =>
    (await api.post<{ category: ServerAssetCategory }>(
      '/api/fixed-assets/categories', input,
    )).category,

  update: async (
    id: string, expectedVersion: number, input: CategoryWriteInput,
  ): Promise<ServerAssetCategory> =>
    (await api.patch<{ category: ServerAssetCategory }>(
      `/api/fixed-assets/categories/${id}`, { ...input, expectedVersion },
    )).category,

  /** Archive or bring back. There is no delete: assets name a category. */
  setArchived: async (
    id: string, expectedVersion: number, archived: boolean,
  ): Promise<ServerAssetCategory> =>
    (await api.post<{ category: ServerAssetCategory }>(
      `/api/fixed-assets/categories/${id}/archive`, { expectedVersion, archived },
    )).category,
};

export const fixedAssetsApi = {
  list: async (
    params: { status?: AssetStatus; categoryId?: string; search?: string; limit?: number } = {},
  ): Promise<ServerFixedAsset[]> =>
    (await api.get<{ assets: ServerFixedAsset[] }>(
      `/api/fixed-assets/assets${query(params)}`,
    )).assets,

  get: async (id: string): Promise<ServerFixedAsset> =>
    (await api.get<{ asset: ServerFixedAsset }>(`/api/fixed-assets/assets/${id}`)).asset,

  history: async (id: string): Promise<FixedAssetAuditEvent[]> =>
    (await api.get<{ events: FixedAssetAuditEvent[] }>(
      `/api/fixed-assets/assets/${id}/history`,
    )).events,

  create: async (input: AssetWriteInput): Promise<ServerFixedAsset> =>
    (await api.post<{ asset: ServerFixedAsset }>('/api/fixed-assets/assets', input)).asset,

  update: async (
    id: string, expectedVersion: number, input: AssetWriteInput,
  ): Promise<ServerFixedAsset> =>
    (await api.patch<{ asset: ServerFixedAsset }>(
      `/api/fixed-assets/assets/${id}`, { ...input, expectedVersion },
    )).asset,

  /**
   * Archive or bring back — and NOT a disposal.
   *
   * Disposal derecognises a cost and posts a gain or loss. This takes the asset
   * out of the working list and changes nothing else.
   */
  setArchived: async (
    id: string, expectedVersion: number, archived: boolean, reason = '',
  ): Promise<ServerFixedAsset> =>
    (await api.post<{ asset: ServerFixedAsset }>(
      `/api/fixed-assets/assets/${id}/archive`, { expectedVersion, archived, reason },
    )).asset,

  registerReport: async (): Promise<RegisterReport> =>
    (await api.get<{ report: RegisterReport }>('/api/fixed-assets/reports/register')).report,

  capabilities: async (): Promise<FixedAssetCapabilities> =>
    (await api.get<{ capabilities: FixedAssetCapabilities }>(
      '/api/fixed-assets/capabilities',
    )).capabilities,
};
