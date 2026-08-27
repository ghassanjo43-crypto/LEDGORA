// @vitest-environment happy-dom
/**
 * The menu, the drawer and the policy panel — and, above all, that what they
 * OFFER agrees with what the service would actually allow.
 *
 * A menu is an affordance, never a gate. These tests assert the two agree, and
 * `store/documentAmendment.test` separately proves the service refuses a caller
 * who ignores the menu entirely.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AmendMenuItem } from './AmendMenuItem';
import { AmendmentPolicyPanel } from './AmendmentPolicyPanel';
import { AmendmentHistoryPanel } from './AmendmentHistoryPanel';
import { ToastProvider } from '@/components/ui/Toast';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useInvoiceTemplateStore } from '@/store/invoiceTemplateStore';
import { useJournalStore } from '@/store/journalStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useTaxPeriodStore } from '@/store/taxPeriodStore';
import { useAmendmentAuditStore } from '@/store/amendmentAuditStore';
import { useAmendmentPolicyStore } from '@/store/amendmentPolicyStore';
import { useAuthStore } from '@/store/authStore';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { assessAmendment } from '@/services/documentAmendmentService';
import type { OrganizationRole } from '@/types/roles';
import type { RegisteredUser } from '@/types/onboarding';

const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const customerId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;

function signInAs(role: OrganizationRole, id = 'user_test'): void {
  const user: RegisteredUser = {
    id, fullName: `Test ${role}`, email: `${id}@example.test`, mobile: '', country: 'JO',
    passwordHash: 'x', emailVerified: true, role, status: 'active', organizationId: 'org_test',
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
  const res = await useInvoiceStore.getState().issueInvoice(id!);
  expect(res.ok, res.error).toBe(true);
  return id!;
}

const wrap = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useJournalStore.setState({ entries: [] });
  useEntitlementStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useInvoiceStore.setState({ backend: 'browser' });
  useTaxPeriodStore.getState().resetToDefault();
  useAmendmentAuditStore.getState().resetToDefault();
  useAmendmentPolicyStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
  useAuthStore.setState({ users: [], currentUserId: undefined });
});

/* Vitest is not running with globals here, so cleanup is explicit. */
afterEach(cleanup);

/* ── The menu entry ───────────────────────────────────────────────────────── */

describe('the Amend posted document action', () => {
  it('is offered on a posted document and is not labelled Edit', async () => {
    const id = await postedInvoice();
    wrap(<AmendMenuItem documentType="invoice" documentId={id} />);
    const item = screen.getByRole('menuitem', { name: /amend posted document/i });
    expect(item).toBeTruthy();
    expect((item as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('menuitem', { name: /^edit$/i })).toBeNull();
  });

  it('is not offered at all on a draft, where ordinary editing applies', async () => {
    const { id } = await useInvoiceStore.getState().createDraft({ customerId: customerId() });
    wrap(<AmendMenuItem documentType="invoice" documentId={id!} />);
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('is drawn but disabled, with the reason, when the user lacks permission', async () => {
    const id = await postedInvoice();
    signInAs('accountant');
    wrap(<AmendMenuItem documentType="invoice" documentId={id} />);
    const item = screen.getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(screen.getByText(/does not include permission/i)).toBeTruthy();
  });

  it('is disabled with a period reason when the tax return is filed', async () => {
    const id = await postedInvoice();
    const period = useTaxPeriodStore.getState().createPeriod({
      entityId: 'primary', jurisdictionId: 'jo', periodStart: '2026-03-01', periodEnd: '2026-03-31',
    });
    useTaxPeriodStore.getState().setStatus(period.id!, 'filed');
    wrap(<AmendMenuItem documentType="invoice" documentId={id} />);
    expect((screen.getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/has been filed/i)).toBeTruthy();
  });

  it('agrees with the authoritative assessment for every role', async () => {
    const id = await postedInvoice();
    for (const role of ['owner', 'admin', 'manager', 'accountant', 'member', 'viewer'] as const) {
      signInAs(role, `user_${role}`);
      const { unmount } = wrap(<AmendMenuItem documentType="invoice" documentId={id} />);
      const item = screen.getByRole('menuitem', { name: /amend posted document/i }) as HTMLButtonElement;
      const authoritative = assessAmendment('invoice', id)!;
      expect(item.disabled, `${role}: menu and service must agree`).toBe(!authoritative.eligible);
      unmount();
    }
  });
});

/* ── The drawer ───────────────────────────────────────────────────────────── */

describe('the amendment drawer', () => {
  async function open(id: string): Promise<void> {
    wrap(<AmendMenuItem documentType="invoice" documentId={id} />);
    fireEvent.click(screen.getByRole('menuitem', { name: /amend posted document/i }));
    await waitFor(() => expect(screen.getByText(/The original posting stays in the books/i)).toBeTruthy());
  }

  it('warns that the original is kept, and will not continue without a reason', async () => {
    const id = await postedInvoice();
    await open(id);
    expect(screen.getByText(/keeps its number, its lines, its taxes and its journal entry/i)).toBeTruthy();

    const cont = screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/why is this document being amended/i), {
      target: { value: 'Quantity delivered was six, not four' },
    });
    expect((screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement).disabled).toBe(true);

    /* The acknowledgement is a second, separate act. */
    fireEvent.click(screen.getByRole('checkbox'));
    expect((screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the document facts an operator needs before deciding', async () => {
    const id = await postedInvoice();
    await open(id);
    expect(screen.getByText('Posting date')).toBeTruthy();
    expect(screen.getByText('Journal entry')).toBeTruthy();
    expect(screen.getByText('Tax period')).toBeTruthy();
    expect(screen.getByText('Settled')).toBeTruthy();
    expect(screen.getByText('e-invoice')).toBeTruthy();
  });

  it('shows the original beside the revision, and requires a final confirmation', async () => {
    const id = await postedInvoice();
    await open(id);
    fireEvent.change(screen.getByLabelText(/why is this document being amended/i), {
      target: { value: 'Quantity delivered was six, not four' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    /* Revise. */
    const quantity = screen.getAllByRole('spinbutton')[0]!;
    fireEvent.change(quantity, { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    /* Compare. */
    await waitFor(() => expect(screen.getByText('Revised')).toBeTruthy());
    expect(screen.getByText(/line 1 · quantity/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('button', { name: /reverse and repost/i })).toBeTruthy();
    expect(screen.getByText(/This posts to the ledger/i)).toBeTruthy();
  });

  it('changes nothing when it is closed without confirming', async () => {
    const id = await postedInvoice();
    const before = JSON.parse(JSON.stringify({
      invoices: useInvoiceStore.getState().invoices,
      entries: useJournalStore.getState().entries,
    }));
    await open(id);
    fireEvent.change(screen.getByLabelText(/why is this document being amended/i), {
      target: { value: 'A reason that will never be used' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByText(/The original posting stays in the books/i)).toBeNull());
    expect(useInvoiceStore.getState().invoices).toEqual(before.invoices);
    expect(useJournalStore.getState().entries).toEqual(before.entries);
    expect(useAmendmentAuditStore.getState().events).toHaveLength(0);
  });

  it('carries the whole workflow through to a posted amendment', async () => {
    const id = await postedInvoice();
    await open(id);
    fireEvent.change(screen.getByLabelText(/why is this document being amended/i), {
      target: { value: 'Quantity delivered was six, not four' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.change(screen.getAllByRole('spinbutton')[0]!, { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /reverse and repost/i }));

    await waitFor(() => {
      expect(useInvoiceStore.getState().getInvoice(id)!.status).toBe('superseded');
    });
    const replacement = useInvoiceStore.getState().invoices.find((i) => i.amendsDocumentId === id)!;
    expect(replacement.grandTotal).toBe(150);
    expect(useAmendmentAuditStore.getState().events[0]!.outcome).toBe('succeeded');
  });
});

/* ── The history panel ────────────────────────────────────────────────────── */

describe('the version history panel', () => {
  it('says plainly that an unamended document has never been amended', async () => {
    const id = await postedInvoice();
    wrap(<AmendmentHistoryPanel documentType="invoice" documentId={id} currency="JOD" />);
    expect(screen.getByText(/has never been amended/i)).toBeTruthy();
  });

  it('states the trail’s limitation rather than leaving it to be assumed', async () => {
    const id = await postedInvoice();
    const { amendPostedDocument } = await import('@/services/documentAmendmentService');
    await amendPostedDocument({
      documentType: 'invoice', documentId: id, reason: 'Corrected the quantity',
      expectedVersion: 1, correlationId: 'ui-1', patch: { notes: 'Corrected note text' }, confirmed: true,
    });
    wrap(<AmendmentHistoryPanel documentType="invoice" documentId={id} currency="JOD" />);
    expect(screen.getByText(/not a server-side audit log/i)).toBeTruthy();
    expect(screen.getByText('Version history')).toBeTruthy();
    /* Two versions, each named once in the history table's Version column. */
    const versionCells = screen.getAllByText(/^v[0-9]+$/).map((el) => el.textContent);
    expect(versionCells).toEqual(['v1', 'v2']);
  });
});

/* ── The policy panel ─────────────────────────────────────────────────────── */

describe('the amendment policy panel', () => {
  it('lets the owner grant a role, and the grant reaches the resolver', async () => {
    signInAs('owner', 'user_owner');
    const id = await postedInvoice();
    wrap(<AmendmentPolicyPanel />);

    const toggle = screen.getByRole('switch', { name: /accountant may amend posted sales invoices/i });
    fireEvent.click(toggle);
    expect(useAmendmentPolicyStore.getState().roleGrants).toContainEqual({ role: 'accountant', key: 'invoices:amend' });

    signInAs('accountant', 'user_acc');
    expect(assessAmendment('invoice', id)!.eligible).toBe(true);
  });

  it('shows a manager a read-only panel and refuses their writes', () => {
    signInAs('manager', 'user_mgr');
    wrap(<AmendmentPolicyPanel />);
    expect(screen.getByText(/Only the organization owner or an Organization Admin/i)).toBeTruthy();
    const toggle = screen.getByRole('switch', { name: /manager may amend posted sales invoices/i }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(useAmendmentPolicyStore.getState().roleGrants).toHaveLength(0);
  });

  it('states that the rule is enforced in the services, not only in the menus', () => {
    signInAs('owner', 'user_owner');
    wrap(<AmendmentPolicyPanel />);
    expect(screen.getByText(/enforced in the document services, not only in the menus/i)).toBeTruthy();
  });
});
