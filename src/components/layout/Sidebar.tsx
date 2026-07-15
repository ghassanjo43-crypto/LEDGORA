import { useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { cn } from '@/lib/utils';
import { filterNavigationByEntitlements, type NavItem } from '@/config/navigation';
import { useEffectiveModules } from '@/store/entitlementHooks';

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const activeView = useStore((s) => s.activeView);
  const setActiveView = useStore((s) => s.setActiveView);
  const moduleIds = useEffectiveModules();
  const groups = useMemo(() => filterNavigationByEntitlements(moduleIds), [moduleIds]);

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

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {groups.map((group) => (
          <div key={group.id}>
            <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400 dark:text-slate-500">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavButton
                  key={item.key}
                  item={item}
                  active={activeView === item.key}
                  onClick={() => {
                    setActiveView(item.key);
                    onNavigate?.();
                  }}
                />
              ))}
            </div>
          </div>
        ))}
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
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
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
