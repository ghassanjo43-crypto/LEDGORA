// @vitest-environment happy-dom
/**
 * The amendment action AS IT IS ACTUALLY MOUNTED: inside a real `Dropdown`.
 *
 * ══ The defect this file exists for ══════════════════════════════════════════
 *
 * Every earlier UI test rendered `AmendMenuItem` on its own. That is not where
 * it lives. It lives in a row's Actions menu, and `Dropdown` closes on ANY
 * click inside its panel (`closeOnClick` defaults true) and renders that panel
 * as `{open && createPortal(...)}` — so closing UNMOUNTS everything in it.
 *
 * While the drawer was a child of the menu item, the click that opened it also
 * closed the menu, which unmounted the item, which destroyed the state that had
 * just been set. Nothing appeared. An enabled action that does nothing when
 * clicked is indistinguishable from a disabled one — which is exactly how a
 * Primary Owner reported it, while a Super Admin (genuinely disabled, so no
 * click event at all) correctly saw their refusal.
 *
 * Rendering standalone could never catch that. These tests mount the real
 * composition.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { Dropdown } from '@/components/ui/Dropdown';
import { AmendMenuItem } from './AmendMenuItem';
import { AmendmentDrawerHost } from './AmendmentDrawerHost';
import { ToastProvider } from '@/components/ui/Toast';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useInvoiceTemplateStore } from '@/store/invoiceTemplateStore';
import { useJournalStore } from '@/store/journalStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { useTaxPeriodStore } from '@/store/taxPeriodStore';
import { useAmendmentAuditStore } from '@/store/amendmentAuditStore';
import { useAmendmentPolicyStore } from '@/store/amendmentPolicyStore';
import { useAmendmentDrawerStore } from '@/store/amendmentDrawerStore';
import { useAuthStore } from '@/store/authStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { useViewedOrganizationStore } from '@/store/effectiveOrganization';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { setActiveWorkspace } from '@/lib/workspaceStorage';
import type { OrganizationRole } from '@/types/roles';
import type { RegisteredUser } from '@/types/onboarding';

const ORG = 'org_aug_23_co';
const SUBSCRIBER_ORG = 'org_other_subscriber';

const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const customerId = () =>
  useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;

function signIn(role: OrganizationRole, organizationId: string | undefined, id = 'user_x'): void {
  const user: RegisteredUser = {
    id, fullName: `Test ${role}`, email: `${id}@example.test`, mobile: '', country: 'JO',
    passwordHash: 'x', emailVerified: true, role, status: 'active', organizationId,
    createdAt: new Date().toISOString(),
  };
  useAuthStore.setState({ users: [user], currentUserId: user.id });
}

async function postedInvoice(): Promise<string> {
  const { id } = await useInvoiceStore.getState().createDraft({
    customerId: customerId(), issueDate: '2026-03-05', dueDate: '2026-03-05',
  });
  const draft = useInvoiceStore.getState().getInvoice(id!)!;
  await useInvoiceStore.getState().updateDraft(id!, {
    lines: [{ ...draft.lines[0]!, accountId: acc('4110'), description: 'Goods', quantity: 4, unitPrice: 25, taxRate: 0 }],
  });
  expect((await useInvoiceStore.getState().issueInvoice(id!)).ok).toBe(true);
  return id!;
}

/** The real composition: a row's Actions menu, plus the page-level host. */
function renderRow(documentId: string) {
  return render(
    <ToastProvider>
      <Dropdown label="Actions" trigger={() => <span>Actions</span>}>
        <AmendMenuItem documentType="invoice" documentId={documentId} />
      </Dropdown>
      <AmendmentDrawerHost />
    </ToastProvider>,
  );
}

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
const menu = () => screen.getByTestId('dropdown-menu');

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useJournalStore.setState({ entries: [] });
  useEntitlementStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useInvoiceStore.setState({ backend: 'browser' });
  useInventoryStore.getState().resetToDefault();
  useTaxPeriodStore.getState().resetToDefault();
  useAmendmentAuditStore.getState().resetToDefault();
  useAmendmentPolicyStore.getState().resetToDefault();
  useAmendmentDrawerStore.getState().close();
  useStore.getState().updateSettings({ logoUrl: '' });
  useAuthStore.setState({ users: [], currentUserId: undefined });
  useBackendSessionStore.setState({ platformRoles: [] });
  useOperatorViewStore.getState().exit();
  useViewedOrganizationStore.setState({ status: 'idle', organizationId: null, organizationName: null, error: null });
  setActiveWorkspace({ kind: 'tenant', organizationId: ORG });
});

afterEach(() => {
  cleanup();
  useOperatorViewStore.getState().exit();
  setActiveWorkspace(null);
});

/* ══ The Primary Owner ═════════════════════════════════════════════════════ */

describe('an active Primary Owner using the real Actions menu', () => {
  beforeEach(() => signIn('owner', ORG, 'user_aug_owner'));

  it('sees the action ENABLED, with no refusal text', async () => {
    const id = await postedInvoice();
    renderRow(id);
    openMenu();
    const item = within(menu()).getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement;
    expect(item.disabled).toBe(false);
    expect(within(menu()).queryByTestId('amend-disabled-reason')).toBeNull();
  });

  it('OPENS THE DRAWER when clicked — the menu closing must not destroy it', async () => {
    const id = await postedInvoice();
    renderRow(id);
    openMenu();
    fireEvent.click(within(menu()).getByRole('menuitem', { name: /amend posted document/i }));

    /* The menu closes — that is the dropdown behaving normally… */
    await waitFor(() => expect(screen.queryByTestId('dropdown-menu')).toBeNull());
    /* …and the drawer must still arrive. This is the regression. */
    await waitFor(() =>
      expect(screen.getByText(/The original posting stays in the books/i)).toBeTruthy());
  });

  it('never shows a disabled action with an empty explanation', async () => {
    const id = await postedInvoice();
    renderRow(id);
    openMenu();
    const item = within(menu()).getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement;
    if (item.disabled) {
      const reason = within(menu()).getByTestId('amend-disabled-reason');
      expect(reason.textContent?.trim().length).toBeGreaterThan(0);
    }
  });
});

/* ══ Disabled actions must explain themselves, in the item ═════════════════ */

describe('a disabled action', () => {
  it('carries its reason INSIDE the menu item and in its tooltip', async () => {
    const id = await postedInvoice();
    signIn('accountant', ORG, 'user_acc');
    renderRow(id);
    openMenu();

    const item = within(menu()).getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    /* The reason is a descendant of the control, not a detached sibling. */
    const reason = within(item).getByTestId('amend-disabled-reason');
    expect(reason.textContent).toMatch(/does not include permission/i);
    /* And a pointer user gets it as a tooltip. */
    expect(item.getAttribute('title')).toMatch(/does not include permission/i);
  });

  it('states a period refusal inside the item too', async () => {
    const id = await postedInvoice();
    const period = useTaxPeriodStore.getState().createPeriod({
      entityId: 'primary', jurisdictionId: 'jo', periodStart: '2026-03-01', periodEnd: '2026-03-31',
    });
    useTaxPeriodStore.getState().setStatus(period.id!, 'filed');
    signIn('owner', ORG, 'user_aug_owner');
    renderRow(id);
    openMenu();

    const item = within(menu()).getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(within(item).getByTestId('amend-disabled-reason').textContent).toMatch(/has been filed/i);
  });

  it('does nothing when clicked, and opens no drawer', async () => {
    const id = await postedInvoice();
    signIn('viewer', ORG, 'user_viewer');
    renderRow(id);
    openMenu();
    fireEvent.click(within(menu()).getByRole('menuitem', { name: /amend posted document/i }));
    expect(useAmendmentDrawerStore.getState().target).toBeNull();
    expect(screen.queryByText(/The original posting stays in the books/i)).toBeNull();
  });
});

/* ══ The Super Admin refusal must keep working ═════════════════════════════ */

describe('a platform operator in a subscriber workspace', () => {
  it('still sees the platform-operator refusal, inside the item', async () => {
    /* The operator's own organization is elsewhere; these books are not theirs. */
    signIn('owner', 'org_ledgora_dev', 'user_super_admin');
    useBackendSessionStore.setState({ platformRoles: ['super_admin'] });
    useOperatorViewStore.setState({
      active: true, viewAsSubscriber: false, organizationId: SUBSCRIBER_ORG,
      ownerUserId: null, ownerName: null, orgName: null,
    });
    useViewedOrganizationStore.setState({
      status: 'ready', organizationId: SUBSCRIBER_ORG, organizationName: 'Other', error: null,
    });
    setActiveWorkspace({ kind: 'tenant', organizationId: SUBSCRIBER_ORG });

    const id = await postedInvoice();
    renderRow(id);
    openMenu();

    const item = within(menu()).getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(within(item).getByTestId('amend-disabled-reason').textContent).toMatch(/platform operator/i);
    expect(item.getAttribute('title')).toMatch(/platform operator/i);
  });
});

/* ══ Recomputation as dependencies hydrate ═════════════════════════════════ */

describe('partially hydrated state', () => {
  it('recomputes when the journal arrives after the invoices', async () => {
    signIn('owner', ORG, 'user_aug_owner');
    const id = await postedInvoice();

    /* Simulate the journal store not yet hydrated: its entries are missing, so
       the posting behind the invoice cannot be found and the action refuses. */
    const entries = useJournalStore.getState().entries;
    useJournalStore.setState({ entries: [] });

    renderRow(id);
    openMenu();
    const before = within(menu()).getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement;
    expect(before.disabled).toBe(true);
    expect(within(before).getByTestId('amend-disabled-reason').textContent).toMatch(/could not be found/i);

    /* The journal hydrates. The menu must notice. */
    useJournalStore.setState({ entries });
    await waitFor(() => {
      const after = within(menu()).getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement;
      expect(after.disabled).toBe(false);
    });
    expect(within(menu()).queryByTestId('amend-disabled-reason')).toBeNull();
  });

  it('recomputes when the subscription becomes active', async () => {
    signIn('owner', ORG, 'user_aug_owner');
    const id = await postedInvoice();
    useEntitlementStore.setState((s) => ({ subscription: { ...s.subscription, status: 'suspended' } }));

    renderRow(id);
    openMenu();
    const before = within(menu()).getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement;
    expect(before.disabled).toBe(true);

    useEntitlementStore.setState((s) => ({ subscription: { ...s.subscription, status: 'active' } }));
    await waitFor(() => {
      const after = within(menu()).getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement;
      expect(after.disabled).toBe(false);
    });
  });

  it('recomputes when the subscriber grants the permission', async () => {
    signIn('accountant', ORG, 'user_acc');
    const id = await postedInvoice();
    renderRow(id);
    openMenu();
    expect((within(menu()).getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement).disabled).toBe(true);

    useAmendmentPolicyStore.setState({ roleGrants: [{ role: 'accountant', key: 'invoices:amend' }], userOverrides: [] });
    await waitFor(() => {
      const after = within(menu()).getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement;
      expect(after.disabled).toBe(false);
    });
  });
});
