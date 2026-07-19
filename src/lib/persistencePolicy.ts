/**
 * The single persistence policy for business (accounting) data.
 *
 * Every accounting store routes its durable writes through the storage adapter
 * this policy selects, so "free demo data is never persisted" is enforced in one
 * place instead of being re-checked by each page or Save button.
 *
 *  | Account status      | Permanent saving                       |
 *  | ------------------- | -------------------------------------- |
 *  | anonymous           | No                                     |
 *  | registered-no-plan  | No                                     |
 *  | free-demo           | No                                     |
 *  | trial               | Yes, when the trial permits storage    |
 *  | subscribed          | Yes                                    |
 *  | past-due            | Existing grace-period rules            |
 *  | suspended           | No new permanent writes                |
 */
import type { AccountStatus, PersistencePolicy } from '@/types/session';

const MEMORY_ONLY: PersistencePolicy = { canPersistBusinessData: false, storageMode: 'memory' };
const DURABLE: PersistencePolicy = { canPersistBusinessData: true, storageMode: 'backend' };

export interface PersistencePolicyInput {
  accountStatus: AccountStatus;
  /** Whether the trial plan includes durable storage (trials may be read-only). */
  trialAllowsStorage?: boolean;
  /**
   * Whether a `past-due` subscription is still inside the billing grace period.
   * Supplied by the existing billing lifecycle — this module does not re-derive
   * grace rules, it only consumes the answer.
   */
  inGracePeriod?: boolean;
}

export function resolvePersistencePolicy(input: PersistencePolicyInput): PersistencePolicy {
  switch (input.accountStatus) {
    case 'anonymous':
    case 'registered-no-plan':
    case 'free-demo':
      return MEMORY_ONLY;
    case 'trial':
      return input.trialAllowsStorage === false ? MEMORY_ONLY : DURABLE;
    case 'subscribed':
      return DURABLE;
    case 'past-due':
      // Grace period keeps the books writable; past grace, no new permanent writes.
      return input.inGracePeriod === false ? MEMORY_ONLY : DURABLE;
    case 'suspended':
      return MEMORY_ONLY;
    default:
      return MEMORY_ONLY;
  }
}

/** Convenience: does this status permit permanent business-data writes? */
export function canPersistFor(status: AccountStatus): boolean {
  return resolvePersistencePolicy({ accountStatus: status }).canPersistBusinessData;
}
