/**
 * Unit tests for the permission resolver and the catalogue it reads.
 *
 * These exercise `resolveAll` directly — no database, no HTTP — because the
 * precedence rule is the thing under test and it should be provable without a
 * tenant, a subscription or a session standing in the way. The API tests that
 * follow prove the same rule holds through the real stack.
 */
import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_ROLES,
  PERMISSION_ACTIONS,
  PERMISSION_SUBJECTS,
  allPermissionKeys,
  catalogView,
  isKnownPermission,
  permissionKey,
  roleTemplate,
} from '../src/config/permissionCatalog.js';
import { resolveAll } from '../src/services/permissionService.js';
import type { PermissionEffect } from '../src/db/schema.js';

/** Every module the catalogue can gate on, so "fully entitled" is expressible. */
const ALL_MODULES = new Set(
  PERMISSION_SUBJECTS.map((s) => s.requiredModule).filter((m): m is string => m !== null),
);

interface Options {
  accountStatus?: string;
  platformRoles?: string[];
  role?: string | null;
  membershipStatus?: string | null;
  entitlementActive?: boolean;
  modules?: Set<string>;
  overrides?: Map<string, PermissionEffect>;
}

/** A fully entitled, active, ordinary member — the baseline every case varies. */
function resolve(options: Options = {}) {
  const permissions = resolveAll({
    accountStatus: options.accountStatus ?? 'active',
    platformRoles: options.platformRoles ?? [],
    role: options.role === undefined ? 'accountant' : options.role,
    membershipStatus: options.membershipStatus === undefined ? 'active' : options.membershipStatus,
    entitlementActive: options.entitlementActive ?? true,
    modules: options.modules ?? ALL_MODULES,
    overrides: options.overrides ?? new Map(),
  });
  const byKey = new Map(permissions.map((p) => [permissionKey(p.subject, p.action), p]));
  return {
    permissions,
    get: (subject: string, action: string) => byKey.get(permissionKey(subject, action))!,
    allowed: (subject: string, action: string) => byKey.get(permissionKey(subject, action))?.allowed ?? false,
  };
}

const grant = (subject: string, action: string): Map<string, PermissionEffect> =>
  new Map([[permissionKey(subject, action), 'grant']]);
const deny = (subject: string, action: string): Map<string, PermissionEffect> =>
  new Map([[permissionKey(subject, action), 'deny']]);

/* ── The catalogue ────────────────────────────────────────────────────────── */

describe('the permission catalogue', () => {
  it('covers every module the specification names', () => {
    const ids = new Set(PERMISSION_SUBJECTS.map((s) => s.id));
    for (const required of [
      'dashboard',
      'chart_of_accounts',
      'general_journal',
      'general_ledger',
      'trial_balance',
      'financial_statements',
      'customers',
      'vendors',
      'invoices',
      'credit_notes',
      'bills',
      'payments',
      'receipts',
      'tax',
      'currencies',
      'cost_centers',
      'projects',
      'construction',
      'manufacturing',
      'reports',
      'documents',
      'email_reminders',
      'user_administration',
      'subscription_administration',
      'audit_logs',
    ]) {
      expect(ids, `missing subject: ${required}`).toContain(required);
    }
  });

  it('defines every action the specification names', () => {
    for (const action of [
      'view', 'create', 'edit', 'delete', 'void', 'approve', 'post', 'unpost',
      'export', 'manage_users', 'manage_subscriptions', 'manage_organization_settings',
    ]) {
      expect(PERMISSION_ACTIONS).toContain(action);
    }
  });

  it('rejects a permission it does not define', () => {
    expect(isKnownPermission('general_journal', 'post')).toBe(true);
    // The anti-mass-assignment boundary: invented pairs are not representable.
    expect(isKnownPermission('general_journal', 'become_super_admin')).toBe(false);
    expect(isKnownPermission('*', '*')).toBe(false);
    expect(isKnownPermission('users', 'manage_users')).toBe(false);
    // A real action on a subject that does not support it is equally unknown.
    expect(isKnownPermission('trial_balance', 'post')).toBe(false);
  });

  it('never lets a role template contain a permission the catalogue lacks', () => {
    const universe = new Set(allPermissionKeys());
    for (const role of ORGANIZATION_ROLES) {
      for (const key of roleTemplate(role)) {
        expect(universe, `${role} holds unknown ${key}`).toContain(key);
      }
    }
  });

  it('serialises the whole catalogue for the editor', () => {
    const view = catalogView();
    expect(view.subjects.length).toBe(PERMISSION_SUBJECTS.length);
    expect(view.actions.length).toBe(PERMISSION_ACTIONS.length);
    expect(view.roles.map((r) => r.id)).toEqual([...ORGANIZATION_ROLES]);
    // The editor shows "inherited from role" from exactly this.
    expect(view.roles.find((r) => r.id === 'viewer')!.permissions).toContain('invoices:view');
    expect(view.roles.find((r) => r.id === 'viewer')!.permissions).not.toContain('invoices:post');
  });
});

/* ── Role templates ───────────────────────────────────────────────────────── */

describe('role permission resolution', () => {
  it('gives a read-only auditor views and exports but no writes', () => {
    const r = resolve({ role: 'viewer' });
    expect(r.allowed('invoices', 'view')).toBe(true);
    expect(r.allowed('invoices', 'export')).toBe(true);
    expect(r.allowed('invoices', 'create')).toBe(false);
    expect(r.allowed('invoices', 'post')).toBe(false);
    // An auditor reads the audit trail — that is the point of the role.
    expect(r.allowed('audit_logs', 'view')).toBe(true);
    // But does not administer people.
    expect(r.allowed('user_administration', 'manage_users')).toBe(false);
  });

  it('lets a standard user author records but not make them permanent', () => {
    const r = resolve({ role: 'member' });
    expect(r.allowed('invoices', 'create')).toBe(true);
    expect(r.allowed('invoices', 'edit')).toBe(true);
    expect(r.allowed('invoices', 'post')).toBe(false);
    expect(r.allowed('invoices', 'void')).toBe(false);
    expect(r.allowed('invoices', 'delete')).toBe(false);
    expect(r.allowed('invoices', 'approve')).toBe(false);
  });

  it('lets an accountant post and reverse but not approve', () => {
    const r = resolve({ role: 'accountant' });
    expect(r.allowed('general_journal', 'post')).toBe(true);
    expect(r.allowed('general_journal', 'unpost')).toBe(true);
    expect(r.allowed('general_journal', 'void')).toBe(true);
    // Approval is a second pair of eyes; the role that posts does not hold it.
    expect(r.allowed('general_journal', 'approve')).toBe(false);
  });

  it('adds approval at manager and administration at organization admin', () => {
    const manager = resolve({ role: 'manager' });
    expect(manager.allowed('general_journal', 'approve')).toBe(true);
    expect(manager.allowed('user_administration', 'manage_users')).toBe(false);

    const admin = resolve({ role: 'admin' });
    expect(admin.allowed('user_administration', 'manage_users')).toBe(true);
    expect(admin.allowed('subscription_administration', 'manage_subscriptions')).toBe(true);
    expect(admin.allowed('organization_settings', 'manage_organization_settings')).toBe(true);
  });

  it('keeps amending a POSTED document out of every role below Organization Admin', () => {
    /*
     * Amending restates a figure that has already been given to a customer, a
     * supplier or a filed return. It is not part of the bookkeeping group an
     * Accountant holds, and it is not implied by `edit` — which governs drafts
     * nobody has relied on. The subscriber grants it deliberately, per role or
     * per person, through `user_permission_overrides`.
     */
    for (const subject of ['invoices', 'bills', 'credit_notes']) {
      expect(isKnownPermission(subject, 'amend'), `${subject} must offer amend`).toBe(true);
      for (const role of ['viewer', 'member', 'accountant', 'manager'] as const) {
        expect(
          resolve({ role }).allowed(subject, 'amend'),
          `${role} must not hold ${subject}:amend by default`,
        ).toBe(false);
      }
      for (const role of ['admin', 'owner'] as const) {
        expect(resolve({ role }).allowed(subject, 'amend')).toBe(true);
      }
    }
    /* And it is not offered where it would mean nothing. */
    expect(isKnownPermission('trial_balance', 'amend')).toBe(false);
    expect(isKnownPermission('general_journal', 'amend')).toBe(false);
  });

  it('lets an explicit override grant amendment to one person, as the subscriber intends', () => {
    const granted = resolve({ role: 'accountant', overrides: grant('invoices', 'amend') });
    expect(granted.allowed('invoices', 'amend')).toBe(true);
    /* One permission, not the set. */
    expect(granted.allowed('bills', 'amend')).toBe(false);

    const denied = resolve({ role: 'owner', overrides: deny('invoices', 'amend') });
    expect(denied.allowed('invoices', 'amend')).toBe(false);
  });

  it('gives corporate authority to the OWNER alone, and to no other role', () => {
    /*
     * Binding the organization to a contract, and choosing the law that governs
     * it, are acts of corporate authority. They must not arrive with a job
     * title — not an Accountant's, and not an Organization Admin's. Only the
     * subscriber who owns the workspace holds them by default.
     */
    for (const action of ['accept_for_organization', 'manage_organization_settings']) {
      expect(isKnownPermission('legal_terms', action)).toBe(true);
      expect(resolve({ role: 'owner' }).allowed('legal_terms', action)).toBe(true);
      for (const role of ['admin', 'manager', 'accountant', 'member', 'viewer'] as const) {
        expect(
          resolve({ role }).allowed('legal_terms', action),
          `${role} must not hold legal_terms:${action} by default`,
        ).toBe(false);
      }
    }
    /*
     * Reading the terms and acknowledging them FOR YOURSELF are not corporate
     * authority. Every role holds both, Viewer included — acknowledging is the
     * one act the product requires of everybody before they can work, and
     * deriving it from a role ladder would leave the most junior person unable
     * to perform it.
     */
    for (const role of ['owner', 'admin', 'manager', 'accountant', 'member', 'viewer'] as const) {
      expect(resolve({ role }).allowed('legal_terms', 'view')).toBe(true);
      expect(resolve({ role }).allowed('legal_terms', 'acknowledge')).toBe(true);
    }
  });

  it('lets an explicit override delegate the authority to bind, one person at a time', () => {
    const delegated = resolve({ role: 'accountant', overrides: grant('legal_terms', 'accept_for_organization') });
    expect(delegated.allowed('legal_terms', 'accept_for_organization')).toBe(true);
    /* One authority, not the set: delegating acceptance is not delegating the
       country, which decides which law applies. */
    expect(delegated.allowed('legal_terms', 'manage_organization_settings')).toBe(false);
  });

  it('lets the owner’s authority be explicitly removed', () => {
    const denied = resolve({ role: 'owner', overrides: deny('legal_terms', 'accept_for_organization') });
    expect(denied.allowed('legal_terms', 'accept_for_organization')).toBe(false);
  });

  it('keeps the Terms reachable when the subscription is not active', () => {
    /*
     * The one named exemption from the entitlement gate. Acceptance is a
     * precondition of using the product, so gating it behind an active
     * subscription would deadlock: the customer cannot accept because they have
     * not paid, and the acceptance they owe is waiting when they do.
     */
    const lapsed = resolve({ role: 'owner', entitlementActive: false });
    expect(lapsed.allowed('legal_terms', 'view')).toBe(true);
    expect(lapsed.allowed('legal_terms', 'acknowledge')).toBe(true);
    expect(lapsed.allowed('legal_terms', 'accept_for_organization')).toBe(true);

    /* And it really is one exemption, not a hole. */
    expect(lapsed.allowed('invoices', 'create')).toBe(false);
    expect(lapsed.allowed('general_journal', 'post')).toBe(false);
    expect(lapsed.get('invoices', 'create').source).toBe('subscription_inactive');
  });

  it('keeps the ladder monotone — every role is a superset of the one below', () => {
    // viewer ⊂ member ⊂ accountant ⊂ manager ⊂ admin ⊆ owner.
    // Monotonicity makes "promotion or demotion?" answerable and stops a role
    // change from both granting and removing authority in one step.
    const ladder = ['viewer', 'member', 'accountant', 'manager', 'admin', 'owner'] as const;
    for (let i = 1; i < ladder.length; i += 1) {
      const lower = roleTemplate(ladder[i - 1]!);
      const higher = roleTemplate(ladder[i]!);
      for (const key of lower) {
        expect(higher, `${ladder[i]} is missing ${key} held by ${ladder[i - 1]}`).toContain(key);
      }
    }
  });

  it('gives an unknown role nothing at all', () => {
    // Fail closed: a role the catalogue does not know is not a wildcard.
    const r = resolve({ role: 'chief_wizard' });
    expect(r.permissions.every((p) => !p.allowed)).toBe(true);
  });
});

/* ── Overrides ────────────────────────────────────────────────────────────── */

describe('explicit grants and denials', () => {
  it('grants a permission the role does not carry', () => {
    const r = resolve({ role: 'member', overrides: grant('general_journal', 'post') });
    const cell = r.get('general_journal', 'post');
    expect(cell.allowed).toBe(true);
    expect(cell.source).toBe('user_grant');
    // The editor needs to distinguish "granted specifically" from "inherited".
    expect(cell.inRoleTemplate).toBe(false);
    expect(cell.override).toBe('grant');
  });

  it('denies a permission the role does carry', () => {
    const r = resolve({ role: 'accountant', overrides: deny('general_journal', 'post') });
    const cell = r.get('general_journal', 'post');
    expect(cell.allowed).toBe(false);
    expect(cell.source).toBe('user_deny');
    // The role still grants it — which is exactly what the editor must show.
    expect(cell.inRoleTemplate).toBe(true);
  });

  it('makes a denial outrank a grant by construction', () => {
    // One row per cell, so "granted AND denied" cannot be stored. The unique key
    // enforces it; this asserts the resolver agrees.
    const overrides = new Map<string, PermissionEffect>([[permissionKey('invoices', 'post'), 'deny']]);
    expect(resolve({ role: 'accountant', overrides }).allowed('invoices', 'post')).toBe(false);
  });

  it('leaves every other cell untouched', () => {
    const base = resolve({ role: 'member' });
    const withGrant = resolve({ role: 'member', overrides: grant('invoices', 'post') });
    for (const permission of base.permissions) {
      if (permission.subject === 'invoices' && permission.action === 'post') continue;
      expect(withGrant.allowed(permission.subject, permission.action)).toBe(permission.allowed);
    }
  });
});

/* ── Subscription precedence ──────────────────────────────────────────────── */

describe('subscription restriction precedence', () => {
  it('refuses a module the organization has not bought, whatever the role says', () => {
    // Owner — the strongest role there is — and still refused.
    const r = resolve({ role: 'owner', modules: new Set(['accounting']) });
    expect(r.allowed('manufacturing', 'view')).toBe(false);
    expect(r.get('manufacturing', 'view').source).toBe('not_entitled');
    // The entitled module in the same tenant still works.
    expect(r.allowed('general_journal', 'post')).toBe(true);
  });

  it('refuses an explicit grant for an unentitled module', () => {
    // This is the rule that makes permissions unable to bypass the package: the
    // entitlement gate sits ABOVE every user-scoped rule, so a grant cannot
    // reach past it even when an administrator deliberately made one.
    const r = resolve({
      role: 'owner',
      modules: new Set(['accounting']),
      overrides: grant('manufacturing', 'post'),
    });
    const cell = r.get('manufacturing', 'post');
    expect(cell.allowed).toBe(false);
    expect(cell.source).toBe('not_entitled');
    // …and the configuration is reported as intact, not as absent.
    expect(cell.override).toBe('grant');
    expect(cell.blockedByEntitlement).toBe(true);
  });

  it('preserves configuration through a downgrade and restores it on upgrade', () => {
    const overrides = grant('manufacturing', 'post');

    const downgraded = resolve({ role: 'member', modules: new Set(['accounting']), overrides });
    expect(downgraded.allowed('manufacturing', 'post')).toBe(false);
    expect(downgraded.get('manufacturing', 'post').blockedByEntitlement).toBe(true);

    // The SAME override, with the module back. Nothing was rewritten in between.
    const upgraded = resolve({ role: 'member', modules: new Set(['accounting', 'manufacturing']), overrides });
    expect(upgraded.allowed('manufacturing', 'post')).toBe(true);
    expect(upgraded.get('manufacturing', 'post').source).toBe('user_grant');
  });

  it('refuses everything except the Terms when the subscription is not live', () => {
    const r = resolve({ role: 'owner', entitlementActive: false });
    /*
     * `legal_terms` is the ONE named exemption. Acceptance is a precondition of
     * using the product, so gating it behind an active subscription would
     * deadlock a lapsed customer: they cannot accept because they have not
     * paid, and the acceptance they owe is waiting when they do. The assertion
     * is written as "everything but this subject" rather than relaxed to
     * "mostly", so a second exemption added later fails here.
     */
    const refused = r.permissions.filter((p) => !p.allowed);
    const allowed = r.permissions.filter((p) => p.allowed);
    expect(refused.length).toBeGreaterThan(0);
    expect(new Set(allowed.map((p) => p.subject))).toEqual(new Set(['legal_terms']));

    expect(r.get('invoices', 'view').source).toBe('subscription_inactive');
    // Still reported as configured, so a reactivation is visibly a restoration.
    expect(r.get('invoices', 'view').blockedByEntitlement).toBe(true);
  });

  it('allows ungated subjects only while the subscription is live', () => {
    // `dashboard` has no required module, but it is not outside the gate.
    expect(resolve({ role: 'viewer' }).allowed('dashboard', 'view')).toBe(true);
    expect(resolve({ role: 'viewer', entitlementActive: false }).allowed('dashboard', 'view')).toBe(false);
  });
});

/* ── Status restrictions ──────────────────────────────────────────────────── */

describe('user status restrictions', () => {
  it('refuses a disabled account everything', () => {
    for (const status of ['disabled', 'locked', 'pending_verification']) {
      const r = resolve({ role: 'owner', accountStatus: status });
      expect(r.permissions.every((p) => !p.allowed), `status ${status} allowed something`).toBe(true);
      expect(r.get('invoices', 'view').source).toBe('account_inactive');
    }
  });

  it('refuses a disabled account even when it holds a platform role', () => {
    // Account status is rule 1a and platform elevation is 1b, in that order, so
    // a suspended operator is refused rather than elevated.
    const r = resolve({ platformRoles: ['super_admin'], accountStatus: 'disabled', role: null });
    expect(r.permissions.every((p) => !p.allowed)).toBe(true);
  });

  it('refuses a suspended or merely invited membership', () => {
    for (const status of ['suspended', 'invited']) {
      const r = resolve({ role: 'owner', membershipStatus: status });
      expect(r.permissions.every((p) => !p.allowed)).toBe(true);
      expect(r.get('invoices', 'view').source).toBe('membership_inactive');
    }
  });

  it('refuses a non-member, overrides notwithstanding', () => {
    const r = resolve({ role: null, membershipStatus: null, overrides: grant('invoices', 'post') });
    expect(r.allowed('invoices', 'post')).toBe(false);
    expect(r.get('invoices', 'post').source).toBe('no_membership');
  });
});

/* ── Platform elevation ───────────────────────────────────────────────────── */

describe('platform super administrator', () => {
  it('is allowed everything without a membership or an entitlement', () => {
    const r = resolve({
      platformRoles: ['super_admin'],
      role: null,
      membershipStatus: null,
      entitlementActive: false,
      modules: new Set(),
    });
    expect(r.permissions.every((p) => p.allowed)).toBe(true);
    expect(r.get('manufacturing', 'post').source).toBe('platform_super_admin');
  });

  it('does not elevate other platform roles', () => {
    for (const role of ['billing_admin', 'support']) {
      const r = resolve({ platformRoles: [role], role: null, membershipStatus: null });
      expect(r.permissions.every((p) => !p.allowed), `${role} was elevated`).toBe(true);
    }
  });
});

/* ── Shape ────────────────────────────────────────────────────────────────── */

describe('the resolved shape', () => {
  it('returns exactly one entry per catalogue cell', () => {
    const r = resolve();
    expect(r.permissions.length).toBe(allPermissionKeys().length);
    const keys = r.permissions.map((p) => permissionKey(p.subject, p.action));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('explains every refusal with a source', () => {
    const r = resolve({ role: 'viewer', modules: new Set(['accounting']) });
    for (const permission of r.permissions) {
      expect(permission.source).toBeTruthy();
      if (permission.allowed) {
        expect(['role', 'user_grant', 'platform_super_admin']).toContain(permission.source);
      }
    }
  });
});
