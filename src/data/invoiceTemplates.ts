import type {
  InvoiceColumnConfig,
  InvoiceContentConfig,
  InvoiceLayoutConfig,
  InvoiceMargins,
  InvoiceStyleConfig,
  InvoiceTemplate,
  InvoiceTemplateSection,
  InvoiceTemplateVersion,
  TextDirection,
} from '@/types/invoice';
import { DEFAULT_LOGO_CONFIG } from '@/lib/invoiceLogo';

export const DEFAULT_MARGINS: InvoiceMargins = { top: 48, right: 48, bottom: 48, left: 48 };

export const DEFAULT_COLUMNS: InvoiceColumnConfig[] = [
  { field: 'item', label: 'Item / service', visible: true, order: 1, align: 'left' },
  { field: 'description', label: 'Description', visible: true, order: 2, align: 'left' },
  { field: 'quantity', label: 'Qty', visible: true, order: 3, align: 'right' },
  { field: 'unit', label: 'Unit', visible: true, order: 4, align: 'left' },
  { field: 'unitPrice', label: 'Unit price', visible: true, order: 5, align: 'right' },
  { field: 'discount', label: 'Discount', visible: true, order: 6, align: 'right' },
  { field: 'taxRate', label: 'Tax %', visible: true, order: 7, align: 'right' },
  { field: 'taxAmount', label: 'Tax', visible: true, order: 8, align: 'right' },
  { field: 'lineTotal', label: 'Line total', visible: true, order: 9, align: 'right' },
];

export const DEFAULT_SECTIONS: InvoiceTemplateSection[] = [
  { kind: 'company', visible: true, order: 1 },
  { kind: 'invoiceDetails', visible: true, order: 2 },
  { kind: 'customer', visible: true, order: 3 },
  { kind: 'lineItems', visible: true, order: 4 },
  { kind: 'totals', visible: true, order: 5 },
  { kind: 'payment', visible: true, order: 6 },
  { kind: 'notes', visible: true, order: 7 },
  { kind: 'terms', visible: true, order: 8 },
  { kind: 'signature', visible: true, order: 9 },
  { kind: 'footer', visible: true, order: 10 },
];

export function makeDefaultLayoutConfig(overrides: Partial<InvoiceLayoutConfig> = {}): InvoiceLayoutConfig {
  return {
    pageSize: 'A4',
    orientation: 'portrait',
    margins: { ...DEFAULT_MARGINS },
    headerLayout: 'logo-left',
    sections: DEFAULT_SECTIONS.map((s) => ({ ...s })),
    lineItemColumns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
    ...overrides,
  };
}

export function makeDefaultStyleConfig(overrides: Partial<InvoiceStyleConfig> = {}): InvoiceStyleConfig {
  return {
    primaryColor: '#0f172a',
    secondaryColor: '#475569',
    textColor: '#0f172a',
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
    fontFamily: 'Inter, system-ui, sans-serif',
    baseFontSize: 13,
    tableStyle: 'minimal',
    borderRadius: 8,
    showTableGrid: false,
    ...overrides,
  };
}

export function makeDefaultContentConfig(direction: TextDirection = 'ltr', overrides: Partial<InvoiceContentConfig> = {}): InvoiceContentConfig {
  return {
    title: 'Invoice',
    customLabels: {},
    showLogo: true,
    logo: { ...DEFAULT_LOGO_CONFIG },
    showCompanyAddress: true,
    showCustomerAddress: true,
    showTaxDetails: true,
    showBankDetails: true,
    showSignature: true,
    showPaymentTerms: true,
    showNotes: true,
    showTerms: true,
    showQrCode: false,
    footerText: 'Thank you for your business.',
    language: direction === 'rtl' ? 'ar' : 'en',
    direction,
    ...overrides,
  };
}

/* ─────────────────────── Stable IDs for the seed set ─────────────────────── */

export const SYSTEM_TEMPLATE_ID = 'tmpl_system_standard';
export const SYSTEM_VERSION_ID = 'tmplv_system_standard_1';
export const BLUE_TEMPLATE_ID = 'tmpl_professional_blue';
export const BLUE_VERSION_1_ID = 'tmplv_blue_1';
export const BLUE_VERSION_2_ID = 'tmplv_blue_2';
export const ARABIC_TEMPLATE_ID = 'tmpl_arabic_tax';
export const ARABIC_VERSION_1_ID = 'tmplv_arabic_1';

const SEED_TIME = '2026-01-01T00:00:00.000Z';

export interface InvoiceTemplateSeed {
  templates: InvoiceTemplate[];
  versions: InvoiceTemplateVersion[];
}

/**
 * The built-in template set. "Standard Invoice" is the system default and can be
 * duplicated but never deleted; the others demonstrate versioning and RTL.
 * `entityId` is '' on the system default so it is a global fallback.
 */
export function buildSeedInvoiceTemplates(entityId = ''): InvoiceTemplateSeed {
  const templates: InvoiceTemplate[] = [
    {
      id: SYSTEM_TEMPLATE_ID, entityId: '', name: 'Standard Invoice', description: 'Clean built-in default.',
      isSystemDefault: true, isEntityDefault: false, isArchived: false, currentVersionId: SYSTEM_VERSION_ID,
      createdAt: SEED_TIME, updatedAt: SEED_TIME,
    },
    {
      id: BLUE_TEMPLATE_ID, entityId, name: 'Professional Blue', description: 'Branded blue header.',
      isSystemDefault: false, isEntityDefault: false, isArchived: false, currentVersionId: BLUE_VERSION_2_ID,
      createdAt: SEED_TIME, updatedAt: SEED_TIME,
    },
    {
      id: ARABIC_TEMPLATE_ID, entityId, name: 'Arabic Tax Invoice', description: 'Right-to-left tax invoice.',
      isSystemDefault: false, isEntityDefault: false, isArchived: false, currentVersionId: ARABIC_VERSION_1_ID,
      createdAt: SEED_TIME, updatedAt: SEED_TIME,
    },
  ];

  const versions: InvoiceTemplateVersion[] = [
    {
      id: SYSTEM_VERSION_ID, templateId: SYSTEM_TEMPLATE_ID, versionNumber: 1, status: 'published',
      layoutConfig: makeDefaultLayoutConfig(), styleConfig: makeDefaultStyleConfig(), contentConfig: makeDefaultContentConfig(),
      createdAt: SEED_TIME, publishedAt: SEED_TIME,
    },
    {
      id: BLUE_VERSION_1_ID, templateId: BLUE_TEMPLATE_ID, versionNumber: 1, status: 'published', versionLabel: 'Initial blue',
      layoutConfig: makeDefaultLayoutConfig({ headerLayout: 'logo-left' }),
      styleConfig: makeDefaultStyleConfig({ primaryColor: '#1d4ed8', secondaryColor: '#3b82f6', tableStyle: 'striped' }),
      contentConfig: makeDefaultContentConfig('ltr', { title: 'Invoice' }),
      createdAt: SEED_TIME, publishedAt: SEED_TIME,
    },
    {
      id: BLUE_VERSION_2_ID, templateId: BLUE_TEMPLATE_ID, versionNumber: 2, status: 'published', versionLabel: 'Refined header',
      layoutConfig: makeDefaultLayoutConfig({ headerLayout: 'logo-left' }),
      styleConfig: makeDefaultStyleConfig({ primaryColor: '#1e40af', secondaryColor: '#60a5fa', tableStyle: 'modern', borderRadius: 12 }),
      contentConfig: makeDefaultContentConfig('ltr', { title: 'Tax Invoice' }),
      createdAt: SEED_TIME, publishedAt: SEED_TIME,
    },
    {
      id: ARABIC_VERSION_1_ID, templateId: ARABIC_TEMPLATE_ID, versionNumber: 1, status: 'published',
      layoutConfig: makeDefaultLayoutConfig({ headerLayout: 'logo-right' }),
      styleConfig: makeDefaultStyleConfig({ primaryColor: '#065f46', secondaryColor: '#059669', tableStyle: 'bordered' }),
      contentConfig: makeDefaultContentConfig('rtl', {
        title: 'فاتورة ضريبية',
        customLabels: {
          invoiceNumber: 'رقم الفاتورة', issueDate: 'تاريخ الإصدار', dueDate: 'تاريخ الاستحقاق',
          billTo: 'فاتورة إلى', description: 'الوصف', quantity: 'الكمية', unitPrice: 'سعر الوحدة',
          tax: 'الضريبة', total: 'الإجمالي', balanceDue: 'المبلغ المستحق', subtotal: 'المجموع الفرعي',
        },
        footerText: 'شكراً لتعاملكم معنا.',
      }),
      createdAt: SEED_TIME, publishedAt: SEED_TIME,
    },
  ];

  return { templates, versions };
}
