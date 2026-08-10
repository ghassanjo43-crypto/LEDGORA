/**
 * "Add user" — account creation with organization, role and initial permissions.
 *
 * ── What this form deliberately does not have ────────────────────────────────
 * A password field. There is no way to set someone else's password by typing
 * one, because a password an administrator has typed is a password an
 * administrator knows. The two supported paths are:
 *
 *   invitation          — the person sets their own password through a
 *                         single-use, expiring link, and nobody else ever knows it;
 *   temporary password  — the server generates one, hashes it immediately, shows
 *                         it once, and forces a change at first sign-in.
 *
 * Neither value is retrievable afterwards. If the response is lost, a new
 * credential must be issued — that is the property that makes it a one-time
 * secret rather than a stored one.
 *
 * ── Why the role list comes from the server ──────────────────────────────────
 * The catalogue is fetched, so this file holds no list of roles, no list of
 * modules and no description of what a role can do. `owner` is filtered out
 * because ownership is transferred, never assigned — the backend refuses it too,
 * which is what actually enforces it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Input, Field, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import {
  createUser,
  fetchPermissionCatalog,
  type CreatedUserResponse,
  type PermissionCatalog,
} from '@/services/api/permissionsApi';

export interface OrganizationChoice {
  id: string;
  name: string;
}

export interface CreateUserDrawerProps {
  open: boolean;
  onClose: () => void;
  organizations: OrganizationChoice[];
  /** Pre-selected tenant when the drawer is opened from a subscriber row. */
  defaultOrganizationId?: string | null;
  /** True when the operator may grant platform authority (super admin only). */
  canGrantPlatformRoles?: boolean;
  onCreated: (result: CreatedUserResponse) => void;
}

interface FormState {
  fullName: string;
  email: string;
  organizationId: string;
  role: string;
  accountStatus: 'active' | 'disabled' | 'pending_verification' | '';
  onboarding: 'invitation' | 'temporary_password';
  platformRole: '' | 'support' | 'billing_admin' | 'super_admin';
  notes: string;
}

const EMPTY: FormState = {
  fullName: '',
  email: '',
  organizationId: '',
  role: 'member',
  accountStatus: '',
  onboarding: 'invitation',
  platformRole: '',
  notes: '',
};

export function CreateUserDrawer({
  open,
  onClose,
  organizations,
  defaultOrganizationId,
  canGrantPlatformRoles = false,
  onCreated,
}: CreateUserDrawerProps) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setForm({ ...EMPTY, organizationId: defaultOrganizationId ?? '' });
    setError(null);
    setFieldErrors({});
    const controller = new AbortController();
    void fetchPermissionCatalog(controller.signal)
      .then(setCatalog)
      .catch(() => setCatalog(null));
    return () => controller.abort();
  }, [open, defaultOrganizationId]);

  const set = useCallback(<K extends keyof FormState>(field: K, value: FormState[K]): void => {
    setForm((current) => ({ ...current, [field]: value }));
  }, []);

  /** Ownership is transferred, never assigned — so it is not offered. */
  const roleOptions = useMemo(
    () =>
      (catalog?.roles ?? [])
        .filter((role) => role.id !== 'owner')
        .map((role) => ({ value: role.id, label: role.label })),
    [catalog],
  );

  const selectedRole = catalog?.roles.find((role) => role.id === form.role);

  const submit = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await createUser({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        onboarding: form.onboarding,
        ...(form.organizationId ? { organizationId: form.organizationId, role: form.role } : {}),
        ...(form.accountStatus ? { accountStatus: form.accountStatus } : {}),
        ...(form.platformRole ? { platformRoles: [form.platformRole] } : {}),
        ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
      });
      onCreated(result);
      onClose();
    } catch (caught) {
      const details = (caught as { details?: { fieldErrors?: Record<string, string> } }).details;
      if (details?.fieldErrors) setFieldErrors(details.fieldErrors);
      setError((caught as Error).message || 'The user could not be created.');
    } finally {
      setSaving(false);
    }
  };

  const ready = form.fullName.trim().length > 0 && form.email.trim().length > 0;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      widthClassName="max-w-2xl"
      title="Add user"
      description="Creates the account and issues a one-time credential. No password is ever typed here."
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || !ready}>
            {saving ? 'Creating…' : 'Create user'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <Alert variant="error" title="Could not create the user" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required error={fieldErrors.fullName}>
            <Input
              value={form.fullName}
              onChange={(e) => set('fullName', e.target.value)}
              placeholder="Rami Bookkeeper"
              autoComplete="off"
            />
          </Field>
          <Field label="Email" required error={fieldErrors.email}>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              placeholder="rami@company.example"
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Organization"
            error={fieldErrors.organizationId}
            hint="Leave empty to create a platform operator with no tenant."
          >
            <Select
              value={form.organizationId}
              onChange={(e) => set('organizationId', e.target.value)}
              placeholder="No organization"
              options={organizations.map((org) => ({ value: org.id, label: org.name }))}
            />
          </Field>
          <Field
            label="Role"
            error={fieldErrors.role}
            hint={
              form.organizationId
                ? selectedRole?.description
                : 'A role applies only inside an organization.'
            }
          >
            <Select
              value={form.role}
              onChange={(e) => set('role', e.target.value)}
              disabled={!form.organizationId}
              options={roleOptions}
            />
          </Field>
        </div>

        {/* ── Password setup ────────────────────────────────────────────── */}
        <Field
          label="Password setup"
          required
          hint="No password is set here, and none can be retrieved later."
        >
          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <input
                type="radio"
                name="onboarding"
                className="mt-0.5"
                checked={form.onboarding === 'invitation'}
                onChange={() => set('onboarding', 'invitation')}
              />
              <span className="text-sm">
                <span className="font-medium">Send an invitation link</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  The person chooses their own password through a single-use, expiring link. Nobody else ever
                  knows it. The account cannot sign in until the link is used.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <input
                type="radio"
                name="onboarding"
                className="mt-0.5"
                checked={form.onboarding === 'temporary_password'}
                onChange={() => set('onboarding', 'temporary_password')}
              />
              <span className="text-sm">
                <span className="font-medium">Generate a temporary password</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  Shown once, expires, and must be changed at first sign-in. Use when you can hand it over
                  through a channel you trust.
                </span>
              </span>
            </label>
          </div>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Account status"
            hint="Leave as default unless the account should start suspended."
          >
            <Select
              value={form.accountStatus}
              onChange={(e) => set('accountStatus', e.target.value as FormState['accountStatus'])}
              placeholder="Default for the chosen setup"
              options={[
                { value: 'active', label: 'Active' },
                { value: 'pending_verification', label: 'Pending verification' },
                { value: 'disabled', label: 'Disabled' },
              ]}
            />
          </Field>

          {/*
            Platform authority is offered only to an operator who may grant it.
            Hiding it is a courtesy — the backend refuses the grant regardless,
            and records the refusal.
          */}
          {canGrantPlatformRoles && (
            <Field
              label="Platform authority"
              hint="Ledgora staff only. Not a customer role."
            >
              <Select
                value={form.platformRole}
                onChange={(e) => set('platformRole', e.target.value as FormState['platformRole'])}
                placeholder="None — a customer account"
                options={[
                  { value: 'support', label: 'Support' },
                  { value: 'billing_admin', label: 'Billing administrator' },
                  { value: 'super_admin', label: 'Super administrator' },
                ]}
              />
            </Field>
          )}
        </div>

        {form.platformRole === 'super_admin' && (
          <Alert variant="warning" title="Super administrator">
            This account will hold full authority over every tenant on the platform. Only an existing super
            administrator can grant this, and the grant is recorded in the audit trail.
          </Alert>
        )}

        <Field label="Internal notes" hint="Operator-only. Never shown to the customer.">
          <Textarea
            rows={2}
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            placeholder="Context for other operators."
          />
        </Field>

        {form.organizationId && selectedRole && (
          <div className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-700">
            <div className="mb-1.5 font-medium text-slate-700 dark:text-slate-200">
              What {selectedRole.label} can do by default
            </div>
            <p className="text-slate-500 dark:text-slate-400">{selectedRole.description}</p>
            <p className="mt-1.5 text-slate-500 dark:text-slate-400">
              <Badge tone="slate">{selectedRole.permissions.length} permissions</Badge>{' '}
              from the role template. Fine-tune them with{' '}
              <span className="font-medium">Manage permissions</span> after the account is created — the
              organization&rsquo;s package still decides which modules are reachable.
            </p>
          </div>
        )}
      </div>
    </Drawer>
  );
}
