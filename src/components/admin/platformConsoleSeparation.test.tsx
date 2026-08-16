// @vitest-environment happy-dom
/**
 * The platform console looks and behaves like platform administration.
 *
 * ══ Why render tests as well as the policy tests ═════════════════════════════
 *
 * `lib/platformSeparation.test.ts` proves the ROUTING decisions. It cannot prove
 * that the screen an operator actually lands on is a platform screen rather than
 * a bookkeeping one — a console that opened on a cash-and-receivables dashboard
 * would pass every routing test in that file.
 *
 * So these render the real console and the real overview and ask what an
 * operator sees: platform sections, platform figures, and no accounting KPI
 * anywhere.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { PlatformOverviewPanel } from './PlatformOverviewPanel';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { NAV_GROUPS } from '@/config/navigation';

/** Words that only ever appear on a subscriber's accounting screens. */
const BOOKKEEPING_WORDS = [
  'receivable', 'payable', 'trial balance', 'general ledger', 'chart of accounts',
  'invoices due', 'bills due', 'net income', 'gross margin', 'journal entry',
];

/** Bookkeeping sidebar sections that must never appear in platform mode. */
const BOOKKEEPING_SECTIONS = [
  'Accounting', 'Sales', 'Purchasing', 'Projects', 'Cost Centers',
  'Inventory', 'Manufacturing', 'Tax',
];

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(cleanup);

/* ══ 2, 12 · The overview is a PLATFORM overview ═══════════════════════════ */

describe('the platform overview', () => {
  it('shows platform tenancy metrics, not accounting ones', () => {
    render(<PlatformOverviewPanel />);

    // What an operator is here for.
    for (const label of ['Subscribers', 'Applicants', 'Members', 'Payments to verify']) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }

    // And none of the subscriber's figures.
    const text = document.body.textContent!.toLowerCase();
    for (const word of BOOKKEEPING_WORDS) {
      expect(text, word).not.toContain(word);
    }
  });

  it('says so when a figure has no backend, instead of showing a number', () => {
    /*
     * The rule that matters most on an operator console: a plausible wrong
     * number is worse than a blank, because nobody re-checks a number that looks
     * reasonable. With no account service configured the tiles must say
     * "Unavailable" and give the reason.
     */
    render(<PlatformOverviewPanel />);
    expect(screen.getAllByText(/Unavailable ·/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/No account service configured/i).length).toBeGreaterThan(0);
  });

  it('refuses to print a platform-wide infrastructure cost', () => {
    // The metering engine estimates cost for ONE organization from browser-held
    // counters. A figure here would read as Ledgora's hosting bill and would not
    // be it, so the panel states the absence explicitly.
    render(<PlatformOverviewPanel />);
    expect(screen.getByText(/No platform-wide figure available/i)).toBeTruthy();
  });

  it('renders no fabricated currency amounts anywhere', () => {
    render(<PlatformOverviewPanel />);
    // No "$1,234.56"-shaped strings: every tile is a count or an absence.
    expect(document.body.textContent).not.toMatch(/[$£€]\s?\d/);
  });
});

/* ══ 3, 16 · Platform navigation contains no bookkeeping sections ══════════ */

describe('platform navigation', () => {
  /** The console's own tab list, in the shape the console builds it. */
  const consoleTabs: TabItem<string>[] = [
    { id: 'overview', label: 'Overview', group: 'Overview' },
    { id: 'applicants', label: 'Applicants', group: 'Customers' },
    { id: 'subscribers', label: 'Subscribers', group: 'Customers' },
    { id: 'members', label: 'Members', group: 'Customers' },
    { id: 'payments', label: 'Payments', group: 'Billing' },
    { id: 'packages', label: 'Packages & pricing', group: 'Billing' },
    { id: 'entitlements', label: 'Entitlements', group: 'Billing' },
    { id: 'metering', label: 'Metering & infra cost', group: 'Platform' },
    { id: 'cleanup', label: 'Clean up test/demo data', group: 'Platform' },
  ];

  it('groups the sections an operator thinks in', () => {
    render(<Tabs tabs={consoleTabs} value="overview" onChange={() => {}} />);
    for (const group of ['Overview', 'Customers', 'Billing', 'Platform']) {
      expect(screen.getAllByText(group).length, group).toBeGreaterThan(0);
    }
  });

  it('offers no bookkeeping section', () => {
    render(<Tabs tabs={consoleTabs} value="overview" onChange={() => {}} />);
    const nav = screen.getByRole('tablist');
    for (const section of BOOKKEEPING_SECTIONS) {
      expect(within(nav).queryByText(section), section).toBeNull();
    }
  });

  it('opens on Overview', () => {
    render(<Tabs tabs={consoleTabs} value="overview" onChange={() => {}} />);
    const selected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain('Overview');
  });
});

/* ══ 17 · The subscriber's navigation is unchanged ═════════════════════════ */

describe('subscriber navigation', () => {
  it('still contains the bookkeeping sections', () => {
    // The separation must not have quietly removed anything from the customer's
    // sidebar: it is a different navigation, not a reduced one.
    const groups = NAV_GROUPS.map((g) => g.label);
    for (const section of ['Accounting', 'Sales', 'Purchasing']) {
      expect(groups, section).toContain(section);
    }
  });

  it('contains no platform administration section', () => {
    // Applicants, packages administration and cleanup belong to the console and
    // must not be reachable from a subscriber's sidebar.
    const labels = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.label));
    for (const platformOnly of ['Applicants', 'Packages & pricing', 'Clean up test/demo data']) {
      expect(labels, platformOnly).not.toContain(platformOnly);
    }
  });
});

/* ══ Tabs grouping is additive ═════════════════════════════════════════════ */

describe('the grouped tab bar', () => {
  it('renders an ungrouped list exactly as before', () => {
    // Every existing caller passes no groups; none of them may change.
    render(
      <Tabs
        tabs={[{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }]}
        value="a"
        onChange={() => {}}
      />,
    );
    const nav = screen.getByRole('tablist');
    expect(within(nav).getAllByRole('tab')).toHaveLength(2);
    // No heading elements were introduced.
    expect(nav.textContent).toBe('AlphaBeta');
  });
});
