import { useMemo } from 'react';
import { Lock } from 'lucide-react';
import type { LedgoraModule, ModuleCategory } from '@/types/entitlements';
import { MODULE_DEFINITIONS } from '@/config/modules';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useEffectiveModules } from '@/store/entitlementHooks';
import { getEditionModules } from '@/config/editions';
import { getDependentModules } from '@/lib/entitlementValidation';
import { Toggle } from '@/components/ui/Toggle';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';

const CATEGORY_LABELS: Record<ModuleCategory, string> = {
  core: 'Core',
  sales: 'Sales',
  purchases: 'Purchases',
  projects: 'Projects',
  construction: 'Construction',
  manufacturing: 'Manufacturing',
  reporting: 'Reporting',
  administration: 'Administration',
};

/**
 * Admin table listing every module, whether it is owned, and controls to enable
 * it as an add-on or disable it. Disabling a module only hides it and blocks new
 * activity — historical records are always preserved.
 */
export function ModuleEntitlementTable() {
  const edition = useEntitlementStore((s) => s.subscription.edition);
  const enabledModules = useEntitlementStore((s) => s.subscription.enabledModules);
  const disabledModules = useEntitlementStore((s) => s.subscription.disabledModules);
  const enableModule = useEntitlementStore((s) => s.enableModule);
  const disableModule = useEntitlementStore((s) => s.disableModule);
  const owned = useEffectiveModules();

  const presetSet = useMemo(() => new Set(getEditionModules(edition)), [edition]);
  const ownedSet = useMemo(() => new Set(owned), [owned]);
  const enabledSet = useMemo(() => new Set(enabledModules), [enabledModules]);
  const disabledSet = useMemo(() => new Set(disabledModules), [disabledModules]);

  const grouped = useMemo(() => {
    const map = new Map<ModuleCategory, typeof MODULE_DEFINITIONS>();
    for (const def of MODULE_DEFINITIONS) {
      if (!def.isVisibleInAdmin) continue;
      const list = map.get(def.category) ?? [];
      list.push(def);
      map.set(def.category, list);
    }
    return [...map.entries()];
  }, []);

  const onToggle = (id: LedgoraModule, next: boolean): void => {
    if (next) enableModule(id);
    else disableModule(id);
  };

  return (
    <div className="space-y-5">
      {grouped.map(([category, defs]) => (
        <div key={category}>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {CATEGORY_LABELS[category]}
          </p>
          <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
            {defs.map((def) => {
              const isOwned = ownedSet.has(def.id);
              const inPreset = presetSet.has(def.id);
              const isAddOn = enabledSet.has(def.id) && !inPreset;
              const isDisabled = disabledSet.has(def.id);
              const dependents = isOwned
                ? getDependentModules(def.id, owned)
                : [];
              return (
                <div
                  key={def.id}
                  className="flex items-center gap-3 border-b border-slate-100 px-3 py-2.5 last:border-0 dark:border-slate-800/70"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                        {def.name}
                      </span>
                      {inPreset && <Badge tone="slate">Edition</Badge>}
                      {isAddOn && <Badge tone="teal">Add-on</Badge>}
                      {isDisabled && <Badge tone="amber">Disabled</Badge>}
                    </div>
                    <p className="truncate text-[11px] text-slate-400">{def.description}</p>
                    {dependents.length > 0 && (
                      <p className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-400">
                        <Lock className="h-3 w-3" /> Required by {dependents.length} enabled module
                        {dependents.length === 1 ? '' : 's'}
                      </p>
                    )}
                  </div>
                  <span
                    className={cn(
                      'text-[10px] font-semibold uppercase',
                      isOwned ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400',
                    )}
                  >
                    {isOwned ? 'On' : 'Off'}
                  </span>
                  <Toggle
                    checked={isOwned}
                    onChange={(next) => onToggle(def.id, next)}
                    label={`Toggle ${def.name}`}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
