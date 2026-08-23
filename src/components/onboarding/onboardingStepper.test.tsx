// @vitest-environment happy-dom
/**
 * The onboarding progress indicator.
 *
 * It used to be purely positional: whatever page you were on, every earlier step
 * was drawn complete. That is how it could report "Organization ✓" on the same
 * screen that refused to continue because the organization was missing — it was
 * describing your position in the funnel, not your state, so it could not
 * contradict anything because it never knew anything.
 *
 * It now reads the same `hasCurrentOrganization` answer as the page, the confirm
 * button and the route guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { Stepper } from './OnboardingChrome';
import { useOrganizationStore } from '@/store/organizationStore';

const API = 'https://api.example.test';

/** The `<li>` for a named step. */
function step(label: string): HTMLElement {
  return screen.getByText(label).closest('li') as HTMLElement;
}

const isTicked = (label: string): boolean => within(step(label)).queryByText('✓') !== null;

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', API);
  useOrganizationStore.getState().resetToDefault();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  useOrganizationStore.getState().resetToDefault();
});

describe('the Organization step', () => {
  it('is ticked on the subscription page when the backend confirmed an organization', () => {
    useOrganizationStore.setState({
      hydration: { status: 'ready', confirmedOrganizationId: 'org-1', error: null },
    });

    render(<Stepper current="Subscription" />);

    expect(isTicked('Company')).toBe(true);
  });

  it('is NOT ticked when the backend confirmed there is no organization', () => {
    // The contradiction this whole fix exists to remove: the indicator must not
    // claim a step is complete that the page below it is blocking on.
    useOrganizationStore.setState({
      hydration: { status: 'ready', confirmedOrganizationId: null, error: null },
    });

    render(<Stepper current="Subscription" />);

    expect(isTicked('Company')).toBe(false);
  });

  it('is NOT ticked while the lookup is still in flight', () => {
    useOrganizationStore.setState({
      hydration: { status: 'loading', confirmedOrganizationId: null, error: null },
    });

    render(<Stepper current="Subscription" />);

    expect(isTicked('Company')).toBe(false);
  });

  it('is NOT ticked merely because a local organization object exists', () => {
    // A persisted object from a previous session is not confirmation.
    useOrganizationStore.setState({
      organization: { id: 'org-stale', legalName: 'Stale Ltd' } as never,
      hydration: { status: 'idle', confirmedOrganizationId: null, error: null },
    });

    render(<Stepper current="Subscription" />);

    expect(isTicked('Company')).toBe(false);
  });
});

describe('the other steps', () => {
  it('still tick positionally — nothing else changed', () => {
    useOrganizationStore.setState({
      hydration: { status: 'ready', confirmedOrganizationId: 'org-1', error: null },
    });

    render(<Stepper current="Payment" />);

    expect(isTicked('Account')).toBe(true);
    expect(isTicked('Verify')).toBe(true);
    expect(isTicked('Subscription')).toBe(true);
    // The current step is active, not done.
    expect(isTicked('Payment')).toBe(false);
  });

  it('never ticks the step you are standing on', () => {
    useOrganizationStore.setState({
      hydration: { status: 'ready', confirmedOrganizationId: 'org-1', error: null },
    });

    render(<Stepper current="Company" />);

    expect(isTicked('Company')).toBe(false);
    expect(isTicked('Subscription')).toBe(false);
  });
});
