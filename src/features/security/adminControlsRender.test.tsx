// @vitest-environment happy-dom
/**
 * Administrator controls must not RENDER in a production build — hiding a menu
 * is not the security control (the store actions are), but a deployed customer
 * must never even be offered platform administration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SuperAdminConsolePage } from '@/pages/SuperAdminConsolePage';
import { DevelopmentEditionSwitcher } from '@/components/entitlements/DevelopmentEditionSwitcher';
import { useSessionStore } from '@/store/sessionStore';
import { useBillingStore } from '@/store/billingStore';

function simulateProductionBuild(): void {
  vi.stubEnv('DEV', false);
  vi.stubEnv('PROD', true);
  vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', 'true');
}

beforeEach(() => {
  localStorage.clear();
  useBillingStore.getState().ensureSeeded();
  // The most privileged value an attacker could plant in browser storage.
  useSessionStore.setState({ platformRole: 'super-admin', userName: 'x' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('administrator controls in a production build', () => {
  it('refuses to render the super-admin console', () => {
    simulateProductionBuild();
    render(<SuperAdminConsolePage />);
    expect(screen.queryByText(/Packages & pricing/i)).toBeNull();
    expect(screen.queryByText(/Metering & infra cost/i)).toBeNull();
    expect(screen.getByText(/platform super-administrator only/i)).toBeTruthy();
  });

  it('refuses to render the development edition switcher', () => {
    simulateProductionBuild();
    const { container } = render(<DevelopmentEditionSwitcher />);
    expect(container.textContent).toBe('');
  });

  it('does render the console for an approved local developer', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('PROD', false);
    vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', 'true');
    render(<SuperAdminConsolePage />);
    expect(screen.getByText(/Packages & pricing/i)).toBeTruthy();
  });
});
