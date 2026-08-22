import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronRight } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useIsPlatformAdmin } from '@/hooks/usePlatformRole';
import { cn } from '@/lib/utils';
import { filterNavigationByEntitlements, type NavItem } from '@/config/navigation';
import { useEffectiveModules } from '@/store/entitlementHooks';
import { useIsFreeDemo } from '@/hooks/useSession';
import { isFreeDemoView } from '@/config/freeDemo';
import {
  readExpandedSidebarGroups,
  sidebarPreferenceKey,
  writeExpandedSidebarGroups,
} from '@/lib/sidebarPreferences';

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const activeView = useStore((s) => s.activeView);
  const setActiveView = useStore((s) => s.setActiveView);
  const moduleIds = useEffectiveModules();
  // Backend-verified in production; locally simulated only in development.
  const isPlatformAdmin = useIsPlatformAdmin();
  const isDemo = useIsFreeDemo();
  const currentUserId = useAuthStore((s) => s.currentUserId);
  const organizationId = useOrganizationStore((s) => s.organization?.id ?? null);
  const groups = useMemo(() => {
    const entitled = filterNavigationByEntitlements(moduleIds);
    // Platform-super-admin-only items are hidden from regular subscribers, and a
    // Free Demo only lists the modules the demo is allowed to open.
    return entitled
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (i) => (!i.platformAdminOnly || (isPlatformAdmin && !isDemo)) && (!isDemo || isFreeDemoView(i.key)),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [moduleIds, isPlatformAdmin, isDemo]);
  const groupIds = useMemo(() => groups.map((group) => group.id), [groups]);
  const groupIdSignature = groupIds.join('|');
  const activeGroupId = groups.find((group) => group.items.some((item) => item.key === activeView))?.id;
  const preferenceKey = sidebarPreferenceKey(currentUserId, organizationId);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const saved = readExpandedSidebarGroups(preferenceKey, groupIds);
    if (activeGroupId) saved.add(activeGroupId);
    else if (groupIds[0]) saved.add(groupIds[0]);
    return saved;
  });
  const activeLinkRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const saved = readExpandedSidebarGroups(preferenceKey, groupIds);
    if (activeGroupId) saved.add(activeGroupId);
    else if (groupIds[0]) saved.add(groupIds[0]);
    setExpanded(saved);
  }, [preferenceKey, groupIdSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeGroupId) return;
    setExpanded((current) => {
      if (current.has(activeGroupId)) return current;
      const next = new Set(current).add(activeGroupId);
      writeExpandedSidebarGroups(preferenceKey, next);
      return next;
    });
  }, [activeGroupId, preferenceKey]);

  useEffect(() => {
    activeLinkRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeView, expanded]);

  const toggleGroup = (groupId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      writeExpandedSidebarGroups(preferenceKey, next);
      return next;
    });
  };

  return (
    <aside className="flex h-full w-[264px] flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      {/* Brand */}
      <div className="px-4 py-3">
        <div
          role="img"
          aria-label="Ledgora"
          className="h-11 w-full rounded-lg bg-white bg-center bg-no-repeat"
          style={{ backgroundImage: "url('/ledgora-logo.png')", backgroundSize: 'cover' }}
        />
        <p className="mt-1.5 px-1 text-[11px] text-slate-400">IFRS Accounting Suite</p>
      </div>

      <nav aria-label="Main navigation" className="min-w-0 flex-1 space-y-1 overflow-x-hidden overflow-y-auto px-3 pb-4">
        {groups.map((group) => {
          const open = expanded.has(group.id);
          const GroupIcon = group.icon;
          const regionId = `sidebar-group-${group.id}`;
          return (
          <div key={group.id}>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={regionId}
              onClick={() => toggleGroup(group.id)}
              className="focus-ring group flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800/70"
            >
              <GroupIcon className="h-[18px] w-[18px] shrink-0 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300" />
              <span className="min-w-0 flex-1 truncate">{group.label}</span>
              <ChevronRight className={cn('h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-90')} />
            </button>
            <div
              id={regionId}
              aria-hidden={!open}
              className={cn(
                'grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none',
                open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
              )}
            >
              <div className="min-h-0 overflow-hidden">
              <div className="space-y-0.5 pb-1 pl-3 pt-0.5">
              {group.items.map((item) => (
                <NavButton
                  key={item.key}
                  item={item}
                  active={activeView === item.key}
                  tabIndex={open ? 0 : -1}
                  buttonRef={activeView === item.key ? activeLinkRef : undefined}
                  onClick={() => {
                    setActiveView(item.key);
                    onNavigate?.();
                  }}
                />
              ))}
              </div>
              </div>
            </div>
          </div>
          );
        })}
      </nav>

      <div className="border-t border-slate-200 px-5 py-3 dark:border-slate-800">
        <p className="text-[10px] leading-relaxed text-slate-400">
          Internal management codes aligned with IFRS presentation principles — not official IFRS codes.
        </p>
      </div>
    </aside>
  );
}

function NavButton({
  item,
  active,
  onClick,
  buttonRef,
  tabIndex,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
  buttonRef?: RefObject<HTMLButtonElement>;
  tabIndex: number;
}) {
  const Icon = item.icon;
  return (
    <button
      ref={buttonRef}
      tabIndex={tabIndex}
      type="button"
      onClick={onClick}
      title={item.description}
      className={cn(
        'focus-ring group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-150',
        active
          ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-200'
          : item.comingSoon
            ? 'text-slate-400 hover:bg-slate-100 dark:text-slate-500 dark:hover:bg-slate-800/70'
            : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70',
      )}
    >
      <Icon
        className={cn(
          'h-[18px] w-[18px] shrink-0',
          active
            ? 'text-brand-600 dark:text-brand-300'
            : item.comingSoon
              ? 'text-slate-300 dark:text-slate-600'
              : 'text-slate-400 group-hover:text-slate-500 dark:group-hover:text-slate-300',
        )}
        strokeWidth={2}
      />
      <span className="flex-1 truncate">{item.label}</span>
      {item.comingSoon && (
        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400 dark:bg-slate-800 dark:text-slate-500">
          Soon
        </span>
      )}
      {active && !item.comingSoon && (
        <span className="h-1.5 w-1.5 rounded-full bg-brand-500 dark:bg-brand-400" />
      )}
    </button>
  );
}
