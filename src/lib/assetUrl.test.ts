import { describe, it, expect } from 'vitest';
import { resolveAssetUrl } from './assetUrl';

describe('resolveAssetUrl', () => {
  it('returns "" for empty/undefined (treated as no logo)', () => {
    expect(resolveAssetUrl()).toBe('');
    expect(resolveAssetUrl('')).toBe('');
    expect(resolveAssetUrl(null)).toBe('');
  });
  it('passes through data URLs unchanged (the LocalStorage MVP format)', () => {
    const d = 'data:image/png;base64,AAAA';
    expect(resolveAssetUrl(d)).toBe(d);
  });
  it('passes through absolute http/https URLs unchanged', () => {
    expect(resolveAssetUrl('https://cdn.example/logo.png')).toBe('https://cdn.example/logo.png');
    expect(resolveAssetUrl('http://x/y.png')).toBe('http://x/y.png');
  });
  it('prefixes a relative /uploads path with VITE_API_URL (empty base in tests → unchanged)', () => {
    // With no VITE_API_URL configured, the relative path is returned as-is.
    expect(resolveAssetUrl('/uploads/invoice-logos/logo.png')).toBe('/uploads/invoice-logos/logo.png');
  });
});
