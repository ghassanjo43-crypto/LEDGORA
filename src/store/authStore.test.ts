import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore, getCurrentUser } from './authStore';

const auth = () => useAuthStore.getState();

const goodInput = {
  fullName: 'Jane Owner',
  email: 'Jane@Company.com',
  mobile: '+971500000000',
  country: 'AE',
  password: 'Secret123',
  acceptedTerms: true,
  intendedPlanCode: 'professional',
};

beforeEach(() => {
  useAuthStore.getState().resetToDefault();
});

describe('registration', () => {
  it('rejects invalid input with field errors', () => {
    const res = auth().register({ ...goodInput, email: 'nope', password: 'short', acceptedTerms: false });
    expect(res.ok).toBe(false);
    expect(res.fieldErrors).toMatchObject({ email: expect.any(String), password: expect.any(String), acceptedTerms: expect.any(String) });
  });

  it('registers a user (unverified), lower-cases email, stores only a hash, keeps the intended plan', () => {
    const res = auth().register(goodInput);
    expect(res.ok).toBe(true);
    expect(res.verificationToken).toBeTruthy();
    const user = getCurrentUser()!;
    expect(user.email).toBe('jane@company.com');
    expect(user.emailVerified).toBe(false);
    expect(user.role).toBe('owner');
    expect(user.intendedPlanCode).toBe('professional');
    // never store the raw password
    expect(JSON.stringify(user)).not.toContain('Secret123');
  });

  it('prevents duplicate accounts for the same email', () => {
    auth().register(goodInput);
    const res = auth().register(goodInput);
    expect(res.ok).toBe(false);
    expect(res.fieldErrors?.email).toMatch(/already exists/i);
  });
});

describe('email verification + login', () => {
  it('verifies via token and signs the user in', () => {
    const reg = auth().register(goodInput);
    const res = auth().verifyEmail(reg.verificationToken!);
    expect(res.ok).toBe(true);
    expect(getCurrentUser()!.emailVerified).toBe(true);
  });

  it('rejects an unknown verification token', () => {
    expect(auth().verifyEmail('evt_bogus').ok).toBe(false);
  });

  it('logs in with the correct password and rejects a wrong one', () => {
    auth().register(goodInput);
    auth().logout();
    expect(auth().login('jane@company.com', 'WrongPass9').ok).toBe(false);
    const ok = auth().login('  JANE@company.com ', 'Secret123');
    expect(ok.ok).toBe(true);
    expect(auth().currentUserId).toBeTruthy();
  });
});
