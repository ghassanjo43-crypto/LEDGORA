/**
 * Customer authentication store (tenant users — distinct from the platform
 * super-administrator role in `sessionStore`).
 *
 * Owns registered users, the current session and email-verification tokens.
 * Passwords are only ever stored as a non-reversible mock hash (seam for a real
 * argon2/bcrypt backend); the raw password never leaves the register/login call.
 *
 * Persisted under a NEW key `ledgora-auth`. Selector-safety: components select
 * the stored `users` array or a primitive — derived lists go through useMemo.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { MemberStatus, OrgUserRole, RegisteredUser } from '@/types/onboarding';
import { useEntitlementStore } from './entitlementStore';
import { isPlatformAdminFullAccess } from './platformFullAccess';
import { getPlatformRole } from './sessionStore';
import { hasPlatformCapability } from '@/lib/platformAccess';
import {
  isValidEmail,
  isValidMobile,
  makeVerificationToken,
  mockHashPassword,
  passwordProblem,
  verifyMockPassword,
} from '@/lib/onboardingData';
import { generateId, nowIso } from '@/lib/utils';

export interface AuthResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  id?: string;
  /** Verification token surfaced to the demo UI (a real backend emails it). */
  verificationToken?: string;
}

export interface RegisterInput {
  fullName: string;
  email: string;
  mobile: string;
  country: string;
  password: string;
  acceptedTerms: boolean;
  intendedPlanCode?: string;
}

interface AuthState {
  users: RegisteredUser[];
  currentUserId: string | null;

  register: (input: RegisterInput) => AuthResult;
  verifyEmail: (token: string) => AuthResult;
  resendVerification: (email: string) => AuthResult;
  login: (email: string, password: string) => AuthResult;
  logout: () => void;

  /** Link the signed-in user to an organization + set their role. */
  attachOrganization: (organizationId: string, role?: OrgUserRole) => void;
  /** Internal/seed use: insert a fully-formed user. */
  upsertUser: (user: RegisteredUser) => void;
  /**
   * Adopt an identity the BACKEND already verified, making it the current user.
   *
   * The credential check happened on the server; this only mirrors the result
   * into the local read model so the existing pages and access gate keep
   * working. It performs no password check of its own and must therefore never
   * be called from a path that has not just been authenticated by the server.
   */
  adoptVerifiedSession: (user: RegisteredUser) => void;

  /* ── Organization member management (owner/admin) ─────────────────────── */
  inviteMember: (input: { fullName: string; email: string; mobile?: string; role: OrgUserRole }) => AuthResult;
  updateMemberRole: (userId: string, role: OrgUserRole) => AuthResult;
  setMemberStatus: (userId: string, status: MemberStatus) => AuthResult;
  removeMember: (userId: string) => AuthResult;

  resetToDefault: () => void;
}

/** Only an org owner/admin (or the platform super-admin) may manage members. */
function assertCanManageMembers(actor: RegisteredUser | null): AuthResult {
  // A LEDGORA operator may administer any tenant — but only when the
  // platform policy actually grants it (never in production).
  if (hasPlatformCapability(getPlatformRole(), 'manage-any-organization')) return { ok: true };
  if (actor && (actor.role === 'owner' || actor.role === 'admin')) return { ok: true };
  return { ok: false, error: 'Only an organization owner or admin can manage members.' };
}

/** True when `target` is the only non-suspended owner of its organization. */
function lastOwner(users: RegisteredUser[], target: RegisteredUser): boolean {
  const owners = users.filter((u) => u.organizationId === target.organizationId && u.role === 'owner' && u.status !== 'suspended');
  return owners.length <= 1;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      users: [],
      currentUserId: null,

      register: (input) => {
        const fieldErrors: Record<string, string> = {};
        const fullName = input.fullName.trim();
        const email = input.email.trim().toLowerCase();
        const mobile = input.mobile.trim();
        if (!fullName) fieldErrors.fullName = 'Full name is required.';
        if (!isValidEmail(email)) fieldErrors.email = 'Enter a valid business email.';
        // Mobile is optional at signup (a contact number can be added later),
        // but a supplied value must still be a valid number.
        if (mobile && !isValidMobile(mobile)) fieldErrors.mobile = 'Enter a valid mobile number.';
        if (!input.country) fieldErrors.country = 'Select your country.';
        const pw = passwordProblem(input.password);
        if (pw) fieldErrors.password = pw;
        if (!input.acceptedTerms) fieldErrors.acceptedTerms = 'You must accept the terms to continue.';
        if (get().users.some((u) => u.email === email)) {
          fieldErrors.email = 'An account with this email already exists.';
        }
        if (Object.keys(fieldErrors).length > 0) {
          return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors };
        }

        const token = makeVerificationToken();
        const user: RegisteredUser = {
          id: generateId('usr'),
          fullName,
          email,
          mobile,
          country: input.country,
          passwordHash: mockHashPassword(input.password),
          emailVerified: false,
          verificationToken: token,
          termsAcceptedAt: nowIso(),
          role: 'owner',
          intendedPlanCode: input.intendedPlanCode,
          createdAt: nowIso(),
        };
        set((s) => ({ users: [...s.users, user], currentUserId: user.id }));
        return { ok: true, id: user.id, verificationToken: token };
      },

      verifyEmail: (token) => {
        const user = get().users.find((u) => u.verificationToken === token);
        if (!user) return { ok: false, error: 'This verification link is invalid or has already been used.' };
        set((s) => ({
          users: s.users.map((u) =>
            u.id === user.id ? { ...u, emailVerified: true, verificationToken: undefined } : u,
          ),
          // Verifying signs the user in (they just clicked their own link).
          currentUserId: user.id,
        }));
        return { ok: true, id: user.id };
      },

      resendVerification: (email) => {
        const target = email.trim().toLowerCase();
        const user = get().users.find((u) => u.email === target);
        if (!user) return { ok: false, error: 'No account found for that email.' };
        if (user.emailVerified) return { ok: false, error: 'This email is already verified.' };
        const token = makeVerificationToken();
        set((s) => ({
          users: s.users.map((u) => (u.id === user.id ? { ...u, verificationToken: token } : u)),
        }));
        return { ok: true, id: user.id, verificationToken: token };
      },

      login: (email, password) => {
        const target = email.trim().toLowerCase();
        const user = get().users.find((u) => u.email === target);
        if (!user || !verifyMockPassword(password, user.passwordHash)) {
          return { ok: false, error: 'Incorrect email or password.' };
        }
        if (user.status === 'suspended') {
          return { ok: false, error: 'This account has been suspended. Contact your organization owner.' };
        }
        set((s) => ({
          currentUserId: user.id,
          users: s.users.map((u) => (u.id === user.id ? { ...u, lastLoginAt: nowIso() } : u)),
        }));
        return { ok: true, id: user.id };
      },

      logout: () => set({ currentUserId: null }),

      attachOrganization: (organizationId, role = 'owner') => {
        const id = get().currentUserId;
        if (!id) return;
        set((s) => ({
          users: s.users.map((u) => (u.id === id ? { ...u, organizationId, role } : u)),
        }));
      },

      upsertUser: (user) =>
        set((s) => ({
          users: s.users.some((u) => u.id === user.id)
            ? s.users.map((u) => (u.id === user.id ? user : u))
            : [...s.users, user],
        })),

      adoptVerifiedSession: (user) =>
        set((s) => ({
          users: s.users.some((u) => u.id === user.id)
            ? s.users.map((u) => (u.id === user.id ? user : u))
            : [...s.users, user],
          currentUserId: user.id,
        })),

      /* ── Member management ─────────────────────────────────────────────── */
      inviteMember: (input) => {
        const actor = get().users.find((u) => u.id === get().currentUserId) ?? null;
        const guard = assertCanManageMembers(actor);
        if (!guard.ok) return guard;
        const orgId = actor!.organizationId;
        if (!orgId) return { ok: false, error: 'Create your organization first.' };

        const fieldErrors: Record<string, string> = {};
        const fullName = input.fullName.trim();
        const email = input.email.trim().toLowerCase();
        if (!fullName) fieldErrors.fullName = 'Full name is required.';
        if (!isValidEmail(email)) fieldErrors.email = 'Enter a valid email.';
        if (input.mobile && !isValidMobile(input.mobile)) fieldErrors.mobile = 'Enter a valid mobile number.';
        if (input.role === 'owner') fieldErrors.role = 'A new member cannot be an owner.';
        if (get().users.some((u) => u.email === email)) fieldErrors.email = 'A user with this email already exists.';
        if (Object.keys(fieldErrors).length > 0) return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors };

        // Enforce the subscription seat limit (active + invited members). A
        // platform administrator in full-access operator mode is not blocked by
        // the subscriber's limit (diagnostics/support), but the limit itself is
        // untouched — the workspace keeps showing its real over-limit warnings.
        const limit = useEntitlementStore.getState().subscription.userLimit;
        const seatsUsed = get().users.filter((u) => u.organizationId === orgId && u.status !== 'suspended').length;
        if (seatsUsed >= limit && !isPlatformAdminFullAccess()) {
          return { ok: false, error: `Your plan allows ${limit} users. Upgrade or free a seat to add another.` };
        }

        const token = makeVerificationToken();
        const member: RegisteredUser = {
          id: generateId('usr'),
          fullName,
          email,
          mobile: input.mobile?.trim() ?? '',
          country: actor!.country,
          passwordHash: '', // set by the invitee when they accept (email seam)
          emailVerified: false,
          verificationToken: token,
          organizationId: orgId,
          role: input.role,
          status: 'invited',
          invitedAt: nowIso(),
          invitedBy: actor!.fullName,
          createdAt: nowIso(),
        };
        set((s) => ({ users: [...s.users, member] }));
        return { ok: true, id: member.id, verificationToken: token };
      },

      updateMemberRole: (userId, role) => {
        const actor = get().users.find((u) => u.id === get().currentUserId) ?? null;
        const guard = assertCanManageMembers(actor);
        if (!guard.ok) return guard;
        const target = get().users.find((u) => u.id === userId);
        if (!target || target.organizationId !== actor!.organizationId) return { ok: false, error: 'Member not found.' };
        if (target.role === 'owner' && role !== 'owner' && lastOwner(get().users, target)) {
          return { ok: false, error: 'The organization must keep at least one owner.' };
        }
        set((s) => ({ users: s.users.map((u) => (u.id === userId ? { ...u, role } : u)) }));
        return { ok: true, id: userId };
      },

      setMemberStatus: (userId, status) => {
        const actor = get().users.find((u) => u.id === get().currentUserId) ?? null;
        const guard = assertCanManageMembers(actor);
        if (!guard.ok) return guard;
        const target = get().users.find((u) => u.id === userId);
        if (!target || target.organizationId !== actor!.organizationId) return { ok: false, error: 'Member not found.' };
        if (target.id === actor!.id) return { ok: false, error: 'You cannot change your own status.' };
        if (status === 'suspended' && target.role === 'owner' && lastOwner(get().users, target)) {
          return { ok: false, error: 'The last owner cannot be suspended.' };
        }
        set((s) => ({ users: s.users.map((u) => (u.id === userId ? { ...u, status } : u)) }));
        return { ok: true, id: userId };
      },

      removeMember: (userId) => {
        const actor = get().users.find((u) => u.id === get().currentUserId) ?? null;
        const guard = assertCanManageMembers(actor);
        if (!guard.ok) return guard;
        const target = get().users.find((u) => u.id === userId);
        if (!target || target.organizationId !== actor!.organizationId) return { ok: false, error: 'Member not found.' };
        if (target.id === actor!.id) return { ok: false, error: 'You cannot remove yourself.' };
        if (target.role === 'owner') return { ok: false, error: 'Transfer ownership before removing an owner.' };
        set((s) => ({ users: s.users.filter((u) => u.id !== userId) }));
        return { ok: true, id: userId };
      },

      resetToDefault: () => set({ users: [], currentUserId: null }),
    }),
    { name: 'ledgora-auth', version: 1 },
  ),
);

/** The signed-in user, or null. Call from useMemo / imperatively. */
export function getCurrentUser(): RegisteredUser | null {
  const { users, currentUserId } = useAuthStore.getState();
  return users.find((u) => u.id === currentUserId) ?? null;
}

/** Members of an organization (derive in useMemo — never a fresh selector). */
export function membersOf(users: RegisteredUser[], organizationId?: string): RegisteredUser[] {
  if (!organizationId) return [];
  return users.filter((u) => u.organizationId === organizationId);
}

/** Whether the signed-in user may manage members (owner/admin or platform admin). */
export function canManageMembers(): boolean {
  const actor = getCurrentUser();
  return (
    hasPlatformCapability(getPlatformRole(), 'manage-any-organization') ||
    (!!actor && (actor.role === 'owner' || actor.role === 'admin'))
  );
}
