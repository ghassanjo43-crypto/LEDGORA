import type { InvoiceContentConfig, InvoiceLogoConfig, InvoiceTemplateSnapshot, LogoPosition } from '@/types/invoice';
import { resolveAssetUrl } from '@/lib/assetUrl';

export const MAX_LOGO_BYTES = 1 * 1024 * 1024; // 1 MB
export const ACCEPTED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const LOGO_ACCEPT_ATTR = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';

export const DEFAULT_LOGO_CONFIG: InvoiceLogoConfig = {
  mode: 'entity-default',
  fit: 'contain',
  position: 'top-left',
  maxWidth: 160,
  maxHeight: 80,
};

/** Named width presets for the size control. "custom" keeps whatever maxWidth is set. */
export const LOGO_SIZE_PRESETS: { id: 'small' | 'medium' | 'large'; label: string; maxWidth: number; maxHeight: number }[] = [
  { id: 'small', label: 'Small', maxWidth: 110, maxHeight: 56 },
  { id: 'medium', label: 'Medium', maxWidth: 160, maxHeight: 80 },
  { id: 'large', label: 'Large', maxWidth: 220, maxHeight: 110 },
];

export function logoConfigOf(content: InvoiceContentConfig): InvoiceLogoConfig {
  return content.logo ?? DEFAULT_LOGO_CONFIG;
}

/**
 * Resolve the effective logo image URL for a template version, given the
 * company default. Custom → the uploaded data URL; entity-default → the company
 * logo; hidden → none. Used both when building a snapshot and for live preview.
 */
export function resolveTemplateLogoUrl(content: InvoiceContentConfig, companyDefaultLogoUrl?: string): string | undefined {
  const cfg = logoConfigOf(content);
  if (cfg.mode === 'hidden') return undefined;
  if (cfg.mode === 'custom') return sanitizeStoredLogo(cfg.customLogoUrl) || undefined;
  return sanitizeStoredLogo(companyDefaultLogoUrl) || undefined;
}

function toPlainPosition(p: LogoPosition): 'left' | 'center' | 'right' {
  return p === 'top-right' ? 'right' : p === 'top-center' ? 'center' : 'left';
}

export interface ResolvedLogo {
  /** Ready-to-render `src` (resolved data/http URL), or null when no logo should show. */
  url: string | null;
  width: number;
  position: 'left' | 'center' | 'right';
  /** objectFit for the <img> (never stretches). */
  fit: 'contain' | 'cover';
  maxHeight: number;
  visible: boolean;
}

/**
 * THE single logo resolver for every render surface (template preview, invoice
 * editor preview, printed invoice, PDF, issued-invoice view). It reads the
 * FROZEN, already-resolved logo from the snapshot's company block, sanitises it
 * (dropping any legacy `blob:`/path value), and returns everything the renderer
 * needs. Do not re-implement logo selection in components.
 */
export function resolveInvoiceLogo(snapshot: Pick<InvoiceTemplateSnapshot, 'contentConfig' | 'companySnapshot'>): ResolvedLogo {
  const cfg = logoConfigOf(snapshot.contentConfig);
  const base = { width: cfg.maxWidth || 160, position: toPlainPosition(cfg.position), fit: cfg.fit, maxHeight: cfg.maxHeight || 90 };
  if (cfg.mode === 'hidden') return { ...base, url: null, visible: false };
  const clean = sanitizeStoredLogo(snapshot.companySnapshot.logoUrl);
  const url = clean ? resolveAssetUrl(clean) : '';
  return url ? { ...base, url, visible: true } : { ...base, url: null, visible: false };
}

export interface LogoValidation {
  ok: boolean;
  error?: string;
}

/** Validate a chosen file: type + size (readability/resolution checked on load). */
export function validateLogoFile(file: File): LogoValidation {
  const type = file.type || guessType(file.name);
  if (!ACCEPTED_LOGO_TYPES.includes(type)) {
    return { ok: false, error: 'Unsupported file — upload a PNG, JPG or WebP image.' };
  }
  if (file.size > MAX_LOGO_BYTES) {
    return { ok: false, error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the maximum is 1 MB.` };
  }
  if (file.size === 0) return { ok: false, error: 'The file appears to be empty.' };
  return { ok: true };
}

function guessType(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.webp')) return 'image/webp';
  return '';
}

/**
 * A stored logo is only valid if it is a persistent data URL (or absolute http
 * URL). Anything else — a `blob:` URL, a `File`, or a local path — cannot survive
 * a refresh and is treated as "no logo". Legacy `blob:` values are dropped here.
 */
export function sanitizeStoredLogo(url?: string | null): string {
  if (!url) return '';
  if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://')) return url;
  return '';
}
export function isPersistentLogo(url?: string | null): boolean {
  return sanitizeStoredLogo(url) !== '';
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

/** Load a data URL to confirm it decodes and read its natural dimensions. */
export function measureImage(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    // SVG has no intrinsic raster size — accept it without measuring.
    if (dataUrl.startsWith('data:image/svg+xml')) { resolve({ width: 0, height: 0 }); return; }
    if (typeof Image === 'undefined') { resolve({ width: 0, height: 0 }); return; }
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('The image could not be read — it may be corrupt.'));
    img.src = dataUrl;
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be read — it may be corrupt.'));
    img.src = dataUrl;
  });
}

/** Recommended maximum stored logo dimensions (per the spec: 800 × 300). */
export const LOGO_STORE_MAX = { width: 800, height: 300 };
/** Cap on the stored data-URL length to stay comfortably inside LocalStorage. */
const MAX_STORED_DATA_URL = 600_000; // ~0.6 MB of string

/**
 * Downscale + re-encode a raster logo so the PERSISTED data URL is small enough
 * for LocalStorage. Preserves aspect ratio; keeps PNG transparency, but falls
 * back to JPEG when that yields a materially smaller image. SVGs (vector, tiny)
 * and non-browser contexts are returned unchanged.
 */
export async function compressImageDataUrl(
  dataUrl: string,
  opts: { maxWidth?: number; maxHeight?: number } = {},
): Promise<string> {
  if (dataUrl.startsWith('data:image/svg+xml')) return dataUrl;
  if (typeof document === 'undefined' || typeof Image === 'undefined') return dataUrl;

  const img = await loadImage(dataUrl);
  const maxW = opts.maxWidth ?? LOGO_STORE_MAX.width;
  const maxH = opts.maxHeight ?? LOGO_STORE_MAX.height;
  const natW = img.naturalWidth || maxW;
  const natH = img.naturalHeight || maxH;
  const scale = Math.min(1, maxW / natW, maxH / natH);
  const w = Math.max(1, Math.round(natW * scale));
  const h = Math.max(1, Math.round(natH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl; // no canvas support → keep original
  ctx.drawImage(img, 0, 0, w, h);

  let out = canvas.toDataURL('image/png');
  if (out.length > MAX_STORED_DATA_URL) {
    // Try progressively stronger JPEG compression to fit the budget.
    for (const q of [0.85, 0.7, 0.55]) {
      const jpeg = canvas.toDataURL('image/jpeg', q);
      if (jpeg.length < out.length) out = jpeg;
      if (out.length <= MAX_STORED_DATA_URL) break;
    }
  }
  return out;
}
