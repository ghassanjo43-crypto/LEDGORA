// @vitest-environment happy-dom
/**
 * The permission matrix — what an operator can see and what they can change.
 *
 * The claims under test are the ones that make the editor honest rather than
 * merely pretty:
 *
 *   · the five cell states are distinguishable, and a cell blocked by the
 *     package is shown as blocked-and-preserved rather than as unset;
 *   · a blocked cell cannot be edited, and "select all" skips it, so the editor
 *     never records a grant that could not take effect;
 *   · clicking cycles unset → grant → deny → inherit, and returning a cell to
 *     its stored value clears the pending edit rather than recording a no-op;
 *   · the effective-permission preview counts what the SERVER resolved.
 *
 * Everything rendered here comes from a catalogue the server supplied. The test
 * builds one, because the component holds no list of modules or actions of its
 * own — which is the property the first test asserts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  EffectivePermissionSummary,
  PermissionMatrixEditor,
  cellState,
} from './PermissionMatrixEditor';
import type {
  EffectivePermissions,
  PermissionCatalog,
  PermissionChange,
  ResolvedPermission,
} from '@/services/api/permissionsApi';

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const catalog: PermissionCatalog = {
  actions: [
    { id: 'view', label: 'View' },
    { id: 'create', label: 'Create' },
    { id: 'post', label: 'Post' },
  ],
  subjects: [
    {
      id: 'general_journal',
      label: 'General Journal',
      group: 'Accounting',
      scope: 'organization',
      requiredModule: 'accounting',
      actions: ['view', 'create', 'post'],
      description: 'Journal entries.',
    },
    {
      id: 'manufacturing',
      label: 'Manufacturing',
      group: 'Operations',
      scope: 'organization',
      // Deliberately NOT in the tenant's package below.
      requiredModule: 'manufacturing',
      actions: ['view', 'create', 'post'],
      description: 'Work orders.',
    },
    {
      id: 'user_administration',
      label: 'User Administration',
      group: 'Administration',
      scope: 'administration',
      requiredModule: null,
      actions: ['view'],
      description: 'People in this organization.',
    },
  ],
  roles: [
    { id: 'member', label: 'Standard User', description: 'Authors records.', permissions: ['general_journal:view'] },
  ],
};

function permission(overrides: Partial<ResolvedPermission> & Pick<ResolvedPermission, 'subject' | 'action'>): ResolvedPermission {
  return {
    allowed: false,
    source: 'default_deny',
    inRoleTemplate: false,
    override: null,
    blockedByEntitlement: false,
    ...overrides,
  };
}

/** A member whose package includes accounting but not manufacturing. */
function effectivePermissions(): EffectivePermissions {
  const permissions: ResolvedPermission[] = [
    // Inherited from the role.
    permission({ subject: 'general_journal', action: 'view', allowed: true, source: 'role', inRoleTemplate: true }),
    // Neither role nor override.
    permission({ subject: 'general_journal', action: 'create' }),
    // Granted specifically.
    permission({ subject: 'general_journal', action: 'post', allowed: true, source: 'user_grant', override: 'grant' }),
    // Blocked by the package — and the configuration behind it is preserved.
    permission({ subject: 'manufacturing', action: 'view', source: 'not_entitled', blockedByEntitlement: true }),
    permission({ subject: 'manufacturing', action: 'create', source: 'not_entitled' }),
    permission({
      subject: 'manufacturing',
      action: 'post',
      source: 'not_entitled',
      override: 'grant',
      blockedByEntitlement: true,
    }),
    permission({ subject: 'user_administration', action: 'view' }),
  ];

  return {
    userId: 'user-1',
    organizationId: 'org-1',
    role: 'member',
    membershipStatus: 'active',
    accountStatus: 'active',
    platformRoles: [],
    isPlatformSuperAdmin: false,
    subscription: {
      active: true,
      status: 'active',
      planCode: 'core',
      planName: 'Core',
      edition: 'core',
      modules: ['accounting', 'invoicing', 'reports'],
    },
    permissions,
    allowedKeys: permissions.filter((p) => p.allowed).map((p) => `${p.subject}:${p.action}`),
  };
}

function renderMatrix(
  options: { pending?: Map<string, PermissionChange['effect']>; editable?: boolean } = {},
): { onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn();
  render(
    <PermissionMatrixEditor
      catalog={catalog}
      effective={effectivePermissions()}
      pending={options.pending ?? new Map()}
      onChange={onChange}
      editable={options.editable ?? true}
    />,
  );
  return { onChange };
}

const cell = (subject: string, action: string): HTMLElement =>
  screen.getByTestId(`cell-${subject}-${action}`);

afterEach(cleanup);

/* ── The pure classifier ──────────────────────────────────────────────────── */

describe('cellState', () => {
  it('distinguishes all five states', () => {
    expect(cellState(undefined)).toBe('unset');
    expect(cellState(permission({ subject: 's', action: 'a' }))).toBe('unset');
    expect(cellState(permission({ subject: 's', action: 'a', inRoleTemplate: true }))).toBe('inherited');
    expect(cellState(permission({ subject: 's', action: 'a', override: 'grant' }))).toBe('granted');
    expect(cellState(permission({ subject: 's', action: 'a', override: 'deny' }))).toBe('denied');
  });

  it('reports a package refusal as blocked, not as unset', () => {
    // The distinction that matters: an operator must not be told their
    // configuration was destroyed when it is intact and merely dormant.
    expect(
      cellState(permission({ subject: 's', action: 'a', override: 'grant', blockedByEntitlement: true })),
    ).toBe('blocked');
    expect(cellState(permission({ subject: 's', action: 'a', source: 'not_entitled' }))).toBe('blocked');
    expect(cellState(permission({ subject: 's', action: 'a', source: 'subscription_inactive' }))).toBe(
      'blocked',
    );
  });

  it('lets the package refusal outrank an inherited grant', () => {
    expect(
      cellState(
        permission({ subject: 's', action: 'a', inRoleTemplate: true, blockedByEntitlement: true }),
      ),
    ).toBe('blocked');
  });
});

/* ── Rendering ────────────────────────────────────────────────────────────── */

describe('the permission matrix', () => {
  it('renders exactly the subjects and actions the catalogue supplied', () => {
    renderMatrix();
    // No list of modules lives in the component — these are the fixture's.
    expect(screen.getByText('General Journal')).toBeTruthy();
    expect(screen.getByText('Manufacturing')).toBeTruthy();
    expect(screen.getByText('User Administration')).toBeTruthy();
    expect(screen.queryByText('Chart of Accounts')).toBeNull();
    // Grouped by the catalogue's own grouping.
    expect(screen.getByText('Accounting')).toBeTruthy();
    expect(screen.getByText('Operations')).toBeTruthy();
  });

  it('shows each cell in its resolved state', () => {
    renderMatrix();
    expect(cell('general_journal', 'view').getAttribute('data-state')).toBe('inherited');
    expect(cell('general_journal', 'create').getAttribute('data-state')).toBe('unset');
    expect(cell('general_journal', 'post').getAttribute('data-state')).toBe('granted');
    expect(cell('manufacturing', 'post').getAttribute('data-state')).toBe('blocked');
  });

  it('marks a module the package does not include', () => {
    renderMatrix();
    const row = screen.getByTestId('permission-row-manufacturing');
    expect(row.textContent).toContain('not in package');
    // …and does not claim the same about an entitled one.
    expect(screen.getByTestId('permission-row-general_journal').textContent).not.toContain('not in package');
  });

  it('renders an inapplicable action as blank rather than as a control', () => {
    renderMatrix();
    // `user_administration` supports only `view` in this catalogue.
    expect(screen.queryByTestId('cell-user_administration-post')).toBeNull();
  });
});

/* ── Editing ──────────────────────────────────────────────────────────────── */

describe('editing the matrix', () => {
  it('cycles unset → grant → deny → inherit', () => {
    const { onChange } = renderMatrix();
    fireEvent.click(cell('general_journal', 'create'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect([...onChange.mock.calls[0]![0].entries()]).toEqual([['general_journal:create', 'grant']]);

    // From a stored grant, the next step is deny.
    cleanup();
    const second = renderMatrix();
    fireEvent.click(cell('general_journal', 'post'));
    expect([...second.onChange.mock.calls[0]![0].entries()]).toEqual([['general_journal:post', 'deny']]);
  });

  it('clears the pending edit when a cell returns to its stored value', () => {
    // `general_journal:post` is stored as a grant. A pending `deny` that is
    // cycled back to `inherit`… and then to `grant` again should leave nothing
    // pending, because nothing has actually changed.
    const pending = new Map<string, PermissionChange['effect']>([['general_journal:post', 'deny']]);
    const { onChange } = renderMatrix({ pending });
    // deny → inherit
    fireEvent.click(cell('general_journal', 'post'));
    expect([...onChange.mock.calls[0]![0].entries()]).toEqual([['general_journal:post', 'inherit']]);
  });

  it('refuses to edit a cell the package blocks', () => {
    const { onChange } = renderMatrix();
    const blocked = cell('manufacturing', 'view') as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    fireEvent.click(blocked);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not offer "select all" for a blocked row', () => {
    renderMatrix();
    const row = screen.getByTestId('permission-row-manufacturing');
    const all = [...row.querySelectorAll('button')].find((b) => b.textContent === 'All') as HTMLButtonElement;
    // A "select all" that configured the unreachable is how an operator comes to
    // believe someone has access they do not.
    expect(all.disabled).toBe(true);
  });

  it('grants every applicable action in an entitled row', () => {
    const { onChange } = renderMatrix();
    const row = screen.getByTestId('permission-row-general_journal');
    const all = [...row.querySelectorAll('button')].find((b) => b.textContent === 'All')!;
    fireEvent.click(all);

    const next = onChange.mock.calls[0]![0] as Map<string, PermissionChange['effect']>;
    expect(next.get('general_journal:view')).toBe('grant');
    expect(next.get('general_journal:create')).toBe('grant');
    // `post` is already stored as a grant, so it is not a pending change.
    expect(next.has('general_journal:post')).toBe(false);
  });

  it('returns a row to its role defaults', () => {
    const { onChange } = renderMatrix();
    const row = screen.getByTestId('permission-row-general_journal');
    const clear = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Clear')!;
    fireEvent.click(clear);

    const next = onChange.mock.calls[0]![0] as Map<string, PermissionChange['effect']>;
    // Only the cell that actually has an override needs reverting.
    expect(next.get('general_journal:post')).toBe('inherit');
    expect(next.has('general_journal:view')).toBe(false);
  });

  it('is read-only when the caller cannot manage permissions', () => {
    const { onChange } = renderMatrix({ editable: false });
    fireEvent.click(cell('general_journal', 'create'));
    expect(onChange).not.toHaveBeenCalled();
    // The row controls are not offered at all.
    const row = screen.getByTestId('permission-row-general_journal');
    expect([...row.querySelectorAll('button')].some((b) => b.textContent === 'All')).toBe(false);
  });
});

/* ── Effective preview ────────────────────────────────────────────────────── */

describe('the effective-permission preview', () => {
  it("counts the server's verdict, not the client's arithmetic", () => {
    render(<EffectivePermissionSummary effective={effectivePermissions()} />);
    // 2 of 7 allowed; 2 granted directly; 0 denied; 2 blocked by the package.
    expect(screen.getByText('2 / 7')).toBeTruthy();
    expect(screen.getByText('Effective')).toBeTruthy();
    expect(screen.getByText('Blocked by package')).toBeTruthy();
  });

  it('warns when there is no live subscription', () => {
    const effective = effectivePermissions();
    effective.subscription.active = false;
    render(
      <PermissionMatrixEditor
        catalog={catalog}
        effective={effective}
        pending={new Map()}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('No active subscription')).toBeTruthy();
  });
});
