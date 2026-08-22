const PREFIX = 'ledgora:ui:sidebar-groups:v1';

export function sidebarPreferenceKey(userId: string | null, organizationId: string | null): string {
  return `${PREFIX}:${userId ?? 'anonymous'}:${organizationId ?? 'unscoped'}`;
}

export function readExpandedSidebarGroups(
  key: string,
  validGroupIds: readonly string[],
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    if (!Array.isArray(parsed)) return new Set();
    const valid = new Set(validGroupIds);
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && valid.has(id)));
  } catch {
    return new Set();
  }
}

export function writeExpandedSidebarGroups(
  key: string,
  expanded: ReadonlySet<string>,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try {
    storage.setItem(key, JSON.stringify([...expanded]));
  } catch {
    // UI preferences are best-effort; navigation remains usable without storage.
  }
}
