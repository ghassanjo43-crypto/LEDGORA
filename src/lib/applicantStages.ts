/**
 * Applicant funnel presentation — labels, tones and tab definitions.
 *
 * Kept out of the component so the mapping from a backend stage to what the
 * operator reads is plain data that can be asserted directly in a test. The
 * stage strings are the backend's, verbatim; nothing here invents a state.
 */
import type { Applicant, ApplicantStage } from '@/services/api/authApi';
import type { BadgeTone } from '@/data/ifrsOptions';

/** The stage vocabulary, in funnel order. */
export const APPLICANT_STAGE_LABELS: Record<ApplicantStage, string> = {
  registered_no_package: 'Registered — no package',
  package_selected: 'Package selected',
  awaiting_payment: 'Awaiting payment',
  pending_verification: 'Pending verification',
  active_subscriber: 'Active subscriber',
  dormant_applicant: 'Dormant',
  suspended: 'Suspended',
  archived: 'Archived',
};

export const APPLICANT_STAGE_TONES: Record<ApplicantStage, BadgeTone> = {
  registered_no_package: 'slate',
  package_selected: 'blue',
  awaiting_payment: 'amber',
  pending_verification: 'violet',
  active_subscriber: 'green',
  dormant_applicant: 'slate',
  suspended: 'red',
  archived: 'slate',
};

export function stageLabel(stage: string): string {
  return APPLICANT_STAGE_LABELS[stage as ApplicantStage] ?? stage;
}

export function stageTone(stage: string): BadgeTone {
  return APPLICANT_STAGE_TONES[stage as ApplicantStage] ?? 'slate';
}

export type ApplicantTabId = 'all' | ApplicantStage;

export interface ApplicantTabDefinition {
  id: ApplicantTabId;
  label: string;
  /** Key in the API's `stageCounts` map; `all` counts the whole population. */
  countKey: string;
}

/**
 * The tabs the console shows. "All applicants" is first and deliberately
 * unfiltered — the whole point of the fix is that nobody is missing from it.
 */
export const APPLICANT_TABS: ApplicantTabDefinition[] = [
  { id: 'all', label: 'All applicants', countKey: 'all' },
  { id: 'registered_no_package', label: 'Package not selected', countKey: 'registered_no_package' },
  { id: 'awaiting_payment', label: 'Awaiting payment', countKey: 'awaiting_payment' },
  { id: 'pending_verification', label: 'Pending verification', countKey: 'pending_verification' },
  { id: 'active_subscriber', label: 'Active subscribers', countKey: 'active_subscriber' },
  { id: 'dormant_applicant', label: 'Dormant', countKey: 'dormant_applicant' },
];

/** What the "Package" column shows. Never blank, never guessed. */
export function packageLabel(applicant: Pick<Applicant, 'planName' | 'planCode'>): string {
  return applicant.planName ?? applicant.planCode ?? 'Not selected';
}

/** What the "Organization" column shows for an applicant who has not onboarded. */
export function organizationLabel(applicant: Pick<Applicant, 'organizationName'>): string {
  return applicant.organizationName ?? 'No organization yet';
}

export type ApplicantAction = 'remind' | 'review-proof' | 'activate' | 'suspend' | 'restore' | 'archive';

/**
 * The actions that actually apply to this applicant, given where they are.
 *
 * Offering an action that cannot work is worse than not offering it: the
 * operator learns to distrust the console. A reminder only makes sense before a
 * package is chosen; proof review only once a receipt exists; activation only
 * once there is a subscription to activate.
 */
export function availableActions(applicant: Applicant): ApplicantAction[] {
  const actions: ApplicantAction[] = [];

  if (applicant.funnelStage === 'registered_no_package' && applicant.stage !== 'archived') {
    actions.push('remind');
  }
  if (applicant.proofId && applicant.proofStatus === 'submitted') actions.push('review-proof');
  if (applicant.subscriptionId && applicant.funnelStage !== 'active_subscriber') actions.push('activate');

  if (applicant.stage === 'suspended' || applicant.stage === 'archived') actions.push('restore');
  else actions.push('suspend', 'archive');

  return actions;
}
