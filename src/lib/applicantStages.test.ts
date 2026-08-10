/**
 * Applicant stage presentation.
 *
 * These assertions are about honesty: an applicant with no package must read as
 * "Not selected", never as a blank cell or an inferred plan, and the console
 * must not offer an action that cannot succeed for the stage the person is in.
 */
import { describe, it, expect } from 'vitest';
import {
  APPLICANT_TABS,
  APPLICANT_STAGE_LABELS,
  availableActions,
  organizationLabel,
  packageLabel,
  stageLabel,
  stageTone,
} from './applicantStages';
import type { Applicant } from '@/services/api/authApi';

const applicant = (over: Partial<Applicant> = {}): Applicant =>
  ({
    userId: 'u1',
    applicationId: 'a1',
    fullName: 'Priya Prospect',
    email: 'priya@new.test',
    accountStatus: 'active',
    emailVerified: true,
    registeredAt: '2026-07-20T00:00:00.000Z',
    lastLoginAt: null,
    lastActivityAt: '2026-07-20T00:00:00.000Z',
    stage: 'registered_no_package',
    funnelStage: 'registered_no_package',
    dormant: false,
    source: 'self_registration',
    organizationId: null,
    organizationName: null,
    organizationCountry: null,
    planId: null,
    planCode: null,
    planName: null,
    planCurrency: null,
    planMonthlyPrice: null,
    subscriptionId: null,
    subscriptionStatus: null,
    billingCycle: null,
    subscriptionExpiresAt: null,
    invoiceId: null,
    invoiceNumber: null,
    invoiceStatus: null,
    invoiceTotal: null,
    paymentReference: null,
    proofId: null,
    proofStatus: null,
    packageSelectedAt: null,
    paymentStartedAt: null,
    proofUploadedAt: null,
    activatedAt: null,
    ...over,
  }) as Applicant;

describe('stage vocabulary', () => {
  it('names the registration-only stage explicitly', () => {
    expect(stageLabel('registered_no_package')).toBe('Registered — no package');
    expect(stageTone('registered_no_package')).toBe('slate');
  });

  it('covers every stage the backend can return', () => {
    for (const stage of [
      'registered_no_package',
      'package_selected',
      'awaiting_payment',
      'pending_verification',
      'active_subscriber',
      'dormant_applicant',
      'suspended',
      'archived',
    ] as const) {
      expect(APPLICANT_STAGE_LABELS[stage]).toBeTruthy();
    }
  });

  it('passes an unrecognised stage through rather than hiding it', () => {
    expect(stageLabel('something_new')).toBe('something_new');
    expect(stageTone('something_new')).toBe('slate');
  });
});

describe('column labels', () => {
  it('reads "Not selected" when no package has been chosen', () => {
    expect(packageLabel(applicant())).toBe('Not selected');
  });

  it('prefers the plan name, falling back to its code', () => {
    expect(packageLabel(applicant({ planName: 'Core', planCode: 'core' }))).toBe('Core');
    expect(packageLabel(applicant({ planName: null, planCode: 'core' }))).toBe('core');
  });

  it('says an applicant has no organization rather than leaving it blank', () => {
    expect(organizationLabel(applicant())).toBe('No organization yet');
    expect(organizationLabel(applicant({ organizationName: 'Acme Ltd' }))).toBe('Acme Ltd');
  });
});

describe('the tab set', () => {
  it('leads with an unfiltered "All applicants" tab', () => {
    expect(APPLICANT_TABS[0]).toMatchObject({ id: 'all', countKey: 'all' });
  });

  it('covers each stage the business lifecycle names', () => {
    const ids = APPLICANT_TABS.map((t) => t.id);
    expect(ids).toEqual([
      'all',
      'registered_no_package',
      'awaiting_payment',
      'pending_verification',
      'active_subscriber',
      'dormant_applicant',
    ]);
  });
});

describe('available actions', () => {
  it('offers a reminder only before a package is chosen', () => {
    expect(availableActions(applicant())).toContain('remind');
    expect(availableActions(applicant({ funnelStage: 'package_selected' }))).not.toContain('remind');
  });

  it('offers proof review only when a receipt is awaiting one', () => {
    expect(availableActions(applicant())).not.toContain('review-proof');
    expect(availableActions(applicant({ proofId: 'p1', proofStatus: 'submitted' }))).toContain('review-proof');
    expect(availableActions(applicant({ proofId: 'p1', proofStatus: 'approved' }))).not.toContain('review-proof');
  });

  it('offers activation only when there is a subscription that is not already active', () => {
    expect(availableActions(applicant())).not.toContain('activate');
    expect(availableActions(applicant({ subscriptionId: 's1', funnelStage: 'awaiting_payment' }))).toContain('activate');
    expect(
      availableActions(applicant({ subscriptionId: 's1', funnelStage: 'active_subscriber', stage: 'active_subscriber' })),
    ).not.toContain('activate');
  });

  it('offers restore instead of suspend once the applicant is closed', () => {
    const suspended = availableActions(applicant({ stage: 'suspended' }));
    expect(suspended).toContain('restore');
    expect(suspended).not.toContain('suspend');
    expect(suspended).not.toContain('archive');
  });
});
