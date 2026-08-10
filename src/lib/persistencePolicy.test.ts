import { describe, it, expect } from 'vitest';
import { resolvePersistencePolicy, canPersistFor } from './persistencePolicy';
import { storageModeFor } from './freeDemoSession';
import { resolveAccountStatus, canOpenApplication } from './sessionModel';
import type { RegisteredUser } from '@/types/onboarding';

const user: RegisteredUser = {
  id: 'u1',
  fullName: 'Jane Owner',
  email: 'jane@acme.test',
  mobile: '',
  country: 'AE',
  passwordHash: 'hash',
  emailVerified: true,
  role: 'owner',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const base = {
  user,
  organizationId: 'org1',
  onboardingStatus: null,
  entitlementStatus: 'active',
  subscriptionPlanId: null,
  demoActive: false,
} as const;

describe('persistence policy', () => {
  it('refuses permanent storage for anonymous, unsubscribed, demo and suspended accounts', () => {
    expect(canPersistFor('anonymous')).toBe(false);
    expect(canPersistFor('registered-no-plan')).toBe(false);
    expect(canPersistFor('free-demo')).toBe(false);
    expect(canPersistFor('suspended')).toBe(false);
  });

  it('allows the backend persistence path for paid and trial accounts', () => {
    expect(resolvePersistencePolicy({ accountStatus: 'subscribed' })).toEqual({
      canPersistBusinessData: true,
      storageMode: 'backend',
    });
    expect(resolvePersistencePolicy({ accountStatus: 'trial' })).toEqual({
      canPersistBusinessData: true,
      storageMode: 'backend',
    });
    expect(resolvePersistencePolicy({ accountStatus: 'trial', trialAllowsStorage: false })).toEqual({
      canPersistBusinessData: false,
      storageMode: 'memory',
    });
  });

  it('follows the existing grace-period rules for a past-due subscription', () => {
    expect(resolvePersistencePolicy({ accountStatus: 'past-due', inGracePeriod: true }).canPersistBusinessData).toBe(true);
    expect(resolvePersistencePolicy({ accountStatus: 'past-due', inGracePeriod: false }).canPersistBusinessData).toBe(false);
  });

  it('routes anonymous and demo workspaces to memory-only storage', () => {
    expect(storageModeFor('anonymous')).toBe('memory');
    expect(storageModeFor('free-demo')).toBe('memory');
    expect(storageModeFor('subscribed')).toBe('backend');
  });
});

describe('account status resolution', () => {
  it('is anonymous with no user and no demo', () => {
    expect(resolveAccountStatus({ ...base, user: null })).toBe('anonymous');
  });

  it('is registered-no-plan for a new account that has selected nothing', () => {
    expect(resolveAccountStatus(base)).toBe('registered-no-plan');
    // A draft is an unconfirmed choice with no invoice — still onboarding.
    expect(resolveAccountStatus({ ...base, onboardingStatus: 'draft' })).toBe('registered-no-plan');
  });

  it('is free-preview once a package is selected and payment is being verified', () => {
    expect(resolveAccountStatus({ ...base, onboardingStatus: 'pending_payment' })).toBe('free-preview');
    expect(resolveAccountStatus({ ...base, onboardingStatus: 'pending_verification' })).toBe('free-preview');
  });

  it('never grants free-preview without an organization', () => {
    expect(
      resolveAccountStatus({ ...base, organizationId: null, onboardingStatus: 'pending_verification' }),
    ).toBe('registered-no-plan');
  });

  it('keeps lapsed and withdrawn subscriptions on their own restrictions', () => {
    expect(resolveAccountStatus({ ...base, onboardingStatus: 'suspended' })).toBe('suspended');
    // Expired is not a preview: the subscription lapsed, it is not being set up.
    expect(resolveAccountStatus({ ...base, onboardingStatus: 'expired' })).toBe('registered-no-plan');
  });

  it('free-preview opens the app, and never persists', () => {
    expect(canOpenApplication('free-preview')).toBe(true);
    expect(canPersistFor('free-preview')).toBe(false);
    expect(storageModeFor('free-preview')).toBe('memory');
  });

  it('is free-demo whenever a demo workspace is running, never a paid status', () => {
    expect(resolveAccountStatus({ ...base, demoActive: true, onboardingStatus: 'active' })).toBe('free-demo');
  });

  it('maps an activated subscription onto its entitlement status', () => {
    expect(resolveAccountStatus({ ...base, onboardingStatus: 'active' })).toBe('subscribed');
    expect(resolveAccountStatus({ ...base, onboardingStatus: 'active', entitlementStatus: 'trial' })).toBe('trial');
    expect(resolveAccountStatus({ ...base, onboardingStatus: 'active', entitlementStatus: 'past-due' })).toBe('past-due');
  });

  it('only lets application-capable statuses open the accounting app', () => {
    expect(canOpenApplication('anonymous')).toBe(false);
    expect(canOpenApplication('registered-no-plan')).toBe(false);
    expect(canOpenApplication('free-demo')).toBe(true);
    expect(canOpenApplication('subscribed')).toBe(true);
  });
});
