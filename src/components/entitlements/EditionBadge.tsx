import { Gem } from 'lucide-react';
import type { LedgoraEdition } from '@/types/entitlements';
import { Badge } from '@/components/ui/Badge';
import { EDITION_INFO } from '@/config/editionCommercialInfo';
import { useCurrentEdition } from '@/store/entitlementHooks';

/**
 * Small badge showing the active (or given) edition. Reads the store when no
 * edition is passed.
 */
export function EditionBadge({
  edition,
  showIcon = true,
}: {
  edition?: LedgoraEdition;
  showIcon?: boolean;
}) {
  const active = useCurrentEdition();
  const value = edition ?? active;
  const info = EDITION_INFO[value];
  return (
    <Badge tone={info?.tone ?? 'slate'} title={info?.tagline}>
      {showIcon && <Gem className="h-3 w-3" />}
      {info?.name ?? 'Ledgora'}
    </Badge>
  );
}
