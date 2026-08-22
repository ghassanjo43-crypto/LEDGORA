import type { AccountRecord } from './accountService.js';

export type PostingAccountReason = 'inactive' | 'blocked' | 'archived' | 'not-postable' | 'has-children';
export interface PostingAccountAssessment { eligible: boolean; reason?: PostingAccountReason; message?: string }

/** Server-authoritative universal eligibility rule for every new ordinary posting. */
export function assessPostingAccount(account: AccountRecord, hasChildren = false): PostingAccountAssessment {
  if (account.archived) return { eligible: false, reason: 'archived', message: 'This account is archived and cannot receive new postings.' };
  if (account.blocked) return { eligible: false, reason: 'blocked', message: 'This account is blocked and cannot receive new postings.' };
  if (!account.active) return { eligible: false, reason: 'inactive', message: 'Select an active posting account. This account is inactive.' };
  if (!account.isPostable) return { eligible: false, reason: 'not-postable', message: 'Select a posting account. Parent accounts cannot receive transactions.' };
  if (hasChildren) return { eligible: false, reason: 'has-children', message: 'Select a posting account. Parent accounts cannot receive transactions.' };
  return { eligible: true };
}
