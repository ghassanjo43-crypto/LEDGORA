import { describe, it, expect } from 'vitest';
import type { InvoiceContentConfig } from '@/types/invoice';
import { resolveTemplateLogoUrl, resolveInvoiceLogo, sanitizeStoredLogo, isPersistentLogo, validateLogoFile, compressImageDataUrl, DEFAULT_LOGO_CONFIG } from './invoiceLogo';
import { createInvoiceTemplateSnapshot } from './invoiceTemplates';
import { buildSeedInvoiceTemplates, BLUE_TEMPLATE_ID, BLUE_VERSION_2_ID } from '@/data/invoiceTemplates';

const baseContent = (): InvoiceContentConfig => ({
  title: 'Invoice', customLabels: {}, showLogo: true, logo: { ...DEFAULT_LOGO_CONFIG },
  showCompanyAddress: true, showCustomerAddress: true, showTaxDetails: true, showBankDetails: true,
  showSignature: true, showPaymentTerms: true, showNotes: true, showTerms: true, showQrCode: false,
  language: 'en', direction: 'ltr',
});

const CUSTOM = 'data:image/png;base64,AAAA';
const COMPANY = 'data:image/png;base64,BBBB';

describe('resolveTemplateLogoUrl', () => {
  it('custom mode uses the uploaded data URL', () => {
    const content = { ...baseContent(), logo: { ...DEFAULT_LOGO_CONFIG, mode: 'custom' as const, customLogoUrl: CUSTOM } };
    expect(resolveTemplateLogoUrl(content, COMPANY)).toBe(CUSTOM);
  });
  it('entity-default mode uses the company logo', () => {
    expect(resolveTemplateLogoUrl(baseContent(), COMPANY)).toBe(COMPANY);
  });
  it('hidden mode resolves to no logo', () => {
    const content = { ...baseContent(), logo: { ...DEFAULT_LOGO_CONFIG, mode: 'hidden' as const } };
    expect(resolveTemplateLogoUrl(content, COMPANY)).toBeUndefined();
  });
});

describe('snapshot freezes the effective logo', () => {
  const seed = buildSeedInvoiceTemplates('ent1');
  const template = seed.templates.find((t) => t.id === BLUE_TEMPLATE_ID)!;
  const version = { ...seed.versions.find((v) => v.id === BLUE_VERSION_2_ID)!, contentConfig: { ...baseContent(), logo: { ...DEFAULT_LOGO_CONFIG, mode: 'custom' as const, customLogoUrl: CUSTOM } } };

  it('captures the custom template logo into the company snapshot', () => {
    const snap = createInvoiceTemplateSnapshot(template, version, { legalName: 'Acme', logoUrl: COMPANY }, { name: 'Cust' });
    expect(snap.companySnapshot.logoUrl).toBe(CUSTOM); // custom overrides the company default
  });

  it('a later template logo change does not alter the already-issued snapshot', () => {
    const snap = createInvoiceTemplateSnapshot(template, version, { legalName: 'Acme', logoUrl: COMPANY }, { name: 'Cust' });
    // mutate the live version's logo afterwards
    version.contentConfig.logo!.customLogoUrl = 'data:image/png;base64,ZZZZ';
    // the frozen image lives on the company snapshot (stored once)…
    expect(snap.companySnapshot.logoUrl).toBe(CUSTOM);
    // …and the duplicate is stripped from the content copy to save space
    expect(snap.contentConfig.logo!.customLogoUrl).toBeUndefined();
    expect(snap.contentConfig.logo!.position).toBe('top-left'); // other config still frozen
  });

  it('entity-default logo is captured from the company default at issue time', () => {
    const v2 = { ...version, contentConfig: baseContent() };
    const snap = createInvoiceTemplateSnapshot(template, v2, { legalName: 'Acme', logoUrl: COMPANY }, { name: 'Cust' });
    expect(snap.companySnapshot.logoUrl).toBe(COMPANY);
  });
});

describe('compressImageDataUrl', () => {
  it('returns SVG data URLs unchanged (already small vector)', async () => {
    const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
    expect(await compressImageDataUrl(svg)).toBe(svg);
  });
  it('is a safe no-op without a canvas (SSR/node) — never throws', async () => {
    const png = 'data:image/png;base64,AAAA';
    expect(await compressImageDataUrl(png)).toBe(png);
  });
});

describe('validateLogoFile (PNG / JPEG / WebP · max 1 MB)', () => {
  it('accepts a small PNG', () => {
    expect(validateLogoFile(new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' })).ok).toBe(true);
  });
  it('accepts JPEG and WebP', () => {
    expect(validateLogoFile(new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' })).ok).toBe(true);
    expect(validateLogoFile(new File([new Uint8Array([1])], 'a.webp', { type: 'image/webp' })).ok).toBe(true);
  });
  it('rejects SVG and other unsupported types', () => {
    expect(validateLogoFile(new File([new Uint8Array([1])], 'a.svg', { type: 'image/svg+xml' })).ok).toBe(false);
    expect(validateLogoFile(new File([new Uint8Array([1])], 'a.gif', { type: 'image/gif' })).ok).toBe(false);
  });
  it('rejects a file over 1 MB', () => {
    expect(validateLogoFile(new File([new Uint8Array(1024 * 1024 + 1)], 'big.png', { type: 'image/png' })).ok).toBe(false);
  });
});

describe('sanitizeStoredLogo (drops blob:/paths/File values)', () => {
  it('keeps data and http(s) URLs', () => {
    expect(sanitizeStoredLogo('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(sanitizeStoredLogo('https://cdn/x.png')).toBe('https://cdn/x.png');
  });
  it('rejects blob URLs and local paths', () => {
    expect(sanitizeStoredLogo('blob:http://localhost/abc')).toBe('');
    expect(sanitizeStoredLogo('/uploads/logo.png')).toBe('');
    expect(sanitizeStoredLogo('C:\\Users\\me\\logo.png')).toBe('');
    expect(isPersistentLogo('blob:xyz')).toBe(false);
    expect(isPersistentLogo('data:image/png;base64,AAAA')).toBe(true);
  });
});

describe('resolveInvoiceLogo (the one shared render resolver)', () => {
  const seed = buildSeedInvoiceTemplates('ent1');
  const template = seed.templates.find((t) => t.id === BLUE_TEMPLATE_ID)!;
  const version = seed.versions.find((v) => v.id === BLUE_VERSION_2_ID)!;
  const snap = (logoOver: Partial<typeof DEFAULT_LOGO_CONFIG>, companyLogo?: string) =>
    createInvoiceTemplateSnapshot(
      template,
      { ...version, contentConfig: { ...baseContent(), logo: { ...DEFAULT_LOGO_CONFIG, ...logoOver } } },
      { legalName: 'Acme', logoUrl: companyLogo },
      { name: 'C' },
    );

  it('custom logo → visible with its data URL, mapped position', () => {
    const r = resolveInvoiceLogo(snap({ mode: 'custom', customLogoUrl: CUSTOM, position: 'top-right' }, COMPANY));
    expect(r).toMatchObject({ url: CUSTOM, visible: true, position: 'right' });
  });
  it('entity-default → the company logo', () => {
    expect(resolveInvoiceLogo(snap({ mode: 'entity-default' }, COMPANY)).url).toBe(COMPANY);
  });
  it('hidden → nothing (no broken image)', () => {
    expect(resolveInvoiceLogo(snap({ mode: 'hidden' }, COMPANY))).toMatchObject({ url: null, visible: false });
  });
  it('no company logo → falls back to nothing (not a broken icon)', () => {
    expect(resolveInvoiceLogo(snap({ mode: 'entity-default' }))).toMatchObject({ url: null, visible: false });
  });
  it('a legacy blob company logo is dropped → renders nothing', () => {
    expect(resolveInvoiceLogo(snap({ mode: 'entity-default' }, 'blob:http://x/y')).visible).toBe(false);
  });
});
