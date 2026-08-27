// @vitest-environment happy-dom
/**
 * Regression: an active Primary Owner must never meet a blank refusal.
 *
 * Reported from production as "visible but disabled, with no reason". The
 * assessment was never the cause — it is ELIGIBLE here, and these tests hold
 * that. The action only LOOKED disabled: clicking it closed the Actions menu,
 * which unmounted the drawer along with it (see `amendmentMenuInteraction.test`).
 *
 * Modelled as production actually is, which is what the earlier tests did not
 * do:
 *
 *   · the organization and its posted invoice PRE-DATE this feature, so the
 *     invoice carries no amendment metadata and the amendment policy store has
 *     never been written — it starts empty;
 *   · the workspace is a real backend organization id, not the test default;
 *   · the owner is a real signed-in member of that organization.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useInvoiceStore } from './invoiceStore';
import { useInvoiceTemplateStore } from './invoiceTemplateStore';
import { useJournalStore } from './journalStore';
import { useEntitlementStore } from './entitlementStore';
import { useInventoryStore } from './inventoryStore';
import { useTaxPeriodStore } from './taxPeriodStore';
import { useAmendmentAuditStore } from './amendmentAuditStore';
import { useAmendmentPolicyStore } from './amendmentPolicyStore';
import { useAuthStore } from './authStore';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { assessAmendment } from '@/services/documentAmendmentService';
import { readAmendmentContext } from '@/lib/amendmentContext';
import { setActiveWorkspace } from '@/lib/workspaceStorage';
import type { RegisteredUser } from '@/types/onboarding';

/** A real backend organization id, as production has. */
const ORG = '0f3b7c1e-9a42-4d18-8b6e-2c5f7a91d004';

const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const customerId = () =>
  useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;

/** AUG@AUG.COM — the active Primary Owner of AUG 23 CO. */
function signInPrimaryOwner(): RegisteredUser {
  const user: RegisteredUser = {
    id: 'user_aug_owner',
    fullName: 'AUG Owner',
    email: 'aug@aug.com',
    mobile: '',
    country: 'JO',
    passwordHash: 'x',
    emailVerified: true,
    role: 'owner',
    status: 'active',
    organizationId: ORG,
    createdAt: '2026-01-05T09:00:00.000Z',
  };
  useAuthStore.setState({ users: [user], currentUserId: user.id });
  return user;
}

/**
 * An invoice issued BEFORE this feature shipped: posted, with a journal entry,
 * and carrying none of the amendment metadata the feature adds.
 */
async function preExistingPostedInvoice(): Promise<string> {
  const { id } = await useInvoiceStore.getState().createDraft({
    customerId: customerId(), issueDate: '2026-02-10', dueDate: '2026-03-10',
  });
  const draft = useInvoiceStore.getState().getInvoice(id!)!;
  await useInvoiceStore.getState().updateDraft(id!, {
    lines: [{ ...draft.lines[0]!, accountId: acc('4110'), description: 'Consulting', quantity: 2, unitPrice: 500, taxRate: 0 }],
    issueDate: '2026-02-10', dueDate: '2026-03-10',
  });
  const issued = await useInvoiceStore.getState().issueInvoice(id!);
  expect(issued.ok, issued.error).toBe(true);

  /* Strip every field the feature introduced — this record predates it. */
  useInvoiceStore.setState((s) => ({
    invoices: s.invoices.map((i) => {
      if (i.id !== id) return i;
      const {
        amendmentVersion, amendmentChainId, amendsDocumentId, amendsDocumentNumber,
        supersededByDocumentId, supersededByDocumentNumber, supersededAt, amendmentReason,
        amendmentReversalJournalEntryId, amendmentInventoryReversalId, amendmentAuditEventId,
        ...rest
      } = i;
      return rest as typeof i;
    }),
  }));
  return id!;
}

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
  /* The policy store as a pre-existing organization has it: never written. */
  useAmendmentPolicyStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
  useAuthStore.setState({ users: [], currentUserId: undefined });
  setActiveWorkspace({ kind: 'tenant', organizationId: ORG });
});

afterEach(() => setActiveWorkspace(null));

describe('a pre-existing active Primary Owner on a pre-existing posted invoice', () => {
  it('produces an ELIGIBLE assessment — the Owner is not blocked', async () => {
    signInPrimaryOwner();
    const id = await preExistingPostedInvoice();
    const assessment = assessAmendment('invoice', id)!;
    expect(assessment.blockers, `unexpected blockers: ${assessment.reason}`).toEqual([]);
    expect(assessment.eligible).toBe(true);
  });

  it('resolves the Owner role and an active membership from the live context', async () => {
    signInPrimaryOwner();
    await preExistingPostedInvoice();
    const context = readAmendmentContext();
    expect(context.role).toBe('owner');
    expect(context.organizationId).toBe(ORG);
    expect(context.membershipActive).toBe(true);
    expect(context.actingAsPlatformOperator).toBe(false);
    expect(context.subscriptionActive).toBe(true);
  });

  it('applies the Owner amendment default even though the policy store is empty', async () => {
    signInPrimaryOwner();
    await preExistingPostedInvoice();
    expect(useAmendmentPolicyStore.getState().roleGrants).toEqual([]);
    expect(useAmendmentPolicyStore.getState().userOverrides).toEqual([]);
    /* An empty policy must fall through to the role template, not deny. */
    const { resolveDocumentAmendmentPermission } = await import('@/lib/amendmentPermissions');
    const { permissionInput } = await import('@/lib/amendmentContext');
    const { currentAmendmentPolicy } = await import('./amendmentPolicyStore');
    const verdict = resolveDocumentAmendmentPermission(
      permissionInput(readAmendmentContext(), currentAmendmentPolicy()),
      'invoice',
    );
    expect(verdict.allowed, verdict.error).toBe(true);
    expect(verdict.source).toBe('role_template');
  });

  it('is not influenced by email verification', async () => {
    const user = signInPrimaryOwner();
    await preExistingPostedInvoice();
    const enabledWhenVerified = assessAmendment('invoice', (await preExistingPostedInvoice()))!.eligible;

    useAuthStore.setState({ users: [{ ...user, emailVerified: false }], currentUserId: user.id });
    const id = await preExistingPostedInvoice();
    const context = readAmendmentContext();
    expect(context.role).toBe('owner');
    expect(assessAmendment('invoice', id)!.eligible).toBe(enabledWhenVerified);
  });

  it('has no legitimate accounting blocker on the invoice itself', async () => {
    signInPrimaryOwner();
    const id = await preExistingPostedInvoice();
    const invoice = useInvoiceStore.getState().getInvoice(id)!;
    expect(invoice.status).toBe('issued');
    expect(invoice.journalEntryId).toBeTruthy();
    expect(useJournalStore.getState().entries.find((e) => e.id === invoice.journalEntryId)!.status).toBe('posted');
    expect(invoice.amountPaid).toBe(0);
    expect(useTaxPeriodStore.getState().periods).toEqual([]);
    expect(invoice.supersededByDocumentId).toBeUndefined();
  });

  it('THE DEFECT: the Owner must be able to amend it', async () => {
    signInPrimaryOwner();
    const id = await preExistingPostedInvoice();
    const assessment = assessAmendment('invoice', id)!;
    expect(assessment.eligible, `disabled because: ${assessment.reason}`).toBe(true);
  });

  it('THE DEFECT: any disabled action must state a non-empty reason', async () => {
    signInPrimaryOwner();
    const id = await preExistingPostedInvoice();
    const assessment = assessAmendment('invoice', id)!;
    if (!assessment.eligible) {
      expect(assessment.reason.trim().length, 'a disabled action must explain itself').toBeGreaterThan(0);
      expect(assessment.blockers.every((b) => b.message.trim().length > 0)).toBe(true);
    }
  });
});
