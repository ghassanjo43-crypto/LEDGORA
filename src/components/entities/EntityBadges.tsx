import type { EntityType } from '@/types';
import { Badge } from '@/components/ui/Badge';
import { ENTITY_TYPE_META } from '@/data/entityOptions';

export function EntityTypeBadge({ type }: { type: EntityType }) {
  const meta = ENTITY_TYPE_META[type];
  return (
    <Badge tone={meta.tone} title={meta.label}>
      {meta.short}
    </Badge>
  );
}

export function EntityStatusBadge({ isActive }: { isActive: boolean }) {
  return isActive ? <Badge tone="green">Active</Badge> : <Badge tone="red">Inactive</Badge>;
}
