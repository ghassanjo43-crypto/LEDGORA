import { useEffect, useState, type CSSProperties } from 'react';
import { resolveAssetUrl } from '@/lib/assetUrl';

interface Props {
  url?: string;
  alt: string;
  style?: CSSProperties;
  className?: string;
}

/**
 * Renders an invoice/company logo from a stored URL, resolving relative paths
 * via {@link resolveAssetUrl}. If the image fails to load (stale path, missing
 * asset) it renders NOTHING rather than a broken-image icon.
 */
export function LogoImage({ url, alt, style, className }: Props) {
  const src = resolveAssetUrl(url);
  const [failed, setFailed] = useState(false);

  // Reset the error state whenever the source changes (e.g. logo replaced).
  useEffect(() => setFailed(false), [src]);

  if (!src || failed) return null;
  return <img src={src} alt={alt} className={className} style={style} onError={() => setFailed(true)} />;
}
