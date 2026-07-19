// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useEntitlementStore } from '@/store/entitlementStore';
import { FeatureGate } from './FeatureGate';
import { ModuleRoute } from './ModuleRoute';
import { DevelopmentEditionSwitcher } from './DevelopmentEditionSwitcher';

const ent = () => useEntitlementStore.getState();

beforeEach(() => {
  ent().resetToDefault();
});

afterEach(() => cleanup());

describe('FeatureGate', () => {
  it('hides children when the module is not owned and shows them when it is', () => {
    ent().setEdition('core');
    const { rerender } = render(
      <FeatureGate module="projects" fallback={<span>hidden</span>}>
        <span>projects-content</span>
      </FeatureGate>,
    );
    expect(screen.queryByText('projects-content')).toBeNull();
    expect(screen.getByText('hidden')).toBeTruthy();

    ent().setEdition('projects');
    rerender(
      <FeatureGate module="projects" fallback={<span>hidden</span>}>
        <span>projects-content</span>
      </FeatureGate>,
    );
    expect(screen.getByText('projects-content')).toBeTruthy();
  });
});

describe('ModuleRoute', () => {
  it('renders the module-unavailable page for a blocked route (e.g. typed URL / refresh)', () => {
    ent().setEdition('core');
    render(<ModuleRoute module="construction_boq" element={<div>boq-page</div>} />);
    expect(screen.queryByText('boq-page')).toBeNull();
    expect(screen.getAllByText(/not available|not included/i).length).toBeGreaterThan(0);
  });

  it('renders the protected element when the module is owned', () => {
    ent().setEdition('construction');
    render(<ModuleRoute module="construction_boq" element={<div>boq-page</div>} />);
    expect(screen.getByText('boq-page')).toBeTruthy();
  });

  it('blocks a manufacturing route for Core and allows it for Manufacturing (refresh-safe)', () => {
    ent().setEdition('core');
    const { rerender } = render(
      <ModuleRoute module="manufacturing_work_orders" element={<div>wo-page</div>} />,
    );
    expect(screen.queryByText('wo-page')).toBeNull();

    ent().setEdition('manufacturing');
    rerender(<ModuleRoute module="manufacturing_work_orders" element={<div>wo-page</div>} />);
    expect(screen.getByText('wo-page')).toBeTruthy();
  });
});

describe('DevelopmentEditionSwitcher', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is hidden without the explicit development opt-in', () => {
    // No VITE_LEDGORA_DEV_TOOLS → the switcher must not render.
    vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', '');
    render(<DevelopmentEditionSwitcher />);
    expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull();
  });

  it('is hidden in a production build even with the opt-in set', () => {
    vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', 'true');
    vi.stubEnv('DEV', false);
    render(<DevelopmentEditionSwitcher />);
    expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull();
  });

  it('switches edition and updates a gated child immediately (no reload, no crash)', () => {
    ent().setEdition('core');
    render(
      <div>
        <DevelopmentEditionSwitcher />
        <FeatureGate module="projects">
          <span>projects-live</span>
        </FeatureGate>
      </div>,
    );
    expect(screen.queryByText('projects-live')).toBeNull();

    // Click the "Projects" edition button in the dev switcher.
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    expect(ent().subscription.edition).toBe('projects');
    expect(screen.getByText('projects-live')).toBeTruthy();
  });
});
