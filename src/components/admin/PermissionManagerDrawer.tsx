/**
 * "Manage permissions" — the drawer that wraps the matrix.
 *
 * ── Why edits are held and applied in one request ────────────────────────────
 * Every cell click accumulates in `pending` and nothing is written until the
 * operator saves. A matrix that saved per click would produce one audit entry
 * per stray click, leave a half-configured user live between clicks, and — since
 * withdrawing a permission revokes the target's sessions — sign somebody out
 * repeatedly while an administrator was still making up their mind.
 *
 * ── Why high-risk changes are confirmed ──────────────────────────────────────
 * Two kinds of change get a confirmation step: anything that REMOVES access (the
 * target is signed out and loses a surface they may be using) and anything
 * touching the administration subjects (`user_administration`,
 * `subscription_administration`, `organization_settings`) — those decide who can
 * administer whom, and are the changes worth being sure about.
 *
 * ── This is not where authorization happens ──────────────────────────────────
 * The drawer hides controls the operator cannot use, which is a courtesy. The
 * server re-checks its capability on every route and re-resolves the whole
 * precedence rule on every request, so a client that ignored all of this would
 * simply collect 403s.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Field, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  EffectivePermissionSummary,
  PermissionMatrixEditor,
} from './PermissionMatrixEditor';
import {
  fetchEffectivePermissions,
  fetchOwnUserPermissions,
  fetchOwnPermissionCatalog,
  fetchPermissionCatalog,
  resetOwnUserPermissions,
  resetPermissionsToRole,
  updateOwnUserPermissions,
  updatePermissions,
  type EffectivePermissions,
  type PermissionCatalog,
  type PermissionChange,
} from '@/services/api/permissionsApi';

/** Subjects whose changes decide who can administer whom. */
const HIGH_RISK_SUBJECTS = new Set([
  'user_administration',
  'subscription_administration',
  'organization_settings',
]);

export interface PermissionManagerDrawerProps {
  open: boolean;
  onClose: () => void;
  userId: string;
  userName: string;
  organizationId: string;
  organizationName?: string | null;
  /**
   * `platform` uses the operator endpoints; `organization` uses the
   * caller's-own-tenant endpoints, which accept no organization identifier at
   * all. The two are never mixed for one drawer.
   */
  surface?: 'platform' | 'organization';
  /** False when the caller may read permissions but not change them. */
  editable?: boolean;
  onSaved?: () => void;
}

export function PermissionManagerDrawer({
  open,
  onClose,
  userId,
  userName,
  organizationId,
  organizationName,
  surface = 'platform',
  editable = true,
  onSaved,
}: PermissionManagerDrawerProps) {
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
  const [effective, setEffective] = useState<EffectivePermissions | null>(null);
  const [pending, setPending] = useState<Map<string, PermissionChange['effect']>>(new Map());
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [nextCatalog, nextEffective] = await Promise.all([
          surface === 'platform' ? fetchPermissionCatalog(signal) : fetchOwnPermissionCatalog(signal),
          surface === 'platform'
            ? fetchEffectivePermissions(userId, organizationId, signal)
            : fetchOwnUserPermissions(userId, signal),
        ]);
        setCatalog(nextCatalog);
        setEffective(nextEffective);
        setPending(new Map());
      } catch (caught) {
        if ((caught as { name?: string }).name === 'AbortError') return;
        setError((caught as Error).message || 'Permissions could not be loaded.');
      } finally {
        setLoading(false);
      }
    },
    [surface, userId, organizationId],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

  /** The pending edits, as the change list the API takes. */
  const changes = useMemo((): PermissionChange[] => {
    const out: PermissionChange[] = [];
    for (const [key, effect] of pending) {
      const [subject, action] = key.split(':');
      if (subject && action) out.push({ subject, action, effect });
    }
    return out;
  }, [pending]);

  /**
   * Does saving REMOVE anything the person can currently do?
   *
   * Computed against the resolution the server returned, so it accounts for the
   * role template and the package — not just for whether a cell looks ticked.
   */
  const risk = useMemo(() => {
    if (!effective) return { removes: [] as string[], administrative: [] as string[] };
    const allowed = new Set(effective.allowedKeys);
    const removes: string[] = [];
    const administrative: string[] = [];
    for (const change of changes) {
      const key = `${change.subject}:${change.action}`;
      if (HIGH_RISK_SUBJECTS.has(change.subject)) administrative.push(key);
      if (allowed.has(key) && change.effect !== 'grant') removes.push(key);
    }
    return { removes, administrative };
  }, [changes, effective]);

  const highRisk = risk.removes.length > 0 || risk.administrative.length > 0;

  const persist = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result =
        surface === 'platform'
          ? await updatePermissions(userId, { organizationId, changes, reason: reason.trim() || undefined })
          : await updateOwnUserPermissions(userId, { changes, reason: reason.trim() || undefined });

      setEffective(result.effective);
      setPending(new Map());
      setReason('');
      setNotice(
        `${result.applied} permission${result.applied === 1 ? '' : 's'} updated.` +
          (result.revokedSessions > 0
            ? ` ${userName} was signed out of ${result.revokedSessions} session${result.revokedSessions === 1 ? '' : 's'} because access was reduced.`
            : ''),
      );
      onSaved?.();
    } catch (caught) {
      setError((caught as Error).message || 'The permission change could not be saved.');
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  const save = (): void => {
    if (changes.length === 0) return;
    if (highRisk) {
      setConfirming(true);
      return;
    }
    void persist();
  };

  const resetToRole = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const result =
        surface === 'platform'
          ? await resetPermissionsToRole(userId, { organizationId, reason: reason.trim() || undefined })
          : await resetOwnUserPermissions(userId, reason.trim() || undefined);
      setEffective(result.effective);
      setPending(new Map());
      setNotice(`${result.applied} override${result.applied === 1 ? '' : 's'} cleared. Role defaults restored.`);
      onSaved?.();
    } catch (caught) {
      setError((caught as Error).message || 'The reset could not be completed.');
    } finally {
      setSaving(false);
      setResetting(false);
    }
  };

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        widthClassName="max-w-6xl"
        title={`Permissions — ${userName}`}
        description={
          organizationName ? (
            <span>
              Inside <span className="font-medium">{organizationName}</span>. Permissions apply to this
              organization only.
            </span>
          ) : (
            'Permissions apply to this organization only.'
          )
        }
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {changes.length > 0 ? (
                <Badge tone="amber">
                  {changes.length} unsaved change{changes.length === 1 ? '' : 's'}
                </Badge>
              ) : (
                'No unsaved changes'
              )}
            </div>
            <div className="flex items-center gap-2">
              {editable && (
                <Button variant="outline" onClick={() => setResetting(true)} disabled={saving || loading}>
                  Reset to role defaults
                </Button>
              )}
              <Button variant="ghost" onClick={onClose} disabled={saving}>
                Close
              </Button>
              {editable && (
                <Button onClick={save} disabled={saving || loading || changes.length === 0}>
                  {saving ? 'Saving…' : 'Save permissions'}
                </Button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          {error && (
            <Alert variant="error" title="Could not complete" onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          {notice && (
            <Alert variant="success" onClose={() => setNotice(null)}>
              {notice}
            </Alert>
          )}

          {loading && <p className="text-sm text-slate-500">Loading permissions…</p>}

          {!loading && catalog && effective && (
            <>
              {/* The ANSWER, above the inputs that produce it. */}
              <EffectivePermissionSummary effective={effective} />

              <PermissionMatrixEditor
                catalog={catalog}
                effective={effective}
                pending={pending}
                onChange={setPending}
                editable={editable}
              />

              {editable && (
                <Field
                  label="Reason"
                  hint="Recorded in the audit trail against every permission changed."
                >
                  <Textarea
                    rows={2}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why is this access changing?"
                  />
                </Field>
              )}
            </>
          )}
        </div>
      </Drawer>

      {/* ── Confirmation for a high-risk change ──────────────────────────── */}
      <ConfirmDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void persist()}
        title="Confirm this access change"
        confirmLabel={saving ? 'Saving…' : 'Apply changes'}
        destructive
        message={
          <div className="space-y-2 text-sm">
            {risk.removes.length > 0 && (
              <p>
                This removes <span className="font-semibold">{risk.removes.length}</span> permission
                {risk.removes.length === 1 ? '' : 's'} {userName} currently has. They will be signed out of
                every active session.
              </p>
            )}
            {risk.administrative.length > 0 && (
              <p>
                This changes <span className="font-semibold">administration</span> rights — who may manage
                people, the subscription or organization settings.
              </p>
            )}
            <p className="text-slate-500 dark:text-slate-400">
              Every change is recorded in the audit trail with its previous and new value.
            </p>
          </div>
        }
      />

      <ConfirmDialog
        open={resetting}
        onCancel={() => setResetting(false)}
        onConfirm={() => void resetToRole()}
        title="Reset to role defaults"
        confirmLabel={saving ? 'Resetting…' : 'Reset permissions'}
        destructive
        message={
          <p className="text-sm">
            Every permission granted or denied specifically to {userName} in this organization is removed,
            leaving only what their role provides. This is recorded in the audit trail and cannot be undone
            from here.
          </p>
        }
      />
    </>
  );
}
