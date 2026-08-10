/**
 * The permission matrix: modules as rows, actions as columns.
 *
 * ── What the operator has to be able to tell apart ───────────────────────────
 * Five states, and collapsing any two of them makes the editor lie:
 *
 *   inherited   the role template grants it — changing the ROLE changes this
 *   granted     given to this person specifically, on top of their role
 *   denied      taken away from this person specifically, despite their role
 *   blocked     configured, but the tenant's package does not include the module
 *   unset       neither the role nor an override says anything
 *
 * `blocked` is the one that matters most and is easiest to get wrong. A cell
 * whose module was withdrawn by a downgrade is NOT unset: the configuration is
 * intact in the database and returns the moment the package is restored. Showing
 * it as empty would tell the operator their work was destroyed, and invite them
 * to redo it.
 *
 * ── This component is not a security boundary ────────────────────────────────
 * Every cell here is a courtesy. The server resolves the same precedence rule on
 * every request and refuses what it refuses regardless of what was rendered — so
 * a disabled checkbox is an explanation, never a control. That is why blocked
 * cells are still SHOWN with their configuration rather than hidden: hiding them
 * would remove information without adding any safety.
 *
 * ── Where the rows come from ─────────────────────────────────────────────────
 * The catalogue is fetched from the backend. This file contains no list of
 * modules and no list of actions — a second copy would drift from the resolver,
 * and an editor that disagrees with the thing enforcing the rules is worse than
 * no editor.
 */
import { Fragment, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import type {
  EffectivePermissions,
  PermissionCatalog,
  PermissionChange,
  ResolvedPermission,
} from '@/services/api/permissionsApi';

/** What one cell is showing. */
export type CellState = 'inherited' | 'granted' | 'denied' | 'blocked' | 'unset';

export function cellState(resolved: ResolvedPermission | undefined): CellState {
  if (!resolved) return 'unset';
  // The package refusal wins the DISPLAY, exactly as it wins the resolution —
  // and it is shown whether the underlying configuration was a grant, a denial
  // or the role, because in every case the answer is "not while the package
  // says otherwise".
  if (resolved.blockedByEntitlement || resolved.source === 'not_entitled') return 'blocked';
  if (resolved.source === 'subscription_inactive') return 'blocked';
  if (resolved.override === 'deny') return 'denied';
  if (resolved.override === 'grant') return 'granted';
  if (resolved.inRoleTemplate) return 'inherited';
  return 'unset';
}

/** The next effect when the operator clicks a cell: unset → grant → deny → unset. */
function nextEffect(current: 'grant' | 'deny' | null): PermissionChange['effect'] {
  if (current === null) return 'grant';
  if (current === 'grant') return 'deny';
  return 'inherit';
}

const CELL_STYLES: Record<CellState, string> = {
  inherited: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  granted: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300',
  denied: 'bg-red-100 text-red-800 ring-1 ring-red-500/40 dark:bg-red-500/15 dark:text-red-300',
  blocked: 'bg-amber-50 text-amber-700 ring-1 ring-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  unset: 'bg-transparent text-slate-300 dark:text-slate-600',
};

const CELL_GLYPH: Record<CellState, string> = {
  inherited: '✓',
  granted: '✓',
  denied: '✕',
  blocked: '⃠',
  unset: '·',
};

const CELL_TITLE: Record<CellState, string> = {
  inherited: 'Inherited from the role',
  granted: 'Granted specifically to this user',
  denied: 'Denied specifically to this user',
  blocked: "Unavailable — the organization's subscription does not include this module. The configuration is preserved and returns if the package is restored.",
  unset: 'Not granted',
};

export interface PermissionMatrixEditorProps {
  catalog: PermissionCatalog;
  effective: EffectivePermissions;
  /** Pending, unsaved changes, keyed `subject:action`. */
  pending: Map<string, PermissionChange['effect']>;
  onChange: (next: Map<string, PermissionChange['effect']>) => void;
  /** False for a viewer without `manage_users` — the matrix becomes read-only. */
  editable?: boolean;
}

const key = (subject: string, action: string): string => `${subject}:${action}`;

export function PermissionMatrixEditor({
  catalog,
  effective,
  pending,
  onChange,
  editable = true,
}: PermissionMatrixEditorProps) {
  const [showBlocked, setShowBlocked] = useState(true);

  const resolved = useMemo(
    () => new Map(effective.permissions.map((p) => [key(p.subject, p.action), p])),
    [effective.permissions],
  );

  /** The tenant's entitled modules, for the row-level explanation. */
  const entitled = useMemo(() => new Set(effective.subscription.modules), [effective.subscription.modules]);

  const subjectBlocked = (requiredModule: string | null): boolean => {
    if (!effective.subscription.active) return true;
    return requiredModule !== null && !entitled.has(requiredModule);
  };

  const groups = useMemo(() => {
    const out = new Map<string, PermissionCatalog['subjects']>();
    for (const subject of catalog.subjects) {
      if (!showBlocked && subjectBlocked(subject.requiredModule)) continue;
      const list = out.get(subject.group) ?? [];
      list.push(subject);
      out.set(subject.group, list);
    }
    return [...out.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.subjects, showBlocked, entitled, effective.subscription.active]);

  /**
   * The effect currently in force for a cell — a pending edit if there is one,
   * otherwise the stored override. Pending edits are held here and applied in
   * one request, so a half-finished matrix is never persisted.
   */
  const effectFor = (subject: string, action: string): 'grant' | 'deny' | null => {
    const pendingEffect = pending.get(key(subject, action));
    if (pendingEffect !== undefined) return pendingEffect === 'inherit' ? null : pendingEffect;
    return resolved.get(key(subject, action))?.override ?? null;
  };

  const stateFor = (subject: string, action: string): CellState => {
    const cell = resolved.get(key(subject, action));
    if (!cell) return 'unset';
    if (cell.blockedByEntitlement || cell.source === 'not_entitled' || cell.source === 'subscription_inactive') {
      return 'blocked';
    }
    const current = effectFor(subject, action);
    if (current === 'deny') return 'denied';
    if (current === 'grant') return 'granted';
    return cell.inRoleTemplate ? 'inherited' : 'unset';
  };

  const setCell = (subject: string, action: string, effect: PermissionChange['effect']): void => {
    const next = new Map(pending);
    const stored = resolved.get(key(subject, action))?.override ?? null;
    const storedAsEffect: PermissionChange['effect'] = stored ?? 'inherit';
    // Returning a cell to its stored value clears the pending edit rather than
    // recording a no-op — so "unsaved changes" means what it says.
    if (effect === storedAsEffect) next.delete(key(subject, action));
    else next.set(key(subject, action), effect);
    onChange(next);
  };

  const toggleCell = (subject: string, action: string): void => {
    if (!editable) return;
    setCell(subject, action, nextEffect(effectFor(subject, action)));
  };

  /**
   * Grant every action in a row that the package actually permits.
   *
   * Deliberately skips blocked cells rather than writing grants that could never
   * take effect — a "select all" that silently configures the unreachable is how
   * an operator comes to believe someone has access they do not.
   */
  const selectRow = (subjectId: string, actions: string[], requiredModule: string | null): void => {
    if (!editable || subjectBlocked(requiredModule)) return;
    const next = new Map(pending);
    for (const action of actions) {
      const stored = resolved.get(key(subjectId, action))?.override ?? null;
      if (stored === 'grant') next.delete(key(subjectId, action));
      else next.set(key(subjectId, action), 'grant');
    }
    onChange(next);
  };

  const clearRow = (subjectId: string, actions: string[]): void => {
    if (!editable) return;
    const next = new Map(pending);
    for (const action of actions) {
      const stored = resolved.get(key(subjectId, action))?.override ?? null;
      if (stored === null) next.delete(key(subjectId, action));
      else next.set(key(subjectId, action), 'inherit');
    }
    onChange(next);
  };

  const blockedCount = catalog.subjects.filter((s) => subjectBlocked(s.requiredModule)).length;

  return (
    <div className="space-y-4">
      {/* ── What the tenant has bought ──────────────────────────────────── */}
      {!effective.subscription.active && (
        <Alert variant="warning" title="No active subscription">
          This organization has no live subscription, so no permission is currently in force. The configuration
          below is preserved and takes effect again as soon as the subscription is restored.
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-slate-500 dark:text-slate-400">
            Role:{' '}
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {catalog.roles.find((r) => r.id === effective.role)?.label ?? effective.role ?? 'No membership'}
            </span>
          </span>
          <span className="text-slate-500 dark:text-slate-400">
            Package:{' '}
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {effective.subscription.planName ?? effective.subscription.planCode ?? 'None'}
            </span>
          </span>
        </div>
        {blockedCount > 0 && (
          <label className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
            <input
              type="checkbox"
              checked={showBlocked}
              onChange={(e) => setShowBlocked(e.target.checked)}
              className="rounded border-slate-300"
            />
            Show {blockedCount} module{blockedCount === 1 ? '' : 's'} not in the package
          </label>
        )}
      </div>

      {/* ── Legend ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 text-[11px]">
        {(['inherited', 'granted', 'denied', 'blocked', 'unset'] as CellState[]).map((state) => (
          <span key={state} className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                'inline-flex h-5 w-5 items-center justify-center rounded text-xs font-semibold',
                CELL_STYLES[state],
              )}
            >
              {CELL_GLYPH[state]}
            </span>
            <span className="capitalize text-slate-600 dark:text-slate-300">
              {state === 'blocked' ? 'Not in package' : state}
            </span>
          </span>
        ))}
      </div>

      {/* ── The matrix ──────────────────────────────────────────────────── */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
            <tr>
              <th className="sticky left-0 z-10 min-w-[200px] bg-slate-50 px-3 py-2 text-left font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                Module
              </th>
              {catalog.actions.map((action) => (
                <th
                  key={action.id}
                  className="px-1 py-2 text-center font-medium text-slate-500 dark:text-slate-400"
                  title={action.label}
                >
                  <span className="block max-w-[52px] truncate">{action.label}</span>
                </th>
              ))}
              {editable && <th className="px-2 py-2 text-right font-medium text-slate-500">Row</th>}
            </tr>
          </thead>
          <tbody>
            {groups.map(([group, subjects]) => (
              // Keyed on the fragment, not the first child: a group is one list
              // item made of several rows, and React reconciles it as such.
              <Fragment key={group}>
                <tr>
                  <td
                    colSpan={catalog.actions.length + (editable ? 2 : 1)}
                    className="bg-slate-100/70 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400"
                  >
                    {group}
                  </td>
                </tr>
                {subjects.map((subject) => {
                  const blocked = subjectBlocked(subject.requiredModule);
                  return (
                    <tr
                      key={subject.id}
                      className="border-t border-slate-100 dark:border-slate-800"
                      data-testid={`permission-row-${subject.id}`}
                    >
                      <td className="sticky left-0 z-10 bg-white px-3 py-1.5 dark:bg-slate-900">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              'font-medium',
                              blocked ? 'text-slate-400 dark:text-slate-500' : 'text-slate-700 dark:text-slate-200',
                            )}
                            title={subject.description}
                          >
                            {subject.label}
                          </span>
                          {blocked && (
                            <Badge tone="amber" title="Not included in this organization's package">
                              not in package
                            </Badge>
                          )}
                          {subject.scope === 'administration' && (
                            <Badge tone="violet" title="Governance of this organization only — never cross-tenant">
                              admin
                            </Badge>
                          )}
                        </div>
                      </td>

                      {catalog.actions.map((action) => {
                        const applicable = subject.actions.includes(action.id);
                        if (!applicable) {
                          return (
                            <td key={action.id} className="px-1 py-1.5 text-center">
                              <span className="text-slate-200 dark:text-slate-700">–</span>
                            </td>
                          );
                        }
                        const state = stateFor(subject.id, action.id);
                        const changed = pending.has(key(subject.id, action.id));
                        return (
                          <td key={action.id} className="px-1 py-1.5 text-center">
                            <button
                              type="button"
                              // A blocked cell is not clickable, because there is
                              // nothing useful to configure while the package
                              // refuses it — the tooltip explains rather than the
                              // control pretending.
                              disabled={!editable || blocked}
                              onClick={() => toggleCell(subject.id, action.id)}
                              title={CELL_TITLE[state]}
                              aria-label={`${subject.label} — ${action.label}: ${state}`}
                              data-state={state}
                              data-testid={`cell-${subject.id}-${action.id}`}
                              className={cn(
                                'inline-flex h-6 w-6 items-center justify-center rounded text-xs font-semibold transition-colors',
                                CELL_STYLES[state],
                                changed && 'ring-2 ring-brand-500 ring-offset-1 dark:ring-offset-slate-900',
                                editable && !blocked ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
                              )}
                            >
                              {CELL_GLYPH[state]}
                            </button>
                          </td>
                        );
                      })}

                      {editable && (
                        <td className="whitespace-nowrap px-2 py-1.5 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={blocked}
                            onClick={() => selectRow(subject.id, subject.actions, subject.requiredModule)}
                            title={
                              blocked
                                ? 'Unavailable while the package does not include this module'
                                : 'Grant every action in this row'
                            }
                          >
                            All
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => clearRow(subject.id, subject.actions)}
                            title="Return this row to its role defaults"
                          >
                            Clear
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The effective-permission preview.
 *
 * Shown next to the matrix so the operator sees the ANSWER, not just the inputs.
 * The counts are computed from the same resolution the server returned, so this
 * is a summary of the server's verdict rather than the client's own arithmetic
 * about what it thinks the rules are.
 */
export function EffectivePermissionSummary({ effective }: { effective: EffectivePermissions }) {
  const counts = useMemo(() => {
    let allowed = 0;
    let denied = 0;
    let blocked = 0;
    let granted = 0;
    for (const permission of effective.permissions) {
      if (permission.allowed) allowed += 1;
      if (permission.override === 'deny') denied += 1;
      if (permission.override === 'grant') granted += 1;
      if (permission.blockedByEntitlement) blocked += 1;
    }
    return { allowed, denied, blocked, granted, total: effective.permissions.length };
  }, [effective.permissions]);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label="Effective" value={`${counts.allowed} / ${counts.total}`} tone="green" />
      <Stat label="Granted directly" value={String(counts.granted)} tone="blue" />
      <Stat label="Denied directly" value={String(counts.denied)} tone="red" />
      <Stat label="Blocked by package" value={String(counts.blocked)} tone="amber" />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'green' | 'blue' | 'red' | 'amber' }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
      <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-0.5">
        <Badge tone={tone}>{value}</Badge>
      </div>
    </div>
  );
}
