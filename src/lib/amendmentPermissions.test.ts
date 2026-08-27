import { describe, it, expect } from 'vitest';
import {
  AMENDMENT_PERMISSION_KEYS,
  DOCUMENT_PERMISSION,
  amendmentRoleTemplate,
  canAdministerAmendmentPolicy,
  resolveAmendmentPermission,
  resolveDocumentAmendmentPermission,
  type AmendmentPolicy,
} from './amendmentPermissions';
import {
  AMENDMENT_AUDIT_LIMITATION,
  canonicalise,
  checksum,
  sealEvent,
  verifyAmendmentChain,
} from './amendmentAudit';
import {
  amendableFields,
  assessDocumentAmendment,
  diffDocuments,
  pickAmendableFields,
  validateAmendmentReason,
  orderChain,
} from './documentAmendment';
import { AMENDABLE_DOCUMENT_TYPES, documentVersion, documentChainId, isSupersededDocument } from '@/types/documentAmendment';
import type { AmendmentAuditEvent } from '@/types/documentAmendment';
import { ORGANIZATION_ROLES, type OrganizationRole } from '@/types/roles';

const EMPTY: AmendmentPolicy = { roleGrants: [], userOverrides: [] };
const base = (role: OrganizationRole, policy: AmendmentPolicy = EMPTY) => ({
  role, userId: 'u1', membershipActive: true, subscriptionActive: true, policy,
});

/* ── The role template ────────────────────────────────────────────────────── */

describe('the default role template', () => {
  it('gives the subscriber and the organization admin every amendment permission', () => {
    for (const key of AMENDMENT_PERMISSION_KEYS) {
      expect(resolveAmendmentPermission(base('owner'), key).allowed).toBe(true);
      expect(resolveAmendmentPermission(base('admin'), key).allowed).toBe(true);
    }
  });

  it('gives nobody else anything by default — a subscription is not authorisation', () => {
    for (const role of ['manager', 'accountant', 'member', 'viewer'] as const) {
      for (const key of AMENDMENT_PERMISSION_KEYS) {
        const result = resolveAmendmentPermission(base(role), key);
        expect(result.allowed, `${role} must not hold ${key} by default`).toBe(false);
        expect(result.source).toBe('default_deny');
      }
    }
  });

  it('covers every organization role, so a new one cannot arrive ungated', () => {
    const template = amendmentRoleTemplate();
    for (const role of ORGANIZATION_ROLES) {
      expect(template[role], `${role} must have a template entry`).toBeDefined();
    }
  });

  it('maps every amendable document to a permission the catalogue actually defines', () => {
    for (const type of AMENDABLE_DOCUMENT_TYPES) {
      expect(AMENDMENT_PERMISSION_KEYS).toContain(DOCUMENT_PERMISSION[type]);
    }
    /* A supplier debit note is a bill sub-record, so it is governed by bills. */
    expect(DOCUMENT_PERMISSION['supplier-debit-note']).toBe('bills:amend');
  });
});

/* ── Precedence ───────────────────────────────────────────────────────────── */

describe('precedence', () => {
  it('lets a subscriber grant a permission to a role', () => {
    const policy: AmendmentPolicy = { roleGrants: [{ role: 'accountant', key: 'invoices:amend' }], userOverrides: [] };
    const result = resolveAmendmentPermission(base('accountant', policy), 'invoices:amend');
    expect(result.allowed).toBe(true);
    expect(result.source).toBe('role_grant');
    /* And only that permission. */
    expect(resolveAmendmentPermission(base('accountant', policy), 'bills:amend').allowed).toBe(false);
  });

  it('lets a subscriber grant a permission to one person', () => {
    const policy: AmendmentPolicy = {
      roleGrants: [],
      userOverrides: [{ userId: 'u1', key: 'bills:amend', effect: 'grant' }],
    };
    expect(resolveAmendmentPermission(base('member', policy), 'bills:amend').source).toBe('user_grant');
    /* Somebody else with the same role gains nothing. */
    expect(resolveAmendmentPermission({ ...base('member', policy), userId: 'u2' }, 'bills:amend').allowed).toBe(false);
  });

  it('lets a user deny beat a role grant', () => {
    const policy: AmendmentPolicy = {
      roleGrants: [{ role: 'manager', key: 'invoices:amend' }],
      userOverrides: [{ userId: 'u1', key: 'invoices:amend', effect: 'deny' }],
    };
    const result = resolveAmendmentPermission(base('manager', policy), 'invoices:amend');
    expect(result.allowed).toBe(false);
    expect(result.source).toBe('user_deny');
  });

  it('lets a deny beat a grant for the same person on the same permission', () => {
    const policy: AmendmentPolicy = {
      roleGrants: [],
      userOverrides: [
        { userId: 'u1', key: 'invoices:amend', effect: 'grant' },
        { userId: 'u1', key: 'invoices:amend', effect: 'deny' },
      ],
    };
    expect(resolveAmendmentPermission(base('member', policy), 'invoices:amend').allowed).toBe(false);
  });

  it('refuses before any grant is read when the membership or subscription is not active', () => {
    const policy: AmendmentPolicy = { roleGrants: [], userOverrides: [] };
    const inactive = resolveAmendmentPermission({ ...base('owner', policy), membershipActive: false }, 'invoices:amend');
    expect(inactive.allowed).toBe(false);
    expect(inactive.source).toBe('membership_inactive');

    const unsubscribed = resolveAmendmentPermission({ ...base('owner', policy), subscriptionActive: false }, 'invoices:amend');
    expect(unsubscribed.allowed).toBe(false);
    expect(unsubscribed.source).toBe('subscription_inactive');
  });

  it('never lets a platform operator amend a subscriber’s books, however the policy reads', () => {
    const generous: AmendmentPolicy = {
      roleGrants: ORGANIZATION_ROLES.flatMap((role) => AMENDMENT_PERMISSION_KEYS.map((key) => ({ role, key }))),
      userOverrides: AMENDMENT_PERMISSION_KEYS.map((key) => ({ userId: 'u1', key, effect: 'grant' as const })),
    };
    for (const key of AMENDMENT_PERMISSION_KEYS) {
      const result = resolveAmendmentPermission(
        { ...base('owner', generous), actingAsPlatformOperator: true },
        key,
      );
      expect(result.allowed).toBe(false);
      expect(result.source).toBe('platform_operator');
      expect(result.error).toMatch(/platform operator/i);
    }
  });

  it('fails closed for an unknown role and an absent policy', () => {
    expect(resolveAmendmentPermission({ role: 'stranger' as OrganizationRole }, 'invoices:amend').allowed).toBe(false);
    expect(resolveDocumentAmendmentPermission({ role: 'viewer' }, 'credit-note').allowed).toBe(false);
  });
});

describe('who may administer the policy', () => {
  it('is the owner and the organization admin, and nobody else', () => {
    expect(canAdministerAmendmentPolicy('owner')).toBe(true);
    expect(canAdministerAmendmentPolicy('admin')).toBe(true);
    for (const role of ['manager', 'accountant', 'member', 'viewer'] as const) {
      expect(canAdministerAmendmentPolicy(role)).toBe(false);
    }
  });
});

/* ── The reason ───────────────────────────────────────────────────────────── */

describe('the amendment reason', () => {
  it('refuses an empty, blank or perfunctory reason', () => {
    for (const reason of [undefined, '', '   ', 'fix', '\t\n']) {
      const result = validateAmendmentReason(reason);
      expect(result.ok, `"${String(reason)}" must be refused`).toBe(false);
      expect(result.error).toMatch(/reason is required/i);
    }
  });

  it('accepts a reason that says something', () => {
    expect(validateAmendmentReason('Quantity delivered was six, not four').ok).toBe(true);
  });
});

/* ── The amendable field allow-list ───────────────────────────────────────── */

describe('amendable fields', () => {
  it('never lets the document number, the ledger links or the settlement through', () => {
    const forbidden = [
      'invoiceNumber', 'billNumber', 'creditNoteNumber', 'journalEntryId', 'reversalJournalEntryId',
      'amountPaid', 'creditsApplied', 'balanceDue', 'payments', 'auditTrail', 'templateSnapshot',
      'amendmentVersion', 'amendmentChainId', 'supersededByDocumentId', 'status', 'entityId', 'id',
    ];
    for (const type of AMENDABLE_DOCUMENT_TYPES) {
      for (const field of forbidden) {
        expect(amendableFields(type), `${type} must not allow ${field}`).not.toContain(field);
      }
    }
  });

  it('drops everything outside the allow-list rather than refusing the request', () => {
    const clean = pickAmendableFields('invoice', {
      notes: 'legitimate',
      invoiceNumber: 'FORGED',
      journalEntryId: 'je_x',
      amountPaid: 999,
    });
    expect(clean).toEqual({ notes: 'legitimate' });
  });

  it('keeps the fields an accountant actually needs to correct', () => {
    expect(amendableFields('invoice')).toContain('lines');
    expect(amendableFields('invoice')).toContain('customerId');
    expect(amendableFields('bill')).toContain('supplierId');
    expect(amendableFields('bill')).toContain('supplierInvoiceNumber');
    expect(amendableFields('credit-note')).toContain('reasonDescription');
    expect(amendableFields('supplier-debit-note')).toContain('netAmount');
  });
});

/* ── The diff ─────────────────────────────────────────────────────────────── */

describe('the original-versus-revised comparison', () => {
  it('reports only what actually changed', () => {
    const before = { issueDate: '2026-03-05', notes: 'x', grandTotal: 100, lines: [{ description: 'A', quantity: 4, lineTotal: 100 }] };
    const after = { issueDate: '2026-03-05', notes: 'x', grandTotal: 150, lines: [{ description: 'A', quantity: 6, lineTotal: 150 }] };
    const changes = diffDocuments('invoice', before, after);
    expect(changes.map((c) => c.field).sort()).toEqual(['grandTotal', 'lines.0.lineTotal', 'lines.0.quantity']);
    expect(changes.find((c) => c.field === 'grandTotal')).toMatchObject({ before: '100.00', after: '150.00' });
  });

  it('reports an added or removed line as one change, not as a cascade', () => {
    const before = { lines: [{ description: 'A', quantity: 1, unitPrice: 10, lineTotal: 10 }] };
    const after = {
      lines: [
        { description: 'A', quantity: 1, unitPrice: 10, lineTotal: 10 },
        { description: 'B', quantity: 2, unitPrice: 5, lineTotal: 10 },
      ],
    };
    const added = diffDocuments('invoice', before, after);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ field: 'lines.1', before: 'added' });

    const removed = diffDocuments('invoice', after, before);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ field: 'lines.1', after: 'removed' });
  });

  it('shows a counterparty by name rather than by id', () => {
    const changes = diffDocuments(
      'invoice',
      { customerId: 'ent_1' },
      { customerId: 'ent_2' },
      { entityName: (id) => (id === 'ent_1' ? 'Acme Ltd' : 'Beta LLC') },
    );
    expect(changes[0]).toMatchObject({ label: 'Customer', before: 'Acme Ltd', after: 'Beta LLC' });
  });

  it('reports a sub-unit change rather than hiding it behind rounding', () => {
    const changes = diffDocuments('invoice', { grandTotal: 1250.0 }, { grandTotal: 1250.01 });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.before).not.toBe(changes[0]!.after);
  });
});

/* ── A refusal always says something ──────────────────────────────────────── */

describe('the refusal reason', () => {
  const impact = {
    settlement: { grandTotal: 0, amountSettled: 0, balanceDue: 0, transferable: [], blocked: [] },
    inventory: { documentIds: [], movementCount: 0, reversible: true },
    tax: {},
  };
  const assess = (findings: Parameters<typeof assessDocumentAmendment>[0]['findings']) =>
    assessDocumentAmendment({
      documentType: 'invoice', documentId: 'inv_1', documentNumber: 'INV-0001',
      documentDate: '2026-03-05', version: 1, findings, impact,
    });

  it('is never blank when the action is refused, even if a blocker forgets its message', () => {
    const assessment = assess([
      { kind: 'permission', severity: 'blocks', sourceLabel: 'owner', message: '' },
    ]);
    expect(assessment.eligible).toBe(false);
    expect(assessment.reason.trim().length).toBeGreaterThan(0);
    /* Specific to the kind, not a shrug. */
    expect(assessment.reason).toMatch(/permission/i);
  });

  it('falls back specifically for every blocker kind, and leaks no record data', () => {
    const kinds = [
      'not_posted', 'not_current', 'locked_period', 'filed_tax_return', 'external_einvoice',
      'reconciled_settlement', 'non_transferable_allocation', 'inventory_dependency',
      'server_backend', 'permission', 'subscription', 'indeterminate',
    ] as const;
    for (const kind of kinds) {
      const assessment = assess([
        { kind, severity: 'blocks', sourceLabel: 'INV-0001', message: '   ' },
      ]);
      const reason = assessment.reason;
      expect(reason.trim().length, `${kind} must produce a reason`).toBeGreaterThan(0);
      /* A safe diagnostic names the rule, never the document or the party. */
      expect(reason, `${kind} must not leak the document number`).not.toContain('INV-0001');
    }
  });

  it('keeps a real message when the blocker has one', () => {
    const assessment = assess([
      { kind: 'locked_period', severity: 'blocks', sourceLabel: 'Tax period', message: 'March 2026 is locked.' },
    ]);
    expect(assessment.reason).toBe('March 2026 is locked.');
  });

  it('says something usable even for a blocker kind nobody anticipated', () => {
    const assessment = assess([
      { kind: 'some_future_rule' as never, severity: 'blocks', sourceLabel: 'x', message: '' },
    ]);
    expect(assessment.reason).toMatch(/some_future_rule/);
    expect(assessment.reason).toMatch(/support/i);
  });
});

/* ── The version chain ────────────────────────────────────────────────────── */

describe('version helpers', () => {
  it('reads a record with no amendment metadata as version 1 of its own chain', () => {
    expect(documentVersion(undefined)).toBe(1);
    expect(documentVersion({})).toBe(1);
    expect(documentChainId({ id: 'inv_1' })).toBe('inv_1');
    expect(isSupersededDocument({})).toBe(false);
  });

  it('orders a chain by version rather than by array position', () => {
    const member = (version: number, id: string) => ({
      id, number: `INV-${version}`, version, status: 'issued', date: '2026-01-01', total: 0, current: false,
    });
    const ordered = orderChain([member(3, 'c'), member(1, 'a'), member(2, 'b')]);
    expect(ordered.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

/* ── The audit chain ──────────────────────────────────────────────────────── */

function event(partial: Partial<AmendmentAuditEvent>): Omit<AmendmentAuditEvent, 'checksum'> {
  return {
    id: 'amd_1',
    sequence: 1,
    at: '2026-03-10T10:00:00.000Z',
    organizationId: 'org',
    companyId: 'co',
    documentType: 'invoice',
    documentId: 'inv_1',
    documentNumber: 'INV-0001',
    originalVersion: 1,
    documentDate: '2026-03-05',
    actorName: 'Owner',
    actorRole: 'owner',
    actedAsPlatformOperator: false,
    reason: 'Wrong quantity',
    changes: [],
    settlementEffect: [],
    inventoryEffect: { reversedDocumentIds: [], replacementDocumentIds: [], movementCount: 0 },
    taxStatus: {},
    outcome: 'succeeded',
    correlationId: 'corr-1',
    previousChecksum: '',
    ...partial,
  };
}

describe('the amendment audit chain', () => {
  it('verifies a well-formed chain', () => {
    const first = sealEvent(event({}));
    const second = sealEvent(event({ id: 'amd_2', sequence: 2, previousChecksum: first.checksum }));
    expect(verifyAmendmentChain([first, second]).ok).toBe(true);
    expect(verifyAmendmentChain([]).ok).toBe(true);
  });

  it('detects an altered event, and names the one that broke', () => {
    const first = sealEvent(event({}));
    const second = sealEvent(event({ id: 'amd_2', sequence: 2, previousChecksum: first.checksum }));
    const tampered = { ...first, reason: 'something else' };
    const result = verifyAmendmentChain([tampered, second]);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.message).toMatch(/altered/i);
  });

  it('detects a removed event', () => {
    const first = sealEvent(event({}));
    const second = sealEvent(event({ id: 'amd_2', sequence: 2, previousChecksum: first.checksum }));
    const third = sealEvent(event({ id: 'amd_3', sequence: 3, previousChecksum: second.checksum }));
    const result = verifyAmendmentChain([first, third]);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
    expect(result.message).toMatch(/missing|does not follow/i);
  });

  it('detects reordering', () => {
    const first = sealEvent(event({}));
    const second = sealEvent(event({ id: 'amd_2', sequence: 2, previousChecksum: first.checksum }));
    expect(verifyAmendmentChain([second, first]).ok).toBe(false);
  });

  it('digests the same content identically however the object was built', () => {
    const a = canonicalise(event({ reason: 'A', changes: [{ field: 'f', label: 'F', before: '1', after: '2' }] }));
    const rebuilt = event({});
    const b = canonicalise({
      ...rebuilt,
      changes: [{ after: '2', before: '1', label: 'F', field: 'f' }],
      reason: 'A',
    });
    expect(a).toBe(b);
  });

  it('separates content that differs by one character', () => {
    expect(checksum('1250.00')).not.toBe(checksum('1250.01'));
    expect(checksum('')).toBe(checksum(''));
  });

  it('states its own limitation rather than leaving it to be assumed', () => {
    expect(AMENDMENT_AUDIT_LIMITATION).toMatch(/not a server-side audit log/i);
    expect(AMENDMENT_AUDIT_LIMITATION).toMatch(/browser/i);
  });
});
