// @vitest-environment happy-dom
/**
 * Platform authority versus organization membership, for posted-document
 * amendments.
 *
 * ══ The rule these tests hold ════════════════════════════════════════════════
 *
 * Holding a LEDGORA platform role is neither a grant nor a denial. What decides
 * whether someone may amend a posted document is whether they are a legitimate
 * member of the organization whose books are open:
 *
 *   · a Super Admin who reached a SUBSCRIBER's workspace through operator
 *     viewing mode is refused — platform status is not subscriber authorization,
 *     and this branch deliberately implements no support-access mechanism that
 *     could supply it;
 *   · a Super Admin working inside an organization they legitimately OWN acts
 *     by their organization role like anybody else. Denying them because of a
 *     platform role they happen to hold elsewhere would make their own
 *     development and test organizations unusable.
 *
 * ══ Why the decision keys off MEMBERSHIP and not classification ══════════════
 *
 * It would be tempting to phrase this as "development organizations are open,
 * production ones are not". That rule is bypassable: reclassify a production
 * subscriber as development and the gate opens. Membership cannot be bypassed
 * that way — reclassifying an organization does not make anyone a member of it
 * — so classification is never consulted, and the test below proves the refusal
 * survives regardless of how the workspace is labelled.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useInvoiceStore } from './invoiceStore';
import { useInvoiceTemplateStore } from './invoiceTemplateStore';
import { useJournalStore } from './journalStore';
import { useEntitlementStore } from './entitlementStore';
import { useInventoryStore } from './inventoryStore';
import { useAmendmentAuditStore } from './amendmentAuditStore';
import { useAmendmentPolicyStore } from './amendmentPolicyStore';
import { useAuthStore } from './authStore';
import { useOperatorViewStore } from './operatorViewStore';
import { useViewedOrganizationStore } from './effectiveOrganization';
import { useBackendSessionStore } from './backendSessionStore';
import { useOrganizationStore } from './organizationStore';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { amendPostedDocument, assessAmendment } from '@/services/documentAmendmentService';
import { readAmendmentContext } from '@/lib/amendmentContext';
import { isPlatformAdminFullAccess } from './platformFullAccess';
import { setActiveWorkspace } from '@/lib/workspaceStorage';
import type { AmendmentRequest } from '@/types/documentAmendment';
import type { RegisteredUser } from '@/types/onboarding';

const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const customerId = () =>
  useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;

const SUBSCRIBER_ORG = 'org_acme_subscriber';
const OPERATOR_DEV_ORG = 'org_ledgora_dev';

/** The Super Admin, who owns a development organization of their own. */
function superAdmin(organizationId: string | undefined): RegisteredUser {
  return {
    id: 'user_super_admin',
    fullName: 'Platform Operator',
    email: 'ops@ledgora.test',
    mobile: '',
    country: 'JO',
    passwordHash: 'x',
    emailVerified: true,
    role: 'owner',
    status: 'active',
    organizationId,
    createdAt: new Date().toISOString(),
  };
}

/** Give the session a backend-VERIFIED super-admin platform role. */
function holdPlatformRole(): void {
  useBackendSessionStore.setState({ platformRoles: ['super_admin'] });
}

/** Enter operator subscriber-view mode for `organizationId`, confirmed. */
function enterOperatorView(organizationId: string): void {
  useOperatorViewStore.setState({
    active: true,
    viewAsSubscriber: false,
    organizationId,
    ownerUserId: null,
    ownerName: null,
    orgName: null,
  });
  /* The backend confirming the viewed tenant — the stronger coherence path. */
  useViewedOrganizationStore.setState({
    status: 'ready',
    organizationId,
    organizationName: 'Confirmed',
    error: null,
  });
  /* Operator viewing points the books at the VIEWED tenant's namespace. */
  setActiveWorkspace({ kind: 'tenant', organizationId });
}

let correlation = 0;
function request(documentId: string, patch: Record<string, unknown> = { notes: 'corrected' }): AmendmentRequest {
  correlation += 1;
  return {
    documentType: 'invoice',
    documentId,
    reason: 'Correcting the quantity delivered',
    expectedVersion: 1,
    correlationId: `op-corr-${correlation}`,
    patch,
    confirmed: true,
  };
}

async function postedInvoice(): Promise<string> {
  const { id } = await useInvoiceStore.getState().createDraft({
    customerId: customerId(), issueDate: '2026-03-05', dueDate: '2026-03-05',
  });
  const draft = useInvoiceStore.getState().getInvoice(id!)!;
  await useInvoiceStore.getState().updateDraft(id!, {
    lines: [{ ...draft.lines[0]!, accountId: acc('4110'), description: 'Goods', quantity: 4, unitPrice: 25, taxRate: 0 }],
  });
  const issued = await useInvoiceStore.getState().issueInvoice(id!);
  expect(issued.ok, issued.error).toBe(true);
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
  useAmendmentAuditStore.getState().resetToDefault();
  useAmendmentPolicyStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
  useAuthStore.setState({ users: [], currentUserId: undefined });
  useBackendSessionStore.setState({ platformRoles: [] });
  useOperatorViewStore.getState().exit();
  useViewedOrganizationStore.setState({ status: 'idle', organizationId: null, organizationName: null, error: null });
  useOrganizationStore.setState({ organization: null });
  setActiveWorkspace(null);
});

afterEach(() => {
  useOperatorViewStore.getState().exit();
  setActiveWorkspace(null);
});

/* ══ A Super Admin reaching a SUBSCRIBER's books ═══════════════════════════ */

describe('a platform operator inside a subscriber organization', () => {
  beforeEach(() => {
    /* The operator owns a dev organization of their own — a different tenant. */
    const user = superAdmin(OPERATOR_DEV_ORG);
    useAuthStore.setState({ users: [user], currentUserId: user.id });
    holdPlatformRole();
    enterOperatorView(SUBSCRIBER_ORG);
  });

  it('is genuinely in operator mode — the fixture proves the override is live', () => {
    expect(isPlatformAdminFullAccess()).toBe(true);
    const context = readAmendmentContext();
    expect(context.organizationId).toBe(SUBSCRIBER_ORG);
    expect(context.actingAsPlatformOperator).toBe(true);
  });

  it('cannot amend a posted document in the subscriber’s books', async () => {
    const id = await postedInvoice();
    const before = JSON.parse(JSON.stringify({
      invoices: useInvoiceStore.getState().invoices,
      entries: useJournalStore.getState().entries,
    }));

    const result = await amendPostedDocument(request(id));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/platform operator/i);

    /* Nothing whatsoever changed in the subscriber's books. */
    expect(useInvoiceStore.getState().invoices).toEqual(before.invoices);
    expect(useJournalStore.getState().entries).toEqual(before.entries);
    expect(useInvoiceStore.getState().getInvoice(id)!.status).toBe('issued');
  });

  it('is told so by the assessment, so no screen offers the action', async () => {
    const id = await postedInvoice();
    const assessment = assessAmendment('invoice', id)!;
    expect(assessment.eligible).toBe(false);
    expect(assessment.blockers.some((b) => b.kind === 'permission')).toBe(true);
    expect(assessment.reason).toMatch(/platform operator/i);
  });

  it('records the refused attempt against the ADMINISTRATOR, not the subscriber', async () => {
    const id = await postedInvoice();
    await amendPostedDocument(request(id));
    const event = useAmendmentAuditStore.getState().events.at(-1)!;
    expect(event.outcome).toBe('rejected');
    expect(event.actorUserId).toBe('user_super_admin');
    expect(event.actedAsPlatformOperator).toBe(true);
    expect(event.organizationId).toBe(SUBSCRIBER_ORG);
    expect(event.failureReason).toMatch(/platform operator/i);
  });

  it('cannot be unblocked by the subscriber’s own amendment policy', async () => {
    const id = await postedInvoice();
    /*
     * Even a policy that grants the permission to every role and to this very
     * user changes nothing: the operator refusal is resolved BEFORE any grant
     * is read, so a compromised or careless policy cannot open the door.
     */
    useAmendmentPolicyStore.setState({
      roleGrants: [{ role: 'owner', key: 'invoices:amend' }, { role: 'viewer', key: 'invoices:amend' }],
      userOverrides: [{ userId: 'user_super_admin', key: 'invoices:amend', effect: 'grant' }],
    });
    const result = await amendPostedDocument(request(id));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/platform operator/i);
  });

  it('stays refused however the workspace is classified', async () => {
    const id = await postedInvoice();
    /*
     * The reclassification bypass, attempted. Access is decided by MEMBERSHIP,
     * so relabelling the workspace — the nearest thing this layer has to a
     * classification — grants nothing.
     */
    for (const kind of ['tenant', 'demo'] as const) {
      setActiveWorkspace({ kind, organizationId: SUBSCRIBER_ORG });
      const result = await amendPostedDocument(request(id));
      expect(result.ok, `must stay refused for a ${kind} workspace`).toBe(false);
      expect(result.error).toMatch(/platform operator/i);
    }
  });
});

/* ══ A Super Admin inside an organization they legitimately own ════════════ */

describe('a platform operator inside their OWN development organization', () => {
  beforeEach(() => {
    const user = superAdmin(OPERATOR_DEV_ORG);
    useAuthStore.setState({ users: [user], currentUserId: user.id });
    holdPlatformRole();
    useOrganizationStore.setState({ organization: { id: OPERATOR_DEV_ORG, legalName: 'Ledgora Dev' } as never });
  });

  it('acts by their organization role when working normally, not by platform status', async () => {
    setActiveWorkspace({ kind: 'tenant', organizationId: OPERATOR_DEV_ORG });
    const context = readAmendmentContext();
    expect(context.actingAsPlatformOperator).toBe(false);
    expect(context.role).toBe('owner');

    const id = await postedInvoice();
    const result = await amendPostedDocument(request(id, { notes: 'corrected in dev' }));
    expect(result.ok, result.error).toBe(true);
    expect(useInvoiceStore.getState().getInvoice(id)!.status).toBe('superseded');
  });

  it('is NOT locked out of its own books by entering operator viewing mode on it', async () => {
    /*
     * The denial this test exists to prevent. A Super Admin who opens their own
     * development organization through operator mode still owns it, and a
     * platform role held elsewhere must not take their own books away from them.
     */
    enterOperatorView(OPERATOR_DEV_ORG);
    expect(isPlatformAdminFullAccess()).toBe(true);

    const context = readAmendmentContext();
    expect(context.organizationId).toBe(OPERATOR_DEV_ORG);
    expect(context.actingAsPlatformOperator).toBe(false);
    expect(context.role).toBe('owner');

    const id = await postedInvoice();
    const assessment = assessAmendment('invoice', id)!;
    expect(assessment.eligible, assessment.reason).toBe(true);

    const result = await amendPostedDocument(request(id));
    expect(result.ok, result.error).toBe(true);
    const replacement = useInvoiceStore.getState().getInvoice(result.replacementId!)!;
    expect(replacement.amendsDocumentId).toBe(id);
    /* Recorded as the organization's owner acting, not as a platform operator. */
    const event = useAmendmentAuditStore.getState().events.at(-1)!;
    expect(event.outcome).toBe('succeeded');
    expect(event.actedAsPlatformOperator).toBe(false);
    expect(event.actorRole).toBe('owner');
  });

  it('is still bound by ordinary organization permissions inside its own books', async () => {
    /*
     * "Normal organization permissions" cuts both ways: owning a development
     * organization does not exempt the operator from the rules, it subjects
     * them to them. A member of their own dev org holds no amendment right.
     */
    setActiveWorkspace({ kind: 'tenant', organizationId: OPERATOR_DEV_ORG });
    /* Raised by the owner — a member could not have created it either. */
    const id = await postedInvoice();

    const member = { ...superAdmin(OPERATOR_DEV_ORG), id: 'user_dev_member', role: 'member' as const };
    useAuthStore.setState({ users: [member], currentUserId: member.id });

    const result = await amendPostedDocument(request(id));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not include permission/i);
    expect(result.error).not.toMatch(/platform operator/i);
  });

  it('is refused the moment viewing mode moves to somebody else’s organization', async () => {
    setActiveWorkspace({ kind: 'tenant', organizationId: OPERATOR_DEV_ORG });
    const id = await postedInvoice();
    expect((await amendPostedDocument(request(id))).ok).toBe(true);

    /* Same person, same platform role — a different tenant's books. */
    enterOperatorView(SUBSCRIBER_ORG);
    const second = await postedInvoice();
    const result = await amendPostedDocument(request(second));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/platform operator/i);
  });
});
