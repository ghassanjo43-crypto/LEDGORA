import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore, membersOf, canManageMembers } from './authStore';
import { useEntitlementStore } from './entitlementStore';
import { useSessionStore } from './sessionStore';

const auth = () => useAuthStore.getState();
const ORG = 'org_1';

/** Sign in as an owner of ORG with a given seat limit. */
function ownerSignedIn(userLimit: number): string {
  const id = 'owner_1';
  useAuthStore.setState({
    users: [{ id, fullName: 'Olive Owner', email: 'owner@acme.test', mobile: '+100', country: 'AE', passwordHash: 'h', emailVerified: true, organizationId: ORG, role: 'owner', status: 'active', createdAt: '' }],
    currentUserId: id,
  });
  const sub = useEntitlementStore.getState().subscription;
  useEntitlementStore.getState().replaceSubscription({ ...sub, organizationId: ORG, userLimit });
  return id;
}

beforeEach(() => {
  useAuthStore.getState().resetToDefault();
  useEntitlementStore.getState().resetToDefault();
  useSessionStore.setState({ platformRole: 'none', userName: 'Olive Owner' }); // rely on org role, not platform admin
});

describe('member management', () => {
  it('an owner invites a member (invited + seat consumed) and enforces the seat limit', () => {
    ownerSignedIn(2); // owner + 1 seat free
    expect(canManageMembers()).toBe(true);
    const res = auth().inviteMember({ fullName: 'Ivy Invitee', email: 'ivy@acme.test', role: 'member' });
    expect(res.ok).toBe(true);
    expect(res.verificationToken).toBeTruthy();
    const members = membersOf(auth().users, ORG);
    expect(members).toHaveLength(2);
    const invited = members.find((m) => m.email === 'ivy@acme.test')!;
    expect(invited.status).toBe('invited');
    expect(invited.passwordHash).toBe(''); // no password until they accept

    // Seat limit reached (2 used) → further invites blocked.
    const blocked = auth().inviteMember({ fullName: 'Sam', email: 'sam@acme.test', role: 'member' });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/plan allows 2 users/i);
  });

  it('rejects inviting an owner and duplicate emails', () => {
    ownerSignedIn(10);
    expect(auth().inviteMember({ fullName: 'X', email: 'x@acme.test', role: 'owner' }).ok).toBe(false);
    auth().inviteMember({ fullName: 'Y', email: 'y@acme.test', role: 'member' });
    expect(auth().inviteMember({ fullName: 'Y2', email: 'y@acme.test', role: 'member' }).ok).toBe(false);
  });

  it('changes roles, suspends (blocking login + freeing a seat) and removes members', () => {
    ownerSignedIn(5);
    const inv = auth().inviteMember({ fullName: 'Ivy', email: 'ivy@acme.test', role: 'member' });
    const memberId = inv.id!;
    // Activate the invitee (as if they accepted the invite).
    useAuthStore.setState({ users: auth().users.map((u) => (u.id === memberId ? { ...u, emailVerified: true, status: 'active', passwordHash: 'ok' } : u)) });

    expect(auth().updateMemberRole(memberId, 'admin').ok).toBe(true);
    expect(membersOf(auth().users, ORG).find((m) => m.id === memberId)!.role).toBe('admin');

    expect(auth().setMemberStatus(memberId, 'suspended').ok).toBe(true);
    // Suspended frees a seat.
    expect(membersOf(auth().users, ORG).filter((m) => m.status !== 'suspended')).toHaveLength(1);

    expect(auth().removeMember(memberId).ok).toBe(true);
    expect(membersOf(auth().users, ORG)).toHaveLength(1);
  });

  it('protects the last owner and blocks non-managers', () => {
    const ownerId = ownerSignedIn(5);
    // Cannot demote or suspend the only owner.
    expect(auth().updateMemberRole(ownerId, 'member').ok).toBe(false);
    expect(auth().setMemberStatus(ownerId, 'suspended').ok).toBe(false); // also: can't change your own status

    // A plain member cannot manage members.
    const inv = auth().inviteMember({ fullName: 'Ivy', email: 'ivy@acme.test', role: 'member' });
    useAuthStore.setState({ currentUserId: inv.id! });
    expect(canManageMembers()).toBe(false);
    expect(auth().inviteMember({ fullName: 'Z', email: 'z@acme.test', role: 'member' }).ok).toBe(false);
  });
});
