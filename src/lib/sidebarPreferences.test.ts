import { describe, expect, it } from 'vitest';
import {
  readExpandedSidebarGroups,
  sidebarPreferenceKey,
  writeExpandedSidebarGroups,
} from './sidebarPreferences';

describe('sidebar group preferences', () => {
  it('scopes preferences by user and organization', () => {
    expect(sidebarPreferenceKey('user-a', 'org-a')).not.toBe(sidebarPreferenceKey('user-b', 'org-a'));
    expect(sidebarPreferenceKey('user-a', 'org-a')).not.toBe(sidebarPreferenceKey('user-a', 'org-b'));
  });

  it('round-trips expanded groups and ignores obsolete ids', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    writeExpandedSidebarGroups('key', new Set(['accounting', 'removed-group']), storage);

    expect([...readExpandedSidebarGroups('key', ['accounting', 'sales'], storage)]).toEqual(['accounting']);
  });

  it('fails safely for malformed persisted data', () => {
    expect([...readExpandedSidebarGroups('key', ['accounting'], { getItem: () => '{bad' })]).toEqual([]);
  });
});
