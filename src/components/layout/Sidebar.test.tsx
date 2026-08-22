// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Sidebar } from './Sidebar';
import { useStore } from '@/store/useStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { FULL_ACCESS_MODULE_IDS } from '@/lib/platformEntitlementOverride';
import { EDITION_MODULES } from '@/config/editions';
import { sidebarPreferenceKey } from '@/lib/sidebarPreferences';

function group(label: string): HTMLButtonElement {
  return screen.getAllByRole('button', { name: label }).find((button) => button.hasAttribute('aria-expanded')) as HTMLButtonElement;
}

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  useStore.setState({ activeView: 'dashboard' });
  useEntitlementStore.setState({ effectiveModuleIds: [...FULL_ACCESS_MODULE_IDS] });
  useAuthStore.setState({ currentUserId: 'user-sidebar' });
  useOrganizationStore.setState({ organization: { id: 'org-sidebar' } as never });
  useAccountSessionStore.setState({ demoActive: false });
});

afterEach(() => cleanup());

describe('collapsible sidebar navigation', () => {
  it('renders every defined group when it has authorized children', () => {
    render(<Sidebar />);
    for (const label of [
      'Accounting', 'Financial Statements', 'Sales', 'Purchasing', 'Master Data',
      'Projects', 'Cost Centers', 'Fixed Assets', 'Inventory', 'Manufacturing',
      'Financial Settings', 'Tax', 'System',
    ]) expect(group(label)).toBeTruthy();
  });

  it('expands and collapses independently with accessible state', () => {
    render(<Sidebar />);
    expect(group('Accounting').getAttribute('aria-expanded')).toBe('true');
    expect(group('Sales').getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(group('Sales'));
    fireEvent.click(group('Purchasing'));
    expect(group('Sales').getAttribute('aria-expanded')).toBe('true');
    expect(group('Purchasing').getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(group('Sales'));
    expect(group('Sales').getAttribute('aria-expanded')).toBe('false');
    expect(group('Purchasing').getAttribute('aria-expanded')).toBe('true');
  });

  it('opens the active group and highlights its child', () => {
    useStore.setState({ activeView: 'cash-flow' });
    render(<Sidebar />);

    expect(group('Financial Statements').getAttribute('aria-expanded')).toBe('true');
    const child = screen.getByRole('button', { name: 'Cash Flow Statement' });
    expect(child.className).toContain('bg-brand-50');
  });

  it('persists expansion across remounts and ignores an obsolete id', () => {
    const key = sidebarPreferenceKey('user-sidebar', 'org-sidebar');
    localStorage.setItem(key, JSON.stringify(['sales', 'obsolete']));
    const first = render(<Sidebar />);
    expect(group('Sales').getAttribute('aria-expanded')).toBe('true');
    first.unmount();

    render(<Sidebar />);
    expect(group('Sales').getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps Items visible for Core while hiding restricted Inventory operations', () => {
    useEntitlementStore.setState({ effectiveModuleIds: [...EDITION_MODULES.core] });
    render(<Sidebar />);

    expect(group('Master Data')).toBeTruthy();
    fireEvent.click(group('Master Data'));
    expect(screen.getByRole('button', { name: 'Items' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Inventory' })).toBeNull();
  });

  it('shows Inventory and Manufacturing only to entitled users', () => {
    useEntitlementStore.setState({ effectiveModuleIds: [...EDITION_MODULES.manufacturing] });
    render(<Sidebar />);
    expect(group('Inventory')).toBeTruthy();
    expect(group('Manufacturing')).toBeTruthy();
  });

  it('hides groups left without authorized children', () => {
    useEntitlementStore.setState({ effectiveModuleIds: [] });
    render(<Sidebar />);
    expect(screen.queryByRole('button', { name: 'Tax' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manufacturing' })).toBeNull();
  });

  it('supports keyboard activation and preserves the mobile navigation callback', () => {
    const onNavigate = vi.fn();
    render(<Sidebar onNavigate={onNavigate} />);
    group('Sales').focus();
    fireEvent.keyDown(group('Sales'), { key: 'Enter', code: 'Enter' });
    fireEvent.click(group('Sales'));
    const region = document.getElementById(group('Sales').getAttribute('aria-controls')!)!;
    fireEvent.click(within(region).getByRole('button', { name: 'Invoices' }));
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it('keeps a fixed-width, independently scrolling rail without horizontal scrolling', () => {
    const { container } = render(<Sidebar />);
    expect(container.querySelector('aside')?.className).toContain('w-[264px]');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(nav.className).toContain('overflow-y-auto');
    expect(nav.className).toContain('overflow-x-hidden');
  });
});
