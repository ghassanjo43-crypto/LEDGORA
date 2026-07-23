/**
 * Universal Journal Voucher — role-based permissions, following the existing
 * organization role model. Client-side checks are a UX affordance layered on
 * the same rules a production backend must enforce server-side; they are never
 * the sole security boundary.
 */
import type { OrganizationRole } from '@/types/roles';

export type JournalVoucherPermission =
  | 'journalVoucher.view'
  | 'journalVoucher.create'
  | 'journalVoucher.editDraft'
  | 'journalVoucher.submit'
  | 'journalVoucher.review'
  | 'journalVoucher.approve'
  | 'journalVoucher.post'
  | 'journalVoucher.reverse'
  | 'journalVoucher.correct'
  | 'journalVoucher.cancelDraft'
  | 'journalVoucher.viewAttachments'
  | 'journalVoucher.manageTemplates'
  | 'journalVoucher.postOpeningBalance'
  | 'journalVoucher.postIntercompany'
  | 'journalVoucher.postTaxAdjustment'
  | 'journalVoucher.configureTypes';

const ALL: JournalVoucherPermission[] = [
  'journalVoucher.view', 'journalVoucher.create', 'journalVoucher.editDraft',
  'journalVoucher.submit', 'journalVoucher.review', 'journalVoucher.approve',
  'journalVoucher.post', 'journalVoucher.reverse', 'journalVoucher.correct',
  'journalVoucher.cancelDraft', 'journalVoucher.viewAttachments',
  'journalVoucher.manageTemplates', 'journalVoucher.postOpeningBalance',
  'journalVoucher.postIntercompany', 'journalVoucher.postTaxAdjustment',
  'journalVoucher.configureTypes',
];

const ROLE_GRANTS: Record<OrganizationRole, JournalVoucherPermission[]> = {
  owner: ALL,
  admin: ALL,
  // Accountants run the day-to-day but do not approve, configure types, or
  // post the specially-controlled voucher classes.
  accountant: [
    'journalVoucher.view', 'journalVoucher.create', 'journalVoucher.editDraft',
    'journalVoucher.submit', 'journalVoucher.review', 'journalVoucher.post',
    'journalVoucher.reverse', 'journalVoucher.correct', 'journalVoucher.cancelDraft',
    'journalVoucher.viewAttachments', 'journalVoucher.manageTemplates',
    'journalVoucher.postTaxAdjustment',
  ],
  member: ['journalVoucher.view', 'journalVoucher.create', 'journalVoucher.editDraft', 'journalVoucher.submit', 'journalVoucher.cancelDraft', 'journalVoucher.viewAttachments'],
  viewer: ['journalVoucher.view', 'journalVoucher.viewAttachments'],
};

export function roleHasJvPermission(role: OrganizationRole, permission: JournalVoucherPermission): boolean {
  return (ROLE_GRANTS[role] ?? []).includes(permission);
}

export interface JvPermissionResult {
  ok: boolean;
  error?: string;
}

export function assertJvPermission(role: OrganizationRole, permission: JournalVoucherPermission): JvPermissionResult {
  return roleHasJvPermission(role, permission)
    ? { ok: true }
    : { ok: false, error: `Your role (${role}) does not include the "${permission}" permission.` };
}
