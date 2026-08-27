// @vitest-environment happy-dom
/**
 * Tenant isolation of the posted-document amendment stores.
 *
 * ── The defect these tests exist to prevent recurring ────────────────────────
 * `amendmentPolicyStore` and `amendmentAuditStore` persisted through the
 * workspace-namespaced adapter — so their KEYS were correctly scoped — but they
 * were not registered in `BUSINESS_WORKSPACE_STORES`. Registration is what makes
 * `openBusinessWorkspace` rehydrate a store when a workspace is opened and blank
 * it for a new tenant. Without it the two stores kept whatever was in memory
 * across an organization switch: one subscriber's amendment policy, and one
 * subscriber's amendment audit trail, sitting in memory under the next
 * subscriber's name.
 *
 * The policy decides who may restate a posted document, and the trail is the
 * record of who did. Neither may cross a tenant boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BUSINESS_WORKSPACE_STORES,
  closeBusinessWorkspace,
  openBusinessWorkspace,
} from '@/store/businessWorkspace';
import { clearWorkspaceData, setActiveWorkspace, setWorkspaceStorageMode, workspaceScope } from '@/lib/workspaceStorage';
import { useAmendmentPolicyStore } from '@/store/amendmentPolicyStore';
import { useAmendmentAuditStore } from '@/store/amendmentAuditStore';
import { useAuthStore } from '@/store/authStore';
import type { AmendmentAuditEvent } from '@/types/documentAmendment';
import type { RegisteredUser } from '@/types/onboarding';

const ACME = { kind: 'tenant', organizationId: 'org_acme' } as const;
const BETA = { kind: 'tenant', organizationId: 'org_beta' } as const;

/** An owner of `organizationId`, so policy writes are permitted. */
function signInOwner(organizationId: string): void {
  const user: RegisteredUser = {
    id: `owner_${organizationId}`, fullName: 'Owner', email: `${organizationId}@example.test`,
    mobile: '', country: 'JO', passwordHash: 'x', emailVerified: true,
    role: 'owner', status: 'active', organizationId, createdAt: new Date().toISOString(),
  };
  useAuthStore.setState({ users: [user], currentUserId: user.id });
}

function auditEvent(documentNumber: string): Parameters<ReturnType<typeof useAmendmentAuditStore.getState>['append']>[0] {
  return {
    id: `amd_${documentNumber}`,
    at: '2026-03-10T10:00:00.000Z',
    organizationId: 'recorded-at-write-time',
    companyId: 'primary',
    documentType: 'invoice',
    documentId: `inv_${documentNumber}`,
    documentNumber,
    originalVersion: 1,
    documentDate: '2026-03-05',
    actorName: 'Owner',
    actorRole: 'owner',
    actedAsPlatformOperator: false,
    reason: 'Corrected the quantity',
    changes: [],
    settlementEffect: [],
    inventoryEffect: { reversedDocumentIds: [], replacementDocumentIds: [], movementCount: 0 },
    taxStatus: {},
    outcome: 'succeeded',
    correlationId: `corr_${documentNumber}`,
  } as Omit<AmendmentAuditEvent, 'id' | 'sequence' | 'previousChecksum' | 'checksum'> & { id: string };
}

beforeEach(() => {
  setWorkspaceStorageMode('backend');
  closeBusinessWorkspace();
  /*
   * Purge the DURABLE records of every tenant these tests touch. Closing the
   * workspace only blanks memory; the persisted namespaces survive, and a grant
   * written by one case would rehydrate into the next — which is the mechanism
   * under test, so leaving it in place would make a passing assertion say
   * nothing about the code.
   */
  for (const org of ['org_acme', 'org_beta', 'org_brand_new']) {
    clearWorkspaceData({ kind: 'tenant', organizationId: org });
  }
  useAuthStore.setState({ users: [], currentUserId: undefined });
});

afterEach(() => {
  closeBusinessWorkspace();
  setActiveWorkspace(null);
});

describe('the amendment stores are part of the business workspace', () => {
  it('are registered, so the lifecycle reaches them at all', () => {
    const keys = BUSINESS_WORKSPACE_STORES.map((entry) => entry.key);
    expect(keys).toContain('amendment-policy');
    expect(keys).toContain('amendment-audit');
  });

  it('persist under the ACTIVE tenant’s namespace, not a shared key', () => {
    setActiveWorkspace(ACME);
    const acme = workspaceScope(ACME);
    setActiveWorkspace(BETA);
    const beta = workspaceScope(BETA);
    expect(acme).not.toBe(beta);
    expect(acme).toContain('org_acme');
    expect(beta).toContain('org_beta');
  });
});

describe('amendment policy and audit data across a tenant switch', () => {
  it('does not carry one tenant’s policy into another', () => {
    openBusinessWorkspace(ACME);
    signInOwner('org_acme');
    expect(useAmendmentPolicyStore.getState().setRoleGrant('accountant', 'invoices:amend', true).ok).toBe(true);
    expect(useAmendmentPolicyStore.getState().roleGrants).toHaveLength(1);

    /* Beta opens. Acme's grant must not be in force here. */
    openBusinessWorkspace(BETA);
    signInOwner('org_beta');
    expect(useAmendmentPolicyStore.getState().roleGrants).toEqual([]);
    expect(useAmendmentPolicyStore.getState().userOverrides).toEqual([]);
  });

  it('does not carry one tenant’s amendment trail into another', () => {
    openBusinessWorkspace(ACME);
    useAmendmentAuditStore.getState().append(auditEvent('INV-ACME-1'));
    expect(useAmendmentAuditStore.getState().events).toHaveLength(1);

    openBusinessWorkspace(BETA);
    expect(useAmendmentAuditStore.getState().events).toEqual([]);
  });

  it('rehydrates the correct tenant’s policy and trail on switching back', () => {
    openBusinessWorkspace(ACME);
    signInOwner('org_acme');
    useAmendmentPolicyStore.getState().setRoleGrant('manager', 'bills:amend', true);
    useAmendmentAuditStore.getState().append(auditEvent('INV-ACME-1'));

    openBusinessWorkspace(BETA);
    signInOwner('org_beta');
    useAmendmentPolicyStore.getState().setRoleGrant('viewer', 'credit_notes:amend', true);
    useAmendmentAuditStore.getState().append(auditEvent('INV-BETA-1'));

    /* Back to Acme: its own records, and only its own. */
    openBusinessWorkspace(ACME);
    expect(useAmendmentPolicyStore.getState().roleGrants).toEqual([{ role: 'manager', key: 'bills:amend' }]);
    expect(useAmendmentAuditStore.getState().events.map((e) => e.documentNumber)).toEqual(['INV-ACME-1']);

    /* And Beta still has its own. */
    openBusinessWorkspace(BETA);
    expect(useAmendmentPolicyStore.getState().roleGrants).toEqual([{ role: 'viewer', key: 'credit_notes:amend' }]);
    expect(useAmendmentAuditStore.getState().events.map((e) => e.documentNumber)).toEqual(['INV-BETA-1']);
  });

  it('leaves nothing in memory when the workspace closes', () => {
    openBusinessWorkspace(ACME);
    signInOwner('org_acme');
    useAmendmentPolicyStore.getState().setRoleGrant('accountant', 'invoices:amend', true);
    useAmendmentAuditStore.getState().append(auditEvent('INV-ACME-1'));

    closeBusinessWorkspace();
    expect(useAmendmentPolicyStore.getState().roleGrants).toEqual([]);
    expect(useAmendmentAuditStore.getState().events).toEqual([]);
  });

  it('opens a brand-new tenant with no grants and no history', () => {
    openBusinessWorkspace(ACME);
    signInOwner('org_acme');
    useAmendmentPolicyStore.getState().setRoleGrant('accountant', 'invoices:amend', true);
    useAmendmentAuditStore.getState().append(auditEvent('INV-ACME-1'));

    openBusinessWorkspace({ kind: 'tenant', organizationId: 'org_brand_new' });
    expect(useAmendmentPolicyStore.getState().roleGrants).toEqual([]);
    expect(useAmendmentAuditStore.getState().events).toEqual([]);
  });
});
