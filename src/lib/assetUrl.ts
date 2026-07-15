/**
 * Resolve a stored asset reference (e.g. an invoice logo) to a usable `src`.
 *
 * - Absolute URLs (`http://`, `https://`) and inline `data:` URLs are returned
 *   unchanged — this is what the LocalStorage MVP stores (a persistent base64
 *   data URL), so it works with no backend.
 * - A relative path such as `/uploads/invoice-logos/logo.png` (returned by a
 *   future file-upload backend) is prefixed with `VITE_API_URL` so it points at
 *   the API host.
 *
 * Never returns a broken value: an empty/undefined input yields `''`, which
 * callers treat as "no logo".
 */
export function resolveAssetUrl(url?: string | null): string {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:') || url.startsWith('blob:')) {
    return url;
  }
  const env = (import.meta.env ?? {}) as Record<string, string | undefined>;
  const base = env.VITE_API_URL ?? '';
  // Avoid a double slash when both base ends and path starts with "/".
  if (base.endsWith('/') && url.startsWith('/')) return `${base.slice(0, -1)}${url}`;
  return `${base}${url}`;
}
